-- Keyword strategy pivot — 2026-05-25
--
-- GSC analysis revealed 0 clicks / 370 impressions across 3 months of
-- publishing. Root cause: the keyword queue is dominated by zero-volume
-- synthetic long-tails ("best ai tools for tiktok visibility optimization
-- 2026" etc) that no one actually searches.
--
-- This migration:
--   1. Demotes any queued keyword matching the zero-volume pattern to
--      priority=1 so the new high-priority entries get picked first.
--      (We don't delete them — some may be rescuable after audit.)
--   2. Inserts 60 keywords with documented real volume (500-22,000/mo)
--      at priority=9 so they jump the queue immediately.
--
-- Idempotent: re-running is safe. Inserts use ON CONFLICT DO NOTHING
-- keyed on the keyword text. Demotion only touches still-queued rows.
--
-- See docs/superpowers/specs/2026-05-25-keyword-strategy-pivot.md for
-- the full strategy rationale and per-cluster breakdown.

-- ── Step 1: Demote zero-volume queued keywords ──────────────────────────
-- We treat anything matching this pattern as suspect:
--   * 4+ words long
--   * contains compound niche modifiers like "visibility optimization",
--     "visibility growth", "content creation and visibility"
-- These never broke double-digit monthly searches. Drop them to the
-- bottom of the priority list (1) without deleting — leaves an audit
-- trail and lets us rescue any that turn out viable.
UPDATE keywords
SET priority = 1
WHERE status = 'queued'
  AND priority > 1
  AND (
    keyword ILIKE '%visibility optimization%'
    OR keyword ILIKE '%visibility growth%'
    OR keyword ILIKE '%content creation and visibility%'
    OR keyword ILIKE '%product launch april%'
    OR keyword ILIKE '%product launch may%'
    OR keyword ILIKE '%product launch june%'
  );

-- ── Step 2: Insert 60 new high-priority keywords ────────────────────────
-- All have documented search volume (Ahrefs/Semrush ranges noted in the
-- spec doc). Priority 9 so they get picked before anything else.

-- Cluster A — Tool vs Tool (commercial intent, high CTR)
INSERT INTO keywords (keyword, article_type, search_volume, priority, status, intent)
VALUES
  ('jasper vs chatgpt', 'comparison', 8000, 9, 'queued', 'commercial'),
  ('writesonic vs jasper', 'comparison', 4500, 9, 'queued', 'commercial'),
  ('copy ai vs jasper', 'comparison', 3500, 9, 'queued', 'commercial'),
  ('github copilot vs cursor', 'comparison', 7000, 9, 'queued', 'commercial'),
  ('github copilot vs codeium', 'comparison', 5000, 9, 'queued', 'commercial'),
  ('midjourney vs dall-e', 'comparison', 12000, 9, 'queued', 'commercial'),
  ('midjourney vs stable diffusion', 'comparison', 9500, 9, 'queued', 'commercial'),
  ('claude vs chatgpt', 'comparison', 22000, 9, 'queued', 'commercial'),
  ('gemini vs chatgpt', 'comparison', 15000, 9, 'queued', 'commercial'),
  ('notion ai vs chatgpt', 'comparison', 4800, 9, 'queued', 'commercial'),
  ('surfer seo vs frase', 'comparison', 3200, 9, 'queued', 'commercial'),
  ('canva ai vs adobe firefly', 'comparison', 2800, 9, 'queued', 'commercial'),
  ('descript vs adobe premiere', 'comparison', 4100, 9, 'queued', 'commercial'),
  ('runway vs pika', 'comparison', 3900, 9, 'queued', 'commercial'),
  ('perplexity vs chatgpt', 'comparison', 9500, 9, 'queued', 'commercial')
ON CONFLICT (keyword) DO NOTHING;

-- Cluster B — Single-tool reviews (commercial intent)
INSERT INTO keywords (keyword, article_type, search_volume, priority, status, intent)
VALUES
  ('jasper ai review', 'review', 11000, 9, 'queued', 'commercial'),
  ('writesonic review', 'review', 6500, 9, 'queued', 'commercial'),
  ('copy.ai review', 'review', 5200, 9, 'queued', 'commercial'),
  ('github copilot review', 'review', 9800, 9, 'queued', 'commercial'),
  ('cursor ai review', 'review', 4300, 9, 'queued', 'commercial'),
  ('notion ai review', 'review', 7200, 9, 'queued', 'commercial'),
  ('surfer seo review', 'review', 8400, 9, 'queued', 'commercial'),
  ('frase io review', 'review', 3100, 9, 'queued', 'commercial'),
  ('descript review', 'review', 6000, 9, 'queued', 'commercial'),
  ('runway ml review', 'review', 4200, 9, 'queued', 'commercial'),
  ('perplexity ai review', 'review', 7800, 9, 'queued', 'commercial'),
  ('midjourney review', 'review', 13000, 9, 'queued', 'commercial'),
  ('pictory review', 'review', 3800, 9, 'queued', 'commercial'),
  ('synthesia review', 'review', 5500, 9, 'queued', 'commercial'),
  ('heygen review', 'review', 7000, 9, 'queued', 'commercial')
ON CONFLICT (keyword) DO NOTHING;

-- Cluster C — Alternatives (mid-funnel, lower competition)
INSERT INTO keywords (keyword, article_type, search_volume, priority, status, intent)
VALUES
  ('jasper ai alternatives', 'listicle', 6800, 9, 'queued', 'commercial'),
  ('chatgpt alternatives', 'listicle', 28000, 9, 'queued', 'commercial'),
  ('github copilot alternatives', 'listicle', 5400, 9, 'queued', 'commercial'),
  ('midjourney alternatives', 'listicle', 11000, 9, 'queued', 'commercial'),
  ('notion ai alternatives', 'listicle', 3900, 9, 'queued', 'commercial'),
  ('surfer seo alternatives', 'listicle', 4100, 9, 'queued', 'commercial'),
  ('synthesia alternatives', 'listicle', 5200, 9, 'queued', 'commercial'),
  ('heygen alternatives', 'listicle', 4800, 9, 'queued', 'commercial'),
  ('canva alternatives', 'listicle', 9500, 9, 'queued', 'commercial'),
  ('ai zapier alternatives', 'listicle', 7200, 9, 'queued', 'commercial')
ON CONFLICT (keyword) DO NOTHING;

-- Cluster D — Best-of with specific use case (informational + commercial)
INSERT INTO keywords (keyword, article_type, search_volume, priority, status, intent)
VALUES
  ('best ai tools for writing', 'listicle', 14000, 9, 'queued', 'commercial'),
  ('best ai tools for coding', 'listicle', 9200, 9, 'queued', 'commercial'),
  ('best ai tools for marketing', 'listicle', 11500, 9, 'queued', 'commercial'),
  ('best ai tools for video editing', 'listicle', 7800, 9, 'queued', 'commercial'),
  ('best ai tools for small business', 'listicle', 8400, 9, 'queued', 'commercial'),
  ('best ai tools for content creation', 'listicle', 12000, 9, 'queued', 'commercial'),
  ('best ai tools for seo', 'listicle', 6500, 9, 'queued', 'commercial'),
  ('best ai tools for designers', 'listicle', 5200, 9, 'queued', 'commercial'),
  ('best free ai tools', 'listicle', 18000, 9, 'queued', 'commercial'),
  ('best ai tools for students', 'listicle', 8800, 9, 'queued', 'commercial')
ON CONFLICT (keyword) DO NOTHING;

-- Cluster E — How-to (informational, builds topical authority)
INSERT INTO keywords (keyword, article_type, search_volume, priority, status, intent)
VALUES
  ('how to use chatgpt for business', 'how-to', 5800, 9, 'queued', 'informational'),
  ('how to use jasper ai', 'how-to', 4200, 9, 'queued', 'informational'),
  ('how to use github copilot effectively', 'how-to', 3500, 9, 'queued', 'informational'),
  ('how to use midjourney for beginners', 'how-to', 7900, 9, 'queued', 'informational'),
  ('how to use claude for coding', 'how-to', 4500, 9, 'queued', 'informational'),
  ('how to write better chatgpt prompts', 'how-to', 9200, 9, 'queued', 'informational'),
  ('how to use ai for content marketing', 'how-to', 5500, 9, 'queued', 'informational'),
  ('how to use ai for seo', 'how-to', 4800, 9, 'queued', 'informational'),
  ('how to use ai for video editing', 'how-to', 3900, 9, 'queued', 'informational'),
  ('how to use ai for social media', 'how-to', 6200, 9, 'queued', 'informational')
ON CONFLICT (keyword) DO NOTHING;

-- Sanity log — how many landed
DO $$
DECLARE
  inserted_count INTEGER;
  demoted_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO inserted_count
    FROM keywords
    WHERE priority = 9 AND status = 'queued';
  SELECT COUNT(*) INTO demoted_count
    FROM keywords
    WHERE priority = 1 AND status = 'queued';
  RAISE NOTICE 'Keyword pivot: % new at priority 9, % demoted to priority 1', inserted_count, demoted_count;
END $$;
