-- Migration: create hunt_reports table for player abuse reports.
--
-- Allows players to report hunts for abuse. Reports enter the moderation
-- queue and repeat reports trigger automatic escalation.

CREATE TABLE IF NOT EXISTS hunt_reports (
  id                TEXT        PRIMARY KEY,
  hunt_id           INTEGER     NOT NULL,
  reporter_wallet   TEXT        NOT NULL,
  reason            TEXT        NOT NULL,
  details           TEXT,
  status            TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','reviewed','escalated','dismissed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at       TIMESTAMPTZ,
  reviewed_by       TEXT
);

-- Index for looking up reports by hunt
CREATE INDEX IF NOT EXISTS idx_hunt_reports_hunt_id
  ON hunt_reports (hunt_id);

-- Index for looking up reports by reporter (rate limiting / duplicate prevention)
CREATE INDEX IF NOT EXISTS idx_hunt_reports_reporter_wallet
  ON hunt_reports (reporter_wallet);

-- Index for status queries
CREATE INDEX IF NOT EXISTS idx_hunt_reports_status
  ON hunt_reports (status);

-- Unique constraint to prevent duplicate reports from same wallet for same hunt
CREATE UNIQUE INDEX IF NOT EXISTS uq_hunt_reports_hunt_reporter
  ON hunt_reports (hunt_id, reporter_wallet);