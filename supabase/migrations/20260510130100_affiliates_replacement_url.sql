-- ============================================
-- Migration: affiliate health tracking columns
-- ============================================
-- Backs scripts/affiliate-expired-detector.js. The detector runs
-- weekly, checks every affiliate URL is still alive, and either
-- marks it expired or auto-swaps to replacement_url when present.
--
-- Columns:
--   replacement_url   Pre-configured fallback if base_url breaks.
--                     Editor sets this manually for high-risk affiliates.
--   last_checked_at   When the detector last verified this URL.
--   last_status_code  HTTP status from the last HEAD request.
--   redirect_target   Final URL after following redirects (null if no
--                     redirect or unchanged). Used to spot domain
--                     hijacks where a redirect points elsewhere.
-- ============================================

ALTER TABLE affiliates
    ADD COLUMN IF NOT EXISTS replacement_url   TEXT,
    ADD COLUMN IF NOT EXISTS last_checked_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_status_code  INT,
    ADD COLUMN IF NOT EXISTS redirect_target   TEXT;

-- Index to surface "needs check" cheaply: never checked, or checked >7 days ago.
CREATE INDEX IF NOT EXISTS idx_affiliates_needs_check
    ON affiliates(last_checked_at NULLS FIRST)
    WHERE status IN ('active', 'pending');
