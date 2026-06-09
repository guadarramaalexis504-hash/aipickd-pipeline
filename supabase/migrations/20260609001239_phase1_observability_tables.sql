-- Phase 1: internal observability tables.
--
-- Rollback notes:
--   DROP TABLE IF EXISTS public.indexing_status;
--   DROP TABLE IF EXISTS public.internal_links;
--   DROP TABLE IF EXISTS public.publish_attempts;
--   DROP TABLE IF EXISTS public.pipeline_runs;
--
-- These tables are for server-side automation only. RLS is enabled and
-- anon/authenticated grants are revoked so public clients cannot read them.

CREATE TABLE IF NOT EXISTS public.pipeline_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_run_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  generated_count INTEGER NOT NULL DEFAULT 0 CHECK (generated_count >= 0),
  published_count INTEGER NOT NULL DEFAULT 0 CHECK (published_count >= 0),
  qa_failed_count INTEGER NOT NULL DEFAULT 0 CHECK (qa_failed_count >= 0),
  failed_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.publish_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID REFERENCES public.articles(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status TEXT NOT NULL,
  wp_post_id INTEGER,
  wp_url TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.internal_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_article_id UUID REFERENCES public.articles(id) ON DELETE CASCADE,
  target_article_id UUID REFERENCES public.articles(id) ON DELETE CASCADE,
  anchor_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_article_id, target_article_id, anchor_text)
);

CREATE TABLE IF NOT EXISTS public.indexing_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id UUID REFERENCES public.articles(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  provider TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'submitted',
  last_http_status INTEGER,
  response_body TEXT
);

ALTER TABLE public.pipeline_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publish_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.indexing_status ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.pipeline_runs, public.publish_attempts, public.internal_links, public.indexing_status FROM %I',
        role_name
      );
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE public.pipeline_runs IS
  'Internal automation run summaries. Server-side service role only.';

COMMENT ON TABLE public.publish_attempts IS
  'Internal WordPress publish attempt audit trail. Server-side service role only.';

COMMENT ON TABLE public.internal_links IS
  'Internal record of generated article-to-article links. Server-side service role only.';

COMMENT ON TABLE public.indexing_status IS
  'Internal IndexNow/search submission audit trail. Server-side service role only.';
