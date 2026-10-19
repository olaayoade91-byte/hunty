import { huntReportBodySchema } from "@hunty/types/api-schemas";
import { NextResponse } from "next/server";
import { z } from "zod";

import { NotFoundError, RateLimitError, ValidationError } from "@/lib/api/errors";
import { withErrorHandling } from "@/lib/api/withErrorHandling";
import { withValidation } from "@/lib/api/withValidation";
import { getDb } from "@/lib/db";
import { submitHuntForModeration } from "@/lib/moderation/dbStore";
import { getIP, rateLimit, rateLimitPresets, rateLimitResponse } from "@/lib/rate-limit";
import type { StoredHunt } from "@/lib/types";

const paramsSchema = z.object({ id: z.string() });

const REPORT_ESCALATION_THRESHOLD = 3;

interface HuntReportRow {
  id: string;
  hunt_id: number;
  reporter_wallet: string;
  reason: string;
  details: string | null;
  status: string;
  created_at: Date;
  reviewed_at: Date | null;
  reviewed_by: string | null;
}

async function insertHuntReport(
  huntId: number,
  reporterWallet: string,
  reason: string,
  details: string | null
): Promise<HuntReportRow> {
  const sql = getDb();
  const id = crypto.randomUUID();
  const rows = await sql<HuntReportRow[]>`
    INSERT INTO hunt_reports (id, hunt_id, reporter_wallet, reason, details, status)
    VALUES (${id}, ${huntId}, ${reporterWallet}, ${reason}, ${details}, 'pending')
    ON CONFLICT (hunt_id, reporter_wallet) DO UPDATE SET
      reason = EXCLUDED.reason,
      details = EXCLUDED.details,
      status = 'pending',
      created_at = NOW()
    RETURNING *
  `;
  return rows[0];
}

async function getReportCountForHunt(huntId: number): Promise<number> {
  const sql = getDb();
  const rows = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int as count FROM hunt_reports WHERE hunt_id = ${huntId}
  `;
  return rows[0]?.count ?? 0;
}

async function escalateHuntToModeration(huntId: number): Promise<void> {
  const sql = getDb();
  const huntRows = await sql<
    {
      id: number;
      title: string;
      description: string;
      rewardPool: number;
      creatorEmail: string | null;
    }[]
  >`
    SELECT id, title, description, reward_pool, creator_email FROM hunts WHERE id = ${huntId}
  `;
  if (huntRows.length === 0) return;

  const hunt = huntRows[0];
  const storedHunt: StoredHunt = {
    id: hunt.id,
    title: hunt.title,
    description: hunt.description ?? "",
    rewardPool: hunt.reward_pool ?? 0,
    creatorEmail: hunt.creatorEmail ?? undefined,
    creator: "",
    status: "Active",
    cluesCount: 0,
    is_private: false,
    playerCount: 0,
  };

  await submitHuntForModeration(storedHunt, "auto-escalation");

  await sql`
    UPDATE hunt_reports SET status = 'escalated' WHERE hunt_id = ${huntId} AND status = 'pending'
  `;
}

export const POST = withErrorHandling(
  withValidation(
    { body: huntReportBodySchema, params: paramsSchema },
    async (req, _context, { body, params }) => {
      const ip = getIP(req);

      const ipResult = await rateLimit(`report_ip:${ip}`, rateLimitPresets.sensitive);
      if (!ipResult.success) {
        return rateLimitResponse(ipResult.reset);
      }

      const huntId = parseInt(params!.id, 10);
      if (isNaN(huntId)) {
        throw new ValidationError("Invalid hunt ID", { id: params!.id });
      }

      const { reason, details, reporterWallet } = body!;

      const walletResult = await rateLimit(
        `report_wallet:${reporterWallet}`,
        rateLimitPresets.sensitive
      );
      if (!walletResult.success) {
        throw new RateLimitError("Too many reports from this wallet", {
          reset: walletResult.reset,
          remaining: walletResult.remaining,
        });
      }

      const sql = getDb();
      const huntRows = await sql<{ id: number }[]>`
        SELECT id FROM hunts WHERE id = ${huntId}
      `;
      if (huntRows.length === 0) {
        throw new NotFoundError("Hunt not found", { huntId });
      }

      const report = await insertHuntReport(huntId, reporterWallet, reason, details ?? null);

      const reportCount = await getReportCountForHunt(huntId);

      if (reportCount >= REPORT_ESCALATION_THRESHOLD) {
        await escalateHuntToModeration(huntId);
      }

      return NextResponse.json({
        success: true,
        report: {
          id: report.id,
          huntId: report.hunt_id,
          reason: report.reason,
          status: report.status,
          createdAt: report.created_at.toISOString(),
        },
        reportCount,
        escalated: reportCount >= REPORT_ESCALATION_THRESHOLD,
      });
    }
  )
);
