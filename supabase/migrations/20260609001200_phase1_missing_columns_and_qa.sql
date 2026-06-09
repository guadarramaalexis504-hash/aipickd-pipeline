-- Phase 1: missing columns and QA traceability.
--
-- Rollback notes:
--   ALTER TABLE public.articles DROP COLUMN IF EXISTS <column>;
--   ALTER TABLE public.keywords DROP COLUMN IF EXISTS <column>;
--   ALTER TABLE public.pipeline_config DROP COLUMN IF EXISTS spanish_pipeline_enabled;
-- Columns are added with IF NOT EXISTS and defaults are simple constants.

ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS primary_keyword TEXT,
  ADD COLUMN IF NOT EXISTS title_variants JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS quality_score INTEGER,
  ADD COLUMN IF NOT EXISTS title_refreshed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS schema_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gsc_impressions INTEGER,
  ADD COLUMN IF NOT EXISTS gsc_clicks INTEGER,
  ADD COLUMN IF NOT EXISTS gsc_ctr NUMERIC,
  ADD COLUMN IF NOT EXISTS gsc_position NUMERIC,
  ADD COLUMN IF NOT EXISTS gsc_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS qa_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_qa_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS repair_status TEXT,
  ADD COLUMN IF NOT EXISTS repair_notes TEXT,
  ADD COLUMN IF NOT EXISTS duplicate_of UUID REFERENCES public.articles(id),
  ADD COLUMN IF NOT EXISTS image_status TEXT,
  ADD COLUMN IF NOT EXISTS image_error TEXT,
  ADD COLUMN IF NOT EXISTS image_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS image_provider TEXT,
  ADD COLUMN IF NOT EXISTS featured_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS seo_title TEXT,
  ADD COLUMN IF NOT EXISTS seo_title_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS meta_description_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS ctr_status TEXT,
  ADD COLUMN IF NOT EXISTS last_ctr_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS title_test_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS title_test_variant TEXT,
  ADD COLUMN IF NOT EXISTS last_publish_error TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.keywords
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS normalized_keyword TEXT,
  ADD COLUMN IF NOT EXISTS canonical_topic TEXT,
  ADD COLUMN IF NOT EXISTS duplicate_of UUID REFERENCES public.keywords(id);

ALTER TABLE public.pipeline_config
  ADD COLUMN IF NOT EXISTS spanish_pipeline_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.pipeline_config.spanish_pipeline_enabled IS
  'Phase 1 Spanish safety gate. run-pipeline.js ignores language=es keywords unless this is true or --include-es is passed.';

COMMENT ON COLUMN public.articles.qa_issues IS
  'Structured quality gate failures, e.g. missing_faq, too_short, language_mismatch.';

COMMENT ON COLUMN public.articles.last_publish_error IS
  'Last WordPress/Supabase publish-path error. Does not imply content QA failure.';
