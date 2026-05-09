-- ============================================
-- Migration: keywords retry tracking
-- ============================================
-- Adds attempt counter + last error metadata to the keywords queue so
-- transient generation failures (OpenAI 5xx, Supabase timeouts) can be
-- retried automatically up to 3 times before being marked failed.
--
-- Used by run-pipeline.js when a generation throws — increments
-- `attempts` and stores the error. The partial index makes the queue
-- query (`status = 'queued' AND attempts < 3`) cheap.
-- ============================================

ALTER TABLE keywords
    ADD COLUMN IF NOT EXISTS attempts        INT         NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_error_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_error      TEXT;

-- Cheap retrieval of "keywords ready to work" — the most frequent query
-- in the pipeline. Skips exhausted retries automatically.
CREATE INDEX IF NOT EXISTS idx_keywords_queue_ready
    ON keywords(priority DESC, discovered_at ASC)
    WHERE status = 'queued' AND attempts < 3;

-- Track exhausted keywords separately so the daily report can surface
-- them for human review.
CREATE INDEX IF NOT EXISTS idx_keywords_failed
    ON keywords(last_error_at DESC)
    WHERE attempts >= 3;
