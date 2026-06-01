-- Migration: Add title_refreshed_at column to articles table
-- Required by: scripts/refresh-titles.js (CTR optimization refresh bot)
-- Run in Supabase SQL Editor or via supabase db push

ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS title_refreshed_at TIMESTAMPTZ DEFAULT NULL;

-- Index for efficient lookup of un-refreshed articles
CREATE INDEX IF NOT EXISTS articles_title_refreshed_at_null_idx
  ON public.articles (published_at ASC)
  WHERE title_refreshed_at IS NULL AND wp_post_id IS NOT NULL;

COMMENT ON COLUMN public.articles.title_refreshed_at IS
  'Timestamp when GPT-4o-mini last rewrote this article title for CTR optimization';
