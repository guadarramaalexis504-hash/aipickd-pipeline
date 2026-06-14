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

## Track C — CTR + impresiones (exhaustivo)

Seguir fases 2-7 de IMPRESSIONS-CTR-ROADMAP.md + ideas nuevas. Se irá expandiendo
en este doc conforme se generen y prioricen ideas. Cada idea = commit enfocado +
verificación. Áreas: categorización, hubs/pilares, E-E-A-T/autor, Discover,
rich results, GSC data-driven, títulos/meta, internal linking, frescura, e
i18n como palanca de impresiones.

---

## Reglas de ejecución
- Push directo a main, en batches enfocados, validados con `npm run validate`.
- Reportar cada batch al usuario en Discord/respuesta.
- Outward-facing (publicar ES, cambiar títulos live): español es controlado;
  todo lo demás autónomo.
