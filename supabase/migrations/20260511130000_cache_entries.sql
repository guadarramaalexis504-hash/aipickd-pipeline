-- ============================================
-- Migration: TTL-based cache table
-- ============================================
-- Backs scripts/lib/cache.js. Used to memoize results of expensive
-- computations or external API calls that don't change often (e.g.
-- "list of niches", "current month's published slugs").
--
-- The cache is intentionally simple: key/value/expires_at, no LRU,
-- no namespacing. Callers prefix their keys with `<scope>:` if they
-- need separation.
--
-- Cleanup: a daily cron prunes expired rows. Until then, lookups skip
-- expired entries via WHERE expires_at > NOW().
-- ============================================

CREATE TABLE IF NOT EXISTS cache_entries (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cheap "is anything expired?" query for the cleanup job.
CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at
    ON cache_entries(expires_at);
