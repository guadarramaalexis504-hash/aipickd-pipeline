-- ============================================
-- Migration: dead-letter queue + article idempotency
-- ============================================
-- Two related resilience improvements:
--
-- 1. failed_keywords table
--    Keywords that exhausted their retry budget (attempts >= 3 from the
--    previous migration) get archived here for human review. The
--    daily-report can surface this table size as a health metric.
--
-- 2. articles.idempotency_key
--    A deterministic hash (sha256(slug + UTC day + body) → see
--    scripts/lib/idempotency.js) that lets the publisher detect
--    "this exact article was already published today" before issuing
--    a duplicate POST to WordPress. Eliminates a class of dup bugs
--    that occur when a network blip leaves Supabase and WP out of sync.
-- ============================================

-- ── 1. Dead-letter queue for keywords ──────────
CREATE TABLE IF NOT EXISTS failed_keywords (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    keyword         TEXT NOT NULL,
    niche_id        UUID REFERENCES niches(id),
    original_id     UUID,                         -- original keywords.id (may be deleted)
    attempts        INT NOT NULL,
    last_error      TEXT,
    last_error_at   TIMESTAMPTZ,
    archived_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    triaged         BOOLEAN NOT NULL DEFAULT FALSE,
    triage_note     TEXT
);

CREATE INDEX IF NOT EXISTS idx_failed_keywords_archived_at
    ON failed_keywords(archived_at DESC);

CREATE INDEX IF NOT EXISTS idx_failed_keywords_untriaged
    ON failed_keywords(archived_at DESC)
    WHERE triaged = FALSE;

-- ── 2. Idempotency key on articles ─────────────
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Partial unique index — NULL keys (legacy rows) are allowed unlimited
-- duplicates, but new rows with a key cannot collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_articles_idempotency_key
    ON articles(idempotency_key)
    WHERE idempotency_key IS NOT NULL;
