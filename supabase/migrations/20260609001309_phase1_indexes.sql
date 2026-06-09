-- Phase 1: indexes for multilingual pipeline, QA, and reconciliation.
--
-- Rollback notes:
--   DROP INDEX IF EXISTS public.<index_name>;
-- Normal CREATE INDEX is used so this file can run inside the existing
-- migration-check transaction. Keep predicates selective to reduce size.

CREATE UNIQUE INDEX IF NOT EXISTS uq_articles_idempotency_key
  ON public.articles(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_articles_language_status
  ON public.articles(language, status);

CREATE INDEX IF NOT EXISTS idx_articles_status_wp_post_id
  ON public.articles(status, wp_post_id);

CREATE INDEX IF NOT EXISTS idx_articles_slug
  ON public.articles(slug);

CREATE INDEX IF NOT EXISTS idx_articles_primary_keyword
  ON public.articles(primary_keyword);

CREATE INDEX IF NOT EXISTS idx_articles_qa_failed_language
  ON public.articles(language, created_at DESC)
  WHERE status = 'qa_failed';

CREATE INDEX IF NOT EXISTS idx_keywords_language_status_priority
  ON public.keywords(language, status, priority DESC, search_volume DESC);

CREATE INDEX IF NOT EXISTS idx_keywords_assigned_article_id
  ON public.keywords(assigned_article_id);

CREATE INDEX IF NOT EXISTS idx_keywords_duplicate_of
  ON public.keywords(duplicate_of)
  WHERE duplicate_of IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started_at
  ON public.pipeline_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_publish_attempts_article_created
  ON public.publish_attempts(article_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_internal_links_source
  ON public.internal_links(source_article_id);

CREATE INDEX IF NOT EXISTS idx_indexing_status_url_provider
  ON public.indexing_status(url, provider, submitted_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'pg_trgm'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_articles_title_trgm
      ON public.articles USING gin (title gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_keywords_keyword_trgm
      ON public.keywords USING gin (keyword gin_trgm_ops)';
  END IF;
END $$;
