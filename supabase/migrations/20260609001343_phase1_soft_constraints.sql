-- Phase 1: soft constraints/checks.
--
-- Rollback notes:
--   ALTER TABLE public.<table> DROP CONSTRAINT IF EXISTS <constraint>;
-- Constraints are added NOT VALID so existing production drift does not block
-- deployment. Validation can happen later after reconciliation.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'articles_language_check'
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_language_check
      CHECK (language IN ('en', 'es')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'keywords_language_check'
  ) THEN
    ALTER TABLE public.keywords
      ADD CONSTRAINT keywords_language_check
      CHECK (language IN ('en', 'es')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'articles_status_check_phase1'
  ) THEN
    ALTER TABLE public.articles
      ADD CONSTRAINT articles_status_check_phase1
      CHECK (status IN ('draft', 'pending_review', 'published', 'qa_failed', 'needs_update', 'needs_repair', 'archived')) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'keywords_status_check_phase1'
  ) THEN
    ALTER TABLE public.keywords
      ADD CONSTRAINT keywords_status_check_phase1
      CHECK (status IN ('queued', 'hold', 'es_hold', 'in_progress', 'generated', 'published', 'qa_failed', 'needs_repair', 'skipped', 'archived')) NOT VALID;
  END IF;
END $$;

COMMENT ON CONSTRAINT articles_status_check_phase1 ON public.articles IS
  'NOT VALID Phase 1 status guard. Validate only after production reconciliation.';

COMMENT ON CONSTRAINT keywords_status_check_phase1 ON public.keywords IS
  'NOT VALID Phase 1 status guard. Validate only after production reconciliation.';
