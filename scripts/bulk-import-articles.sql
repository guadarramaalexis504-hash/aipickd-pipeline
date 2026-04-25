-- ============================================
-- Bulk import — 5 artículos pre-generados del content-bank/
-- Ejecutar DESPUÉS de schema.sql
--
-- NOTA: El content_markdown aquí está truncado para legibilidad.
-- La versión completa está en content-bank/*.md
-- Pa' importar el contenido completo, usa el script Node.js:
--   node scripts/import-articles.js
-- ============================================

-- Opción 1 (rápida): Solo crear registros con título y slug
-- El contenido se actualiza después desde los .md

WITH
  ai_writing AS (SELECT id FROM niches WHERE slug = 'ai-writing'),
  ai_business AS (SELECT id FROM niches WHERE slug = 'ai-business'),
  ai_image_video AS (SELECT id FROM niches WHERE slug = 'ai-image-video'),
  ai_coding AS (SELECT id FROM niches WHERE slug = 'ai-coding'),
  ai_hosting AS (SELECT id FROM niches WHERE slug = 'ai-hosting')

INSERT INTO articles (niche_id, title, slug, meta_description, article_type, status, generated_by, word_count)
VALUES
  (
    (SELECT id FROM ai_writing),
    'Jasper vs Copy.ai vs Writesonic: Which AI Writer Wins in 2026?',
    'jasper-vs-copy-vs-writesonic',
    'Head-to-head comparison of Jasper, Copy.ai, and Writesonic. Real pricing, real limitations, and clear picks for marketers, bloggers, and teams.',
    'comparison',
    'draft',
    'claude',
    2100
  ),
  (
    (SELECT id FROM ai_business),
    '11 Best AI Tools for Small Business Owners in 2026 (Tested & Ranked)',
    'best-ai-tools-small-business-owners-2026',
    'The 11 AI tools that actually move the needle for small businesses in 2026. Real use cases, real pricing, honest tradeoffs — no hype.',
    'listicle',
    'draft',
    'claude',
    2200
  ),
  (
    (SELECT id FROM ai_image_video),
    'Midjourney vs DALL-E 3 vs Stable Diffusion: Real Head-to-Head for 2026',
    'midjourney-vs-dalle-vs-stable-diffusion',
    'We tested Midjourney, DALL-E 3, and Stable Diffusion across 7 real use cases. Here''s which AI image generator wins for artists, marketers, and budget users.',
    'comparison',
    'draft',
    'claude',
    2000
  ),
  (
    (SELECT id FROM ai_coding),
    'Cursor vs GitHub Copilot in 2026: Which AI Coding Assistant Actually Wins?',
    'cursor-vs-github-copilot-2026',
    'Honest head-to-head of Cursor and GitHub Copilot based on real developer workflows. Pricing, features, and who should pick what.',
    'comparison',
    'draft',
    'claude',
    2000
  ),
  (
    (SELECT id FROM ai_hosting),
    'Supabase vs Firebase in 2026: Which Backend Should You Actually Choose?',
    'supabase-vs-firebase-2026',
    'Detailed comparison of Supabase and Firebase for modern app development. Real pricing, real tradeoffs, and who should pick what in 2026.',
    'comparison',
    'draft',
    'claude',
    2100
  );

-- Verifica
SELECT title, slug, status, word_count FROM articles ORDER BY created_at DESC LIMIT 10;
