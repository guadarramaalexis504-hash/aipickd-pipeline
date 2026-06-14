# AIPickd — Fixes de pipeline + Bilingüe ES + CTR/Impresiones (2026-06-14)

Spec de la sesión. Mandato del usuario: arreglar TODOS los errores de Discord,
implementar el modo bilingüe ES/EN, y meter todas las mejoras de CTR/impresiones
posibles. Ejecución **autónoma con push directo a main**. Español **arranque
controlado** (1 artículo limpio verificado antes de prender todo).

Contexto crítico descubierto: el `main` local estaba **13 commits atrás** de
`origin/main`. Sincronizado vía fast-forward antes de empezar. (Regla nueva:
`git pull` antes de tocar nada — el cloud corre desde `origin/main`.)

---

## Diagnóstico verificado en vivo

### Error 1 — Falsas alarmas "sitio caído"
- Medido: home `200` en **12.35s en frío**, sitemap `0.5s` caliente. Sitio SANO.
- Causa: `monitor-site.js` usa `page.goto` (navegación de browser completa) con
  timeout 30s. En cold-start de Hostinger una nav completa supera 30s aunque el
  HTML responda. El warm-up existente no alcanza, y "lento (>5s)" se cuenta como
  issue → alerta. Dedup de `notifyAlert` es in-process → no aplica cross-run.

### Error 2 — "Spanish publish blocked" (deadlock del probe)
- WordPress YA está listo: Polylang activo, idioma `Español (es_MX)` con `/es/`,
  mu-plugin `aipickd-lang-bridge.php` desplegado (`_pipeline_lang` sale en REST).
- `wp-language-bridge-probe.js` en READ ONLY busca un post ES público para
  verificar; no existe ninguno → bloquea. Pero no puede existir hasta que el
  probe pase. **Deadlock.** El gate solo frena ES (run-pipeline.js:1571), el
  inglés publica normal (172 EN live).
- Estado DB: `spanish_pipeline_enabled=false`, 6 art ES (1 draft atorado, 4
  qa_failed, 0 publicados), 10 keywords ES (7 en `es_hold`).

---

## Track A — Cero alarmas falsas

1. **Reescribir el core de `monitor-site.js`** a chequeo HTTP con `fetchWithRetry`
   (no browser) como señal primaria up/down. Timeout 45s, 3 strikes con warm-up
   entre cada uno. Browser queda como check secundario NO-fatal (solo console
   errors). Separar `issues` (alerta) de `warnings` (lento → solo log). Subir
   umbral "lento" a 15s.
2. **Persistencia cross-run**: el monitor solo dispara "caído" tras **2 runs
   fallidos consecutivos** (estado en Supabase). Un cold-start de 1 run nunca
   alerta; una caída real de 2h+ sí. Auto-resuelve al primer run OK.
3. Verificación: `npm run validate` + correr monitor en seco contra prod.

## Track B — Desbloquear español (arranque controlado)

1. **Romper el deadlock del probe**: `wp-language-bridge-probe.js` READ ONLY pasa
   también si confirma por señales públicas que el bridge está listo: Polylang
   tiene `es` (vía `pll/v1/languages`) **y** `_pipeline_lang` está registrado en
   REST. Sin credenciales, sin temp drafts. `--go` se queda como gold standard.
2. **Limpiar/regenerar** los 4 artículos ES `qa_failed` + el draft atorado.
3. **Publicar 1 artículo ES limpio** y verificar `/es/`, hreflang, schema, slug.
4. Si OK → `spanish_pipeline_enabled=true` + liberar los 7 `es_hold`.
5. Títulos ES con gancho (ángulo "probé X y esta ganó") per BILINGUAL-PLAN.md.

## Track C — CTR + impresiones

### Hecho esta sesión
- **"Related articles" block** (lib + CLI + workflow + tests). Aplicado a 170/173
  artículos. Internal links → impresiones + dwell. Cron semanal lo mantiene.
- (Track B) Calidad ES → desbloquea el mercado Latam, la mayor palanca de
  impresiones sin tocar EN.

### Ya vivo en el sistema (crons)
Title refresh (CTR, prioritizado por GSC), meta descriptions (100%), schema
backfill (~87% ciclando), FAQ schema, IndexNow, image gen, categorize,
breadcrumbs (schema), citation capsules GEO/AEO en el prompt.

