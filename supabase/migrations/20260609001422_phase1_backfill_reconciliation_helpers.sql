-- Phase 1: conservative backfill and updated_at helper triggers.
--
-- Rollback notes:
--   DROP TRIGGER IF EXISTS keywords_touch_updated_at ON public.keywords;
--   DROP TRIGGER IF EXISTS articles_touch_updated_at ON public.articles;
--   DROP FUNCTION IF EXISTS public.aipickd_touch_updated_at();
-- Backfills are metadata-only and do not publish, release, delete, or archive.

UPDATE public.articles
SET language = 'en'
WHERE language IS NULL;

UPDATE public.keywords
SET language = 'en'
WHERE language IS NULL;

UPDATE public.articles
SET qa_issues = '[]'::jsonb
WHERE qa_issues IS NULL;

UPDATE public.keywords
SET updated_at = COALESCE(updated_at, now());

CREATE OR REPLACE FUNCTION public.aipickd_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS keywords_touch_updated_at ON public.keywords;
CREATE TRIGGER keywords_touch_updated_at
  BEFORE UPDATE ON public.keywords
  FOR EACH ROW
  EXECUTE FUNCTION public.aipickd_touch_updated_at();

DROP TRIGGER IF EXISTS articles_touch_updated_at ON public.articles;
CREATE TRIGGER articles_touch_updated_at
  BEFORE UPDATE ON public.articles
  FOR EACH ROW
  EXECUTE FUNCTION public.aipickd_touch_updated_at();
