-- Migration: detailed Google Search Console metrics
-- Required by: scripts/gsc-ctr-report.js
-- Keeps import audit rows and page/query/device/date metrics while articles.gsc_*
-- stores the latest per-article summary used for CTR prioritization.

ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS gsc_impressions INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gsc_clicks INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gsc_ctr NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gsc_position NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gsc_updated_at TIMESTAMPTZ DEFAULT NULL;

CREATE TABLE IF NOT EXISTS public.gsc_import_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_url TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  dimensions TEXT[] NOT NULL DEFAULT ARRAY['page', 'query', 'device', 'date'],
  search_type TEXT NOT NULL DEFAULT 'web',
  rows_fetched INTEGER NOT NULL DEFAULT 0 CHECK (rows_fetched >= 0),
  rows_matched INTEGER NOT NULL DEFAULT 0 CHECK (rows_matched >= 0),
  rows_unmatched INTEGER NOT NULL DEFAULT 0 CHECK (rows_unmatched >= 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.gsc_query_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_run_id UUID NOT NULL REFERENCES public.gsc_import_runs(id) ON DELETE CASCADE,
  article_id UUID REFERENCES public.articles(id) ON DELETE SET NULL,
  page_url TEXT NOT NULL,
  normalized_page_url TEXT NOT NULL,
  query TEXT NOT NULL,
  device TEXT NOT NULL,
  country TEXT,
  row_date DATE,
  search_type TEXT NOT NULL DEFAULT 'web',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  ctr NUMERIC NOT NULL DEFAULT 0 CHECK (ctr >= 0 AND ctr <= 1),
  position NUMERIC NOT NULL DEFAULT 0 CHECK (position >= 0),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gsc_query_metrics_article_idx
  ON public.gsc_query_metrics(article_id, imported_at DESC);

CREATE INDEX IF NOT EXISTS gsc_query_metrics_page_query_idx
  ON public.gsc_query_metrics(normalized_page_url, query);

CREATE INDEX IF NOT EXISTS gsc_query_metrics_opportunity_idx
  ON public.gsc_query_metrics(impressions DESC, ctr ASC, position ASC);

CREATE INDEX IF NOT EXISTS gsc_query_metrics_import_run_idx
  ON public.gsc_query_metrics(import_run_id);

ALTER TABLE public.gsc_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gsc_query_metrics ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.articles.gsc_impressions IS
  'Search Console impressions for the latest synced window. Detail rows live in public.gsc_query_metrics.';

COMMENT ON TABLE public.gsc_import_runs IS
  'Google Search Console import runs for AIPickd. Private; server-side service role only.';

COMMENT ON TABLE public.gsc_query_metrics IS
  'Per-page, per-query Google Search Console metrics for AIPickd CTR and impressions analysis. Private; server-side service role only.';