### Backlog priorizado (ideas restantes)
**Alto impacto / bajo esfuerzo**
1. **Activar `/es/`** (flush de permalinks) — palanca #1 de impresiones. *Paso del usuario.*
2. **Byline "Updated [Mes Año]" visible** — señal de frescura (CTR + rankings). Verificado ausente.
3. **Alt text con keyword** en imágenes destacadas — impresiones en Google Images.
4. **Backfill de las 8 imágenes faltantes** + recuperar 11 EN + 1 ES `qa_failed`.
5. **Fix hook internal-links no-op**: el post-publish corre en DRY (sin `--go`) → no aplica. Confirmar si los links vienen de la generación o engancharlo bien.

**Alto impacto / esfuerzo medio**
6. **Página de autor + Person/Organization schema** (E-E-A-T) → rankings + knowledge panel.
7. **Hubs por categoría + pilar "Best AI Tools 2026"** (hub-and-spoke) → impresiones.
8. **Google Indexing API** → indexación más rápida de artículos nuevos.
9. **News-sitemap + Google Discover** (imágenes grandes ✅, frescura, títulos provocativos ✅).
10. **Review stars COMPLIANT**: Review schema por-producto en listicles/comparativas (ratings editoriales), siguiendo la política de Google (no `aggregateRating` falso a nivel página — el código ya lo evita bien).

**Infra / mantenimiento**
11. **Node 20 → 24** en workflows (deprecación 2026-06-16).
12. **Cloudflare** enfrente de Hostinger (CWV + mata cold-starts de raíz). *DNS del usuario.*
13. Aplicar migración `monitor_state` (activa el anti-flap A2).

**Bilingüe (después de validar /es/)**
14. Traducir ganadores ES → gemelos EN (Fase 4 de BILINGUAL-PLAN), por datos GSC.
15. Regenerar los 4 ES `qa_failed` con el prompt mejorado + liberar los 7 `es_hold`.

---

## Track D — CTR + impresiones del ESPAÑOL (goal 2)

Sistema CTR español diseñado por workflow multi-agente (15 agentes, research +
judged) e implementado. Causa raíz: toda la ingeniería de títulos/meta del prompt
estaba en inglés y sangraba a ambos idiomas.

### Hecho + verificado
- **`scripts/lib/spanish-ctr.js`**: `SPANISH_TITLE_BLOCK` (longitud 50-55 char por
  verbosidad ES + truncado píxel móvil ~475px, keyword al frente, números, power
  words Latam, fórmulas por tipo, bans de clickbait/claims falsos per spam-update
  Google oct-2025) + `SPANISH_META_BLOCK` (benefit-first, CTA Latam, 1 emoji máx) +
  `spanishSlugify()`. Inyectado en el outline prompt SOLO cuando es ES.
- **FAQPage rich results ES** (`extractFAQs` ahora matchea "Preguntas frecuentes")
  — backfilleado + verificado en vivo (6 preguntas). Afecta a TODOS los ES.
- **HowTo rich results ES** (`extractHowToSteps` ahora matchea "Paso N").
- **Breadcrumb "Inicio"** (localizado ES).
- **Alt text** keyword-rich en imágenes (localizado vía título ES → Google Imágenes).
- **Slug ES sin acentos** (`spanishSlugify` wireado en la creación del draft).
- (Track C) list-count title repair + related articles (incl. ES) + IndexNow ES ✅.

### Backlog ES CTR (necesita prerequisitos / más esfuerzo)
- **Freshness visible "Actualizado [mes] 2026"**: necesita mecanismo de refresh
  para no quedar stale (sin él es liability). dateModified ya está en schema.
- **Hubs de categoría ES** (/es/comparativas/, /es/resenas/...): prematuro con
  solo 1-2 artículos ES; construir cuando haya contenido ES que agregar.
- **hreflang recíproco EN↔ES**: cuando existan gemelos EN (Fase 4 de BILINGUAL).
- **Refresh tool de títulos/meta ES** (data-driven GSC): bajo valor hoy (1-2 ES,
  sin data GSC ES aún); importa a escala.
- **Calidad de generación de listicles ES** (placeholders): tarea de fondo creada.

## Reglas de ejecución
- Push directo a main, en batches enfocados, validados con `npm run validate`.
- Reportar cada batch al usuario en Discord/respuesta.
- Outward-facing (publicar ES, cambiar títulos live): español es controlado;
  todo lo demás autónomo.
