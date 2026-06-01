# AIPickd — CTR Optimization Report (2026-06-01)

Sesión autónoma de optimización de CTR. Objetivo: convertir impresiones en clics
(GSC mostraba impresiones, cero clics). Aquí está TODO: lo que estaba roto, lo que
implementé, lo que falta hacer manual, y más ideas pa' seguir.

---

## 🔴 Lo que estaba ROTO (hallazgos)

Tres bugs silenciosos estaban matando el CTR sin que nadie supiera:

### 1. La generación de imágenes llevaba meses fallando
- El pipeline llamaba `model: "dall-e-3"`, pero **OpenAI ELIMINÓ dall-e-3** de la
  cuenta (`/v1/models` confirma que solo queda `gpt-image-1`).
- El fallback de Unsplash tiene la **key vacía/inválida** (401).
- Resultado: **65 de 117 artículos (56%) sin imagen destacada** → sin thumbnail
  en SERP móvil, sin tarjeta social.

### 2. El schema estaba acoplado a la imagen → 56% sin schema
- El schema JSON-LD solo se inyectaba `if (imgUrl)`. Como la imagen fallaba,
  **los mismos 65 artículos tampoco tenían NADA de schema** (sin breadcrumbs,
  sin stars, sin nada). Google no podía hacer rich results.
- Los otros 52 sí tenían schema pero viejo: 1 bloque, sin breadcrumb, rating
  hardcodeado en "4.3" pa' todos.

### 3. El sitio NO emite meta description, NI Open Graph, NI Twitter Card
- No hay Yoast/Rank Math activo y el tema no genera estos tags. La página solo
  tiene `<link canonical>`.
- **Toda la optimización de meta descriptions era INVISIBLE** — Google no veía
  `<meta name="description">` así que auto-generaba el snippet.
- Los shares (WhatsApp, Discord, X, LinkedIn) salían como **links pelones sin
  tarjeta de preview** → CTR social pésimo.

### 4. 66 artículos en "Uncategorized"
- Breadcrumb débil (Home > Título, sin categoría), sin clustering temático, sin
  potencial de sitelinks.

---

## ✅ Lo que IMPLEMENTÉ (commits en main)

| # | Cambio | Archivo(s) | Impacto CTR |
|---|--------|-----------|-------------|
| 1 | **Módulo schema compartido** (breadcrumbs reales, ratings derivados de quality_score, HowTo con steps reales, fechas, degradación con gracia) | `scripts/lib/schema.js` | 🔴 Alto |
| 2 | **Schema desacoplado de imagen** — siempre se inyecta | `run-pipeline.js` | 🔴 Alto |
| 3 | **Backfill de schema** con modo `--upgrade` (re-inyecta fresco en los 117) | `add-schema-markup.js` + `schema-backfill.yml` | 🔴 Alto |
| 4 | **Auto-categorización** determinística (vía niche→categoría) | `categorize-posts.js` | 🟡 Medio-Alto |
| 5 | **Fix de imágenes** dall-e-3 → gpt-image-1 (validado: 200 OK, ~$0.02/img) | `run-pipeline.js` | 🟡 Medio |
| 6 | **Backfill de imágenes** + auto-reparación gradual (3/run en el cron) | `backfill-images.js` + `generate.yml` | 🟡 Medio |
| 7 | **Plugin meta description + OG + Twitter Card** | `wordpress/mu-plugins/aipickd-seo-meta.php` | 🔴 Alto |

**Lo que pasa automático ahora**: cada artículo NUEVO (cron cada 4h) sale con
imagen (gpt-image-1) + schema completo + categoría + breadcrumbs + stars honestos.
Los 65 sin imagen se auto-reparan en ~3-4 días (3/run).

**Nota sobre rich results 2023+**: Google quitó FAQ/HowTo del SERP (FAQ solo
gov/health). Los mantengo válidos (ayudan a LLMs y por si los re-activan), pero
los wins REALES de schema son **breadcrumbs + review stars + fechas frescas**.

---

## ⚠️ ACCIÓN MANUAL requerida (3 pasos — yo no tengo acceso)

### Paso 1 — Subir el plugin de meta tags (EL MÁS IMPORTANTE, ~1 min)
El auth de WP local da 401 (solo funciona en GitHub Actions), y los plugins no se
suben por API. Tú súbelo:
1. Hostinger → File Manager → `public_html/wp-content/mu-plugins/`
   (crea la carpeta `mu-plugins` si no existe)
