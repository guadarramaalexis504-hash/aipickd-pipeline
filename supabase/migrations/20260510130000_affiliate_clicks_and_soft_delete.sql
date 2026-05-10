-- ============================================
-- Migration: extend affiliate_clicks for first-party tracking + soft delete on articles
-- ============================================
-- 1. affiliate_clicks (already exists from initial schema)
--    Add UTM/geo/device columns + indexes for the click-attribution
--    queries the daily-report will run. Reuses click_timestamp instead
--    of introducing a parallel clicked_at column.
--
--    GDPR note: ip_hash is sha256(ip + daily_salt), not the raw IP.
--    The salt rotates daily so the hash is useful for ~24h dedup but
--    can't be reversed.
--
-- 2. articles.deleted_at + view articles_active
--    Soft-delete instead of DELETE. Useful when a moderation script
--    flags an article and we want to restore it later. Existing queries
--    are unaffected; new code can opt into reading from articles_active
--    to exclude soft-deletes automatically.
-- ============================================

-- ── 1. Extend affiliate_clicks ───────────────
ALTER TABLE affiliate_clicks
    ADD COLUMN IF NOT EXISTS utm_source    TEXT,
    ADD COLUMN IF NOT EXISTS utm_medium    TEXT,
    ADD COLUMN IF NOT EXISTS utm_campaign  TEXT,
    ADD COLUMN IF NOT EXISTS country       TEXT,    -- 2-letter ISO
    ADD COLUMN IF NOT EXISTS device_type   TEXT;    -- 'mobile' | 'desktop' | 'tablet' | 'bot'

-- Compound index for the "recent clicks for article X" query, which is
-- the common shape for the per-article performance breakdown.
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_article_ts
    ON affiliate_clicks(article_id, click_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_affiliate_ts
    ON affiliate_clicks(affiliate_id, click_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_utm_source
    ON affiliate_clicks(utm_source)
    WHERE utm_source IS NOT NULL;

-- ── 2. Soft delete on articles ───────────────
ALTER TABLE articles
    ADD COLUMN IF NOT EXISTS deleted_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_articles_deleted_at
    ON articles(deleted_at)
    WHERE deleted_at IS NOT NULL;

-- View: every place that should ignore soft-deletes can SELECT * FROM articles_active.
CREATE OR REPLACE VIEW articles_active AS
    SELECT * FROM articles WHERE deleted_at IS NULL;
