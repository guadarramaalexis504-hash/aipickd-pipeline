# 🔑 50 Keywords Iniciales — Pa' Arrancar el Sitio

Estas son 50 keywords seleccionadas manualmente pa' los primeros 2 meses.
Mezclan dificultad baja, media, y alta (pa' no depender solo de long-tail).

**Cómo se usan:** Se cargan en la tabla `keywords` de Supabase con `status = 'queued'`.
El workflow `02-content-generation` las consume de una en una.

---

## Nicho 1: AI Writing Tools (15 keywords)

| Keyword | Tipo | Prioridad | Dificultad |
|---------|------|-----------|------------|
| best AI writing tools for small business 2026 | listicle | 10 | medium |
| Jasper vs Copy.ai vs Writesonic | comparison | 10 | medium |
| is Jasper AI worth it | review | 9 | low |
| ChatGPT alternatives for writing | alternatives | 9 | medium |
| best free AI writing tools | listicle | 8 | high |
| Jasper AI review 2026 | review | 10 | low |
| Copy.ai vs ChatGPT for marketing copy | comparison | 9 | low |
| best AI tool for blog writing | listicle | 9 | medium |
| AI writing tools for SEO content | listicle | 8 | medium |
| Writesonic vs Jasper AI | comparison | 8 | low |
| best AI tools for copywriters | listicle | 8 | medium |
| Rytr review: is it worth it | review | 7 | low |
| how to use Jasper AI for blog posts | how-to | 7 | low |
| ChatGPT vs Jasper for long-form content | comparison | 9 | low |
| best AI writing assistant for authors | listicle | 7 | low |

## Nicho 2: AI Business & Productivity (12 keywords)

| Keyword | Tipo | Prioridad | Dificultad |
|---------|------|-----------|------------|
| best AI tools for small business owners | listicle | 10 | medium |
| Notion AI vs ClickUp AI | comparison | 9 | low |
| Make.com vs Zapier for automation | comparison | 10 | medium |
| ClickUp vs Monday.com 2026 | comparison | 9 | medium |
| Notion AI review: worth the upgrade | review | 8 | low |
| best AI project management tools | listicle | 8 | medium |
| Make.com review: automation for non-techies | review | 9 | low |
| how to automate your business with AI | how-to | 8 | high |
| Notion vs ClickUp vs Monday | comparison | 10 | medium |
| best AI tools for solopreneurs | listicle | 9 | low |
| ClickUp AI review: features and pricing | review | 7 | low |
| Airtable vs Notion for AI workflows | comparison | 7 | low |

## Nicho 3: AI Image & Video (8 keywords)

| Keyword | Tipo | Prioridad | Dificultad |
|---------|------|-----------|------------|
| Midjourney vs DALL-E 3 vs Stable Diffusion | comparison | 10 | medium |
| best AI video generators 2026 | listicle | 10 | medium |
| Runway vs Pika Labs for AI video | comparison | 9 | low |
| Synthesia review: AI avatar videos | review | 8 | low |
| best AI image generators for marketers | listicle | 8 | medium |
| how to create AI videos without a face | how-to | 9 | medium |
| Midjourney alternatives free | alternatives | 8 | high |
| best AI tools for YouTubers | listicle | 9 | medium |

## Nicho 4: AI Coding Tools (8 keywords)

| Keyword | Tipo | Prioridad | Dificultad |
|---------|------|-----------|------------|
| Cursor vs GitHub Copilot 2026 | comparison | 10 | medium |
| best AI coding assistants for developers | listicle | 9 | medium |
| Claude Code review | review | 9 | low |
| Cursor IDE review: worth switching? | review | 9 | low |
| GitHub Copilot vs ChatGPT for coding | comparison | 8 | medium |
| Tabnine vs Copilot vs Cursor | comparison | 8 | low |
| best AI tools for web developers | listicle | 8 | medium |
| how to use AI to write code faster | how-to | 7 | medium |

## Nicho 5: AI Infrastructure & Hosting (7 keywords)

| Keyword | Tipo | Prioridad | Dificultad |
|---------|------|-----------|------------|
| best hosting for AI applications 2026 | listicle | 9 | low |
| Supabase vs Firebase 2026 | comparison | 10 | medium |
| Vercel vs Netlify for AI apps | comparison | 9 | low |
| Hostinger review: worth the hype? | review | 8 | high |
| best VPS for running AI models | listicle | 7 | medium |
| Railway vs Render for deployment | comparison | 7 | low |
| cheapest GPU hosting for AI | listicle | 7 | medium |

---

## 📥 Cómo cargar estas keywords en Supabase

### Opción A: SQL directo (rápido)

Ve a **Supabase → SQL Editor → New query** y pega esto:

```sql
-- Asegúrate de haber corrido schema.sql primero

-- Cargar keywords iniciales
WITH niche_ids AS (
  SELECT slug, id FROM niches
)
INSERT INTO keywords (keyword, niche_id, article_type, intent, priority, status)
VALUES
  -- AI Writing
  ('best AI writing tools for small business 2026', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'listicle', 'commercial', 10, 'queued'),
  ('Jasper vs Copy.ai vs Writesonic', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'comparison', 'commercial', 10, 'queued'),
  ('is Jasper AI worth it', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'review', 'commercial', 9, 'queued'),
  ('ChatGPT alternatives for writing', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'alternatives', 'commercial', 9, 'queued'),
  ('best free AI writing tools', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'listicle', 'commercial', 8, 'queued'),
  ('Jasper AI review 2026', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'review', 'commercial', 10, 'queued'),
  ('Copy.ai vs ChatGPT for marketing copy', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'comparison', 'commercial', 9, 'queued'),
  ('best AI tool for blog writing', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'listicle', 'commercial', 9, 'queued'),
  ('AI writing tools for SEO content', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'listicle', 'commercial', 8, 'queued'),
  ('Writesonic vs Jasper AI', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'comparison', 'commercial', 8, 'queued'),
  ('best AI tools for copywriters', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'listicle', 'commercial', 8, 'queued'),
  ('Rytr review: is it worth it', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'review', 'commercial', 7, 'queued'),
  ('how to use Jasper AI for blog posts', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'how-to', 'informational', 7, 'queued'),
  ('ChatGPT vs Jasper for long-form content', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'comparison', 'commercial', 9, 'queued'),
  ('best AI writing assistant for authors', (SELECT id FROM niche_ids WHERE slug='ai-writing'), 'listicle', 'commercial', 7, 'queued'),

  -- AI Business
  ('best AI tools for small business owners', (SELECT id FROM niche_ids WHERE slug='ai-business'), 'listicle', 'commercial', 10, 'queued'),
  ('Notion AI vs ClickUp AI', (SELECT id FROM niche_ids WHERE slug='ai-business'), 'comparison', 'commercial', 9, 'queued'),
  ('Make.com vs Zapier for automation', (SELECT id FROM niche_ids WHERE slug='ai-business'), 'comparison', 'commercial', 10, 'queued'),
  ('ClickUp vs Monday.com 2026', (SELECT id FROM niche_ids WHERE slug='ai-business'), 'comparison', 'commercial', 9, 'queued'),
  ('Notion AI review: worth the upgrade', (SELECT id FROM niche_ids WHERE slug='ai-business'), 'review', 'commercial', 8, 'queued'),
  ('best AI project management tools', (SELECT id FROM niche_ids WHERE slug='ai-business'), 'listicle', 'commercial', 8, 'queued'),
  ('Make.com review: automation for non-techies', (SELECT id FROM niche_ids WHERE slug='ai-business'), 'review', 'commercial', 9, 'queued'),
  ('how to automate your business with AI', (SELECT id FROM niche_ids WHERE slug='ai-business'), 'how-to', 'informational', 8, 'queued'),
  ('Notion vs ClickUp vs Monday', (SELECT id FROM niche_ids WHERE slug='ai-business'), 'comparison', 'commercial', 10, 'queued'),
  ('best AI tools for solopreneurs', (SELECT id FROM niche_ids WHERE slug='ai-business'), 'listicle', 'commercial', 9, 'queued'),
  ('ClickUp AI review: features and pricing', (SELECT id FROM niche_ids WHERE slug='ai-business'), 'review', 'commercial', 7, 'queued'),
  ('Airtable vs Notion for AI workflows', (SELECT id FROM niche_ids WHERE slug='ai-business'), 'comparison', 'commercial', 7, 'queued'),

  -- AI Image & Video
  ('Midjourney vs DALL-E 3 vs Stable Diffusion', (SELECT id FROM niche_ids WHERE slug='ai-image-video'), 'comparison', 'commercial', 10, 'queued'),
  ('best AI video generators 2026', (SELECT id FROM niche_ids WHERE slug='ai-image-video'), 'listicle', 'commercial', 10, 'queued'),
  ('Runway vs Pika Labs for AI video', (SELECT id FROM niche_ids WHERE slug='ai-image-video'), 'comparison', 'commercial', 9, 'queued'),
  ('Synthesia review: AI avatar videos', (SELECT id FROM niche_ids WHERE slug='ai-image-video'), 'review', 'commercial', 8, 'queued'),
  ('best AI image generators for marketers', (SELECT id FROM niche_ids WHERE slug='ai-image-video'), 'listicle', 'commercial', 8, 'queued'),
  ('how to create AI videos without a face', (SELECT id FROM niche_ids WHERE slug='ai-image-video'), 'how-to', 'informational', 9, 'queued'),
  ('Midjourney alternatives free', (SELECT id FROM niche_ids WHERE slug='ai-image-video'), 'alternatives', 'commercial', 8, 'queued'),
  ('best AI tools for YouTubers', (SELECT id FROM niche_ids WHERE slug='ai-image-video'), 'listicle', 'commercial', 9, 'queued'),

  -- AI Coding
  ('Cursor vs GitHub Copilot 2026', (SELECT id FROM niche_ids WHERE slug='ai-coding'), 'comparison', 'commercial', 10, 'queued'),
  ('best AI coding assistants for developers', (SELECT id FROM niche_ids WHERE slug='ai-coding'), 'listicle', 'commercial', 9, 'queued'),
  ('Claude Code review', (SELECT id FROM niche_ids WHERE slug='ai-coding'), 'review', 'commercial', 9, 'queued'),
  ('Cursor IDE review: worth switching?', (SELECT id FROM niche_ids WHERE slug='ai-coding'), 'review', 'commercial', 9, 'queued'),
  ('GitHub Copilot vs ChatGPT for coding', (SELECT id FROM niche_ids WHERE slug='ai-coding'), 'comparison', 'commercial', 8, 'queued'),
  ('Tabnine vs Copilot vs Cursor', (SELECT id FROM niche_ids WHERE slug='ai-coding'), 'comparison', 'commercial', 8, 'queued'),
  ('best AI tools for web developers', (SELECT id FROM niche_ids WHERE slug='ai-coding'), 'listicle', 'commercial', 8, 'queued'),
  ('how to use AI to write code faster', (SELECT id FROM niche_ids WHERE slug='ai-coding'), 'how-to', 'informational', 7, 'queued'),

  -- AI Hosting
  ('best hosting for AI applications 2026', (SELECT id FROM niche_ids WHERE slug='ai-hosting'), 'listicle', 'commercial', 9, 'queued'),
  ('Supabase vs Firebase 2026', (SELECT id FROM niche_ids WHERE slug='ai-hosting'), 'comparison', 'commercial', 10, 'queued'),
  ('Vercel vs Netlify for AI apps', (SELECT id FROM niche_ids WHERE slug='ai-hosting'), 'comparison', 'commercial', 9, 'queued'),
  ('Hostinger review: worth the hype?', (SELECT id FROM niche_ids WHERE slug='ai-hosting'), 'review', 'commercial', 8, 'queued'),
  ('best VPS for running AI models', (SELECT id FROM niche_ids WHERE slug='ai-hosting'), 'listicle', 'commercial', 7, 'queued'),
  ('Railway vs Render for deployment', (SELECT id FROM niche_ids WHERE slug='ai-hosting'), 'comparison', 'commercial', 7, 'queued'),
  ('cheapest GPU hosting for AI', (SELECT id FROM niche_ids WHERE slug='ai-hosting'), 'listicle', 'commercial', 7, 'queued');

-- Verifica
SELECT COUNT(*) AS total_keywords_queued FROM keywords WHERE status = 'queued';
-- Esperado: 50
```

### Opción B: Import CSV (desde Supabase Table Editor)

Si prefieres UI, exporto a CSV y me avisas.

---

## 🧠 Por qué estas keywords y no otras

1. **Mezcla de dificultades:** 30% dificultad baja (ganas rápido), 60% media (crecimiento sostenible), 10% alta (apuesta de long-shot).
2. **Alta intención comercial:** casi todas son "best", "vs", "review" — intención de compra.
3. **Año incluido en varias (2026):** Google premia contenido fresco en búsquedas con año.
4. **Productos con afiliados configurados:** cada keyword menciona productos que tenemos en la tabla `affiliates`.
5. **Variedad de tipos:** listicles, comparaciones, reviews, alternatives, how-tos → cubrimos todo el funnel.

Después del día 60, el workflow `01-keyword-research` agrega 10 nuevas por día solo.
