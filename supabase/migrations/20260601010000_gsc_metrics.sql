-- Migration: Search Console metrics on articles
-- Required by: scripts/gsc-ctr-report.js (data-driven CTR prioritization)
-- Lets refresh-titles.js order by gsc_impressions desc (fix highest-opportunity
-- titles first). Applied 2026-06-01 via Supabase MCP execute_sql.

ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS gsc_impressions INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gsc_clicks INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gsc_ctr NUMERIC(6,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gsc_position NUMERIC(6,2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gsc_updated_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN public.articles.gsc_impressions IS
  'Search Console impressions (last 28d) — populated by gsc-ctr-report.js. High impressions + low CTR = biggest title/meta opportunity.';
