-- Migration: Add schema_updated_at column to articles table
-- Required by: scripts/add-schema-markup.js (gradual self-healing schema backfill)
-- Lets the cron cycle through ALL articles (least-recently-stamped first) instead
-- of re-doing the newest N each run.
-- Applied 2026-06-01 via Supabase MCP execute_sql.

ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS schema_updated_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS articles_schema_updated_at_idx
  ON public.articles (schema_updated_at ASC NULLS FIRST, published_at DESC)
  WHERE wp_post_id IS NOT NULL AND status = 'published';

COMMENT ON COLUMN public.articles.schema_updated_at IS
  'When add-schema-markup.js last (re)injected JSON-LD; used to cycle the gradual self-healing backfill through all articles.';