2. Sube `wordpress/mu-plugins/aipickd-seo-meta.php`
3. Listo — los mu-plugins se auto-activan. Verifica con "ver código fuente" en
   cualquier artículo y busca `og:image`.

**Por qué importa**: hace que TODAS las meta descriptions por fin se rendericen y
da tarjeta de preview a los 117 artículos en redes. Es el cambio de mayor impacto.

### Paso 2 — Correr el backfill de SEO (categorías + schema en los 117 viejos)
GitHub → repo → Actions → "SEO Backfill (categories + rich results)" → Run workflow:
- Primero con `dry_run = true` (ve qué cambiaría, no escribe nada)
- Si se ve bien, otra vez con `dry_run = false`, `mode = upgrade`
- Esto categoriza los 66 + agrega/actualiza schema con breadcrumbs en los 117.

### Paso 3 — (Opcional) Imágenes ya
El backfill de imágenes corre solo (3/run). Si las quieres YA, Actions →
disparo manual de `node scripts/backfill-images.js --limit 65` (o espera ~4 días).

---

## 🚀 MÁS IDEAS pa' CTR y tráfico (pa' que escojas)

### A. Marca / assets (rápido, alto impacto visual)
- **Logo + OG default real**: sube un logo y una imagen OG genérica a WP Media,
  pega las URLs en `LOGO_URL`/`DEFAULT_IMG` (lib/schema.js) y `AIPICKD_DEFAULT_OG_IMAGE`
  (el plugin). Da logo en schema (rich results de marca) + tarjeta social en páginas
  sin imagen.

### B. Review stars en MÁS artículos
- Hoy solo los 14 "review" individuales pueden mostrar estrellas. Los 41 comparison
  y 37 listicle no (Google no muestra stars en Article). **Idea**: convertir más
  keywords a formato "X Review" individual, o añadir `Product`+`aggregateRating`
  por herramienta dentro de los listicles (requiere ratings por tool — estructurar).

### C. GSC-driven refresh (cuando configures credenciales)
- Configurar Google Search Console API (OAuth/service account) y construir un
  script que jale CTR por página, detecte las de muchas impresiones + CTR <2%, y
  las priorice pa' refresh de título/meta. Ataca primero lo de mayor impacto.
- `GOOGLE_SEARCH_CONSOLE_SITE` y `GOOGLE_ANALYTICS_ID` están vacíos en `.env`.

### D. Featured snippets (position 0)
- Sección "What is X" al inicio (respuesta directa 40-60 palabras).
- Listas ordenadas y tablas limpias (Google las jala como snippet).
- Caja "TL;DR" arriba con la respuesta directa.

### E. Velocidad / Core Web Vitals
- Imágenes WebP + lazy load, CDN (Cloudflare free), minify CSS/JS.
- Plugin de caché (WP Super Cache). LCP < 2.5s.

### F. Internal linking / topical authority
- **Hub pages** (pillar): una mega-página "Best AI Tools 2026" que linkee a todas
  las reviews de esa categoría.
- "Related articles" al final de cada post.
- Cross-links entre comparaciones relacionadas (Jasper Review ↔ Copy.ai Review).

### G. Keywords de alta intención de compra
- "X vs Y", "X alternatives", "is X worth it", "X pricing 2026", "how to cancel X".
- Todas tienen buyer-intent alto y son fáciles de rankear.

### H. Freshness visible
- Mostrar "Updated [Mes Año]" visible en el artículo (no solo en schema). Google
  premia frescura, especialmente en tech/IA.

### I. Google Discover (tráfico móvil masivo y gratis)
- Imágenes grandes (1200x675+), títulos provocativos, contenido "newsworthy".
- Requiere las imágenes destacadas (ya se están arreglando).

### J. E-E-A-T / autor
- Página de autor con bio + credenciales, schema `Person`, página "Cómo probamos
  las herramientas" (methodology). Sube confianza → Google muestra más.

---

## 📊 Estado del pipeline (al 2026-06-01)
- 117 publicados, 0 drafts stuck, 170 keywords en cola
- 52/117 con imagen (→ 117 tras backfill), 0/117 título-refreshed (empieza cron 06:00 UTC)
- Costo: $3.63/$50 mes (gpt-image-1 añade ~$3-4/mes a 6 artículos/día)

## Prioridad sugerida
1. **Subir el plugin** (Paso 1) — desbloquea meta descriptions + social en todo el sitio
2. **Correr SEO Backfill** (Paso 2) — breadcrumbs + categorías + schema en los 117
3. Logo/OG default (idea A) — completa las tarjetas sociales
4. GSC API (idea C) — pa' priorizar refresh por datos reales
