# AIPickd — Roadmap Impresiones + CTR (2026-06-03)

Programa por **fases** pa' subir impresiones y CTR **sin romper nada**. Regla: cada
fase se verifica (local + en la nube vía API pública/Supabase) y queda limpia
ANTES de pasar a la siguiente. Objetivo paralelo del usuario: **cero alarmas
falsas en Discord**.

Estado del sitio al arrancar: 121 publicados, URLs bonitas con keyword ✅,
sitemap + schema (Article/Breadcrumb/HowTo/FAQ) ✅, 5 categorías reales + **66 sin
categoría**, **sin páginas hub/pilar**, **sin página de autor**, GSC sin conectar.
Hosting Hostinger compartido con **cold-starts** (1er hit tras inactividad da
timeout) → causa raíz de las alertas de "sitio caído" + fallos de schema/dedup.

---

## FASE 1 — Confiabilidad (cero errores en Discord) 🩹  [FUNDACIÓN]
**Por qué primero:** prioridad #1 del usuario + base pa' que lo demás no truene.

- **Helper de warm-up compartido** (`scripts/lib/warmup.js`): antes de cualquier
  operación pesada a WP (schema, dedup, refresh-titles, monitor), pinga la home +
  wp-json 1-2 veces hasta que responda rápido. Mata los cold-starts en cascada.
- **Monitor 2-strikes**: el monitor solo grita "caído" tras **2 fallos seguidos**
  (con warm-up en medio), no en el primer timeout transitorio.
- **Aplicar warm-up** en `add-schema-markup.js`, `dedup-wordpress.js`,
  `refresh-titles.js`, `monitor-site.js`.
- **Cooldown/dedup de alertas** en `notify.js`: no repetir la misma alerta < N min.
- **Arreglar mensajes engañosos** ("Check WP auth" cuando en realidad es timeout).
- **Cloudflare (CDN/caché gratis)** enfrente de Hostinger → mata cold-starts +
  acelera el sitio (bonus SEO directo). *Paso manual del usuario: ~15 min de DNS.*
  Yo dejo la guía + config lista; él confirma.

**Verificación:** correr monitor/schema en seco; ver runs verdes en la nube + cero
alertas falsas por 24-48h.

---

## FASE 2 — Categorización (las 66) 🔧  [DESBLOQUEA HUBS]
- Diagnosticar por qué `categorize-posts.js` no converge (66 atorados: ¿falla el
  paso?, ¿el mapeo niche→categoría no las cubre?).
- Llevar "Uncategorized" a ~0. Habilita breadcrumbs reales + hubs por categoría.

---

## FASE 3 — Hub-and-spoke 🏛️  [IMPRESIONES]
- **Páginas hub por categoría** (AI Coding, AI Writing, …) auto-generadas y
  auto-actualizadas conforme se publican artículos.
- **Pilar maestra "Best AI Tools 2026"** que enlaza a todos los hubs.
- **Internal linking denso** hub↔artículos usando **URLs bonitas** (no `?p=`).
- **Breadcrumbs visibles** (no solo en schema) + bloque **"Related articles"** al
  final de cada post (más links internos, menos rebote).

---

## FASE 4 — E-E-A-T / Autor 👤  [IMPRESIONES + DISCOVER]
- **Página de autor** con bio + credenciales + foto.
- **Person schema** (autor) + **Organization schema** con `logo` y `sameAs`
  (entidad de marca → elegibilidad de knowledge panel).
- **Byline + "Updated [Mes Año]" visible** en cada artículo (frescura).

---

## FASE 5 — Google Discover 📱  [IMPRESIONES MÓVILES GRATIS]
- **News-sitemap** + frescura visible + imágenes grandes (✅ 1536×1024) + títulos
  provocativos (✅) → elegibilidad Discover (tráfico móvil masivo gratis).
- **Alt text con keyword** en imágenes destacadas (impresiones en Google Images).
- **Google Indexing API** pa' indexación más rápida de artículos nuevos.

---

## FASE 6 — Rich results ampliados ⭐  [CTR]
- **Estrellas de reseña** en comparativas y listicles vía `Product` +
  `aggregateRating` (hoy solo los 14 "review" pueden mostrar stars).
- Asegurar elegibilidad de FAQ/HowTo donde aplique.

---

## FASE 7 — GSC + data-driven 📊  [MEDICIÓN]
- Service account de Google + secret `GOOGLE_SERVICE_ACCOUNT_JSON`. *Paso manual
  del usuario: ~10 min.* Activa el `gsc-ctr-report.js` ya existente + prioriza el
  refresh de títulos por impresiones reales. Reconstruir `add-gsc-verification.js`
  (borrado por error).

---

## Notas de ejecución
- **Pushes a producción (main)** se confirman con el usuario (los crons corren
  desde main).
- Cada fase = commit(s) enfocados + verificación + deploy + chequeo en la nube.
- Idioma del sitio/artículos: inglés (audiencia US). Comunicación con usuario: ES.
