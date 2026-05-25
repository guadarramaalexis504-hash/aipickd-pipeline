# AIPickd Pipeline Improvements — Design Doc

**Fecha:** 2026-05-25
**Status:** Draft (esperando review del user)
**Scope:** Mejoras a pipeline, Discord, y claude-bot pa' prevenir fallos y mejorar calidad de artículos.
**Out of scope:** Cualquier idea de afiliados (esperar hasta que empiecen a caer clics, per user request).

---

## TL;DR

5 categorías de mejoras, 40 ideas total, organizadas por prioridad:

| Prioridad | Cuándo hacerla |
|-----------|----------------|
| **P0** (10 ideas) | Próxima semana — arreglan bugs detectados hoy o previenen re-incidencia |
| **P1** (18 ideas) | Próximo mes — mejoras significativas de calidad/UX |
| **P2** (12 ideas) | Cuando haya tiempo — nice-to-have |

Top 5 P0 picks (si solo haces 5 cosas, haz estas):

1. **Pre-publish render check** — antes de POST a WP, render el HTML local y verifica que no hay fences/dup-H1/empty paras. *Hubiera atrapado el bug de hoy.*
2. **Reemplazar polish step gpt-4o-mini → gpt-4o** — el polish recortando es la raíz del QA short. ~$0.03 más por artículo, vale la pena.
3. **Persistent conversation memory en bot** — el bot pierde context al rebootear. Guardar a Supabase.
4. **Bot rate limiting** — pa' evitar abuse y proteger Anthropic credits.
5. **Citation Capsule en artículos** — H2s con "Key fact" callouts pa' que ChatGPT/Perplexity nos citen (GEO/AEO).

---

## Contexto

Hoy (2026-05-25) detectamos y arreglamos:

1. **HTTP 401 al publicar a WP** — Application Password expirado/invalidado. Solucionado: nuevo password + alert mejorado.
2. **9 artículos qa_failed por contenido corto** — polish step gpt-4o-mini recortaba drafts de 3000w a <1200w. Solucionado: threshold a 1100w + token cap a 12000.
3. **Markdown fences ` ```markdown ` visibles en el body** — `mdToHtml()` no removía las fences que GPT a veces agrega. Solucionado: strip fences en mdToHtml + qualityGate check.
4. **H1 duplicado en cada artículo** — WP renderiza title como `<h1>` + el `# Title` del markdown también se convertía a `<h1>`. Solucionado: drop leading H1.
5. **Rate-limit en script de repair (fix-stale-html)** — User-Agent "bot-shaped" → Hostinger bloqueaba. Solucionado: real Chrome UA + 1.5s throttle.

Estas ideas previenen que vuelvan a pasar, y empujan la calidad un nivel más allá de "no rompe" hacia "rankea + es citado por AI search".

---

## A. Calidad de artículos (10 ideas)

### A1. Reemplazar polish step gpt-4o-mini → gpt-4o-2024-11-20 [P0]

**Problema:** El polish step usa `gpt-4o-mini` que tiende a recortar. Hoy salvamos con threshold loosening + token cap, pero la causa raíz sigue: mini-polish no es confiable pa' "preserve length".

**Idea:** Cambiar a `gpt-4o-2024-11-20` en el polish step. Es más caro (~3x) pero respeta mejor las instrucciones de "MINIMUM output: N words".

**Costo:** +$0.03 por artículo (de $0.10 a $0.13 promedio). En MONTHLY_BUDGET=$50, eso es ~30% más artículos generables → asumiendo el actual pace, eso es ~$10/mes extra.

**Impacto:** HIGH — elimina el "polish trim regression" que es la causa raíz del qa_failed por contenido corto.

**Esfuerzo:** S — 1 línea de código en `scripts/run-pipeline.js:556`.

---

### A2. AI-tells detection avanzado [P0]

**Problema:** El `qualityGate()` actual detecta solo 2 phrases hard (`as an AI`, `as a language model`). El polish prompt borra ~10 phrases más, pero no hay validación que las quitó. Si polish falla, AI-tells pasan a producción.

**Idea:** Expandir `qualityGate()` con detección agresiva post-polish:

```js
const AI_TELLS_BLOCKING = [
  // existentes ✓
  /\b(?:as an AI|I cannot|as a language model|I'm an AI|I am an AI)\b/i,
  // nuevas — bloquear publish si ≥ 3 matches totales
  /\b(?:when it comes to|whether you're|in the world of|when considering)\b/i,
  /\b(?:in today's (?:fast-paced|digital|modern) world|in the realm of)\b/i,
  /\b(?:let'?s dive|let'?s explore|let'?s take a look)\b/i,
  /\b(?:revolutionize|cutting[- ]edge|seamless|game[- ]changer)\b/i,
  /\b(?:harness the power|unlock the (?:full )?potential|delve into)\b/i,
  /\b(?:it'?s (?:important|worth) (?:to note|noting))\b/i,
  /\b(?:landscape|ecosystem)\b/i, // overused tech writing
];
// Count total matches → if ≥ 5, block publish
```

Plus stats-based detection (Perplexity score, sentence length variance, transition word ratio).

**Impacto:** HIGH — la calidad real es el activo más importante del blog.

**Esfuerzo:** M — agregar lógica + tests + maybe LLM-based check (cost $0.005 per article).

---

### A3. Visual rendering preview pre-publish [P0]

**Problema:** Hoy un `\`\`\`markdown ` fence quedó visible en el artículo publicado porque solo validamos el markdown, no el HTML renderizado. Lo mismo pasó con el H1 duplicado.

**Idea:** Después de `mdToHtml()`, antes de POST a WP, hacer render check:

```js
// scripts/lib/html-validator.js (nuevo)
function validateRenderedHtml(html, articleTitle) {
  const issues = [];

  // No bare markdown fences leftover
  if (/```[a-z]*/i.test(html)) issues.push("markdown fence in rendered HTML");

  // Single H1 (or zero — WP adds its own)
  const h1Count = (html.match(/<h1[^>]*>/gi) || []).length;
  if (h1Count > 1) issues.push(`${h1Count} H1 tags (expected 0 or 1)`);

  // No empty paragraphs from broken parsing
  if (/<p>\s*<\/p>/i.test(html)) issues.push("empty <p> tags");

  // Tables have thead AND tbody
  const tables = html.match(/<table[^>]*>[\s\S]*?<\/table>/gi) || [];
  for (const t of tables) {
    if (!/<thead/i.test(t) || !/<tbody/i.test(t)) {
      issues.push("malformed table (missing thead/tbody)");
    }
  }

  // No raw [AFFILIATE:...] tags
  if (/\[AFFILIATE:/i.test(html)) issues.push("unprocessed [AFFILIATE:] tag");

  // Links not pointing to localhost or empty hrefs
  const badLinks = (html.match(/href="(localhost|file:|javascript:|#?)"/gi) || []);
  if (badLinks.length) issues.push(`${badLinks.length} bad links`);

  return issues;
}
```

Si retorna issues → no publish, mark `qa_failed` con razón clara.

**Impacto:** HIGH — *este check hubiera atrapado el bug de hoy.* Defense in depth.

**Esfuerzo:** S — 1 archivo nuevo, ~50 líneas, integración en `publishAllDrafts()`.

---

### A4. SERP intent verification [P1]

**Problema:** El outline asume el intent del keyword config (`commercial/informational/transactional`) pero no verifica que el SERP real coincide. Si el config dice "commercial" pero el SERP es 80% videos, vamos a rankear mal.

**Idea:** Antes de generar outline, scrape Google SERP pa' el keyword (vía DataForSEO API o Bing Web Search API o serpapi):

```js
async function fetchSerpIntent(keyword) {
  // Returns: { topResultTypes: ['article', 'article', 'video', 'product'],
  //            featuredSnippetFormat: 'paragraph' | 'table' | 'list' | null,
  //            peopleAlsoAsk: [...questions],
  //            videoCount: 3, productCount: 1 }
}
```

Ajustar outline:
- Si SERP es mayoritariamente videos → recommend convertir keyword a "video idea" first, no artículo
- Si featured snippet es tabla → asegurar nuestra primera tabla está bien estructurada
- Si PAA tiene 6+ questions → expandir FAQ section a 8+ preguntas

**Impacto:** HIGH pa' rankings (intent-match es el factor #1 de SEO según los Quality Raters guidelines de Google).

**Esfuerzo:** M — API integration ($, ~$5/mes pa' DataForSEO con throttling), parsing logic.

---

### A5. Competitor outline analysis [P2]

**Problema:** Outline genera secciones standard por article_type. No considera qué cubren los #1-3 ranked competitors.

**Idea:** Pa' cada keyword (antes del outline):
1. Scrape top 3 SERP results (puede ser HTML scrape, Cheerio)
2. Extract sus H2s/H3s
3. Pasar al outline prompt: "Competitors cover these sections: [...]. Make sure we cover them PLUS at least 2 unique angles they don't."

**Impacto:** MEDIUM-HIGH pa' rankings (información completitud).

**Esfuerzo:** L — scraping reliability (Google bloquea), parsing of varied page structures, infrastructure pa' guardar competitor analyses.

---

### A6. Original research/data injection [P1]

**Problema:** Prompts dicen "use real data" pero GPT inventa stats. Vimos que el QA actual no detecta esto.

**Idea:** Sistema "research kit" — antes de cada artículo, recolectar data real:

1. **Pricing pages** — scrape `tool.com/pricing` con Playwright (cached 7d).
2. **G2/Capterra summaries** — scrape ratings + top pros/cons.
3. **App store stats** (cuando aplique) — Play Store + iOS download counts.
4. **Reddit threads** — search "site:reddit.com {tool} review" → extract top complaint themes.
5. Inject estos datos en el prompt del draft como `RESEARCH_KIT_JSON`.

```js
// Prompt addition:
`Reference data (use these REAL numbers, do NOT invent stats):
${JSON.stringify(researchKit, null, 2)}

If you reference a number/feature/price that isn't in this kit, prefix with
"As of {month year}, our research shows..." and keep it factual or remove it.`
```

**Impacto:** VERY HIGH — transforma de "AI slop" a "researched content". Mucho mejor pa' E-E-A-T (Google) y citation por AI search.

**Esfuerzo:** L — varias scrapers, caching, error handling, fallbacks cuando una source falla.

---

### A7. Multi-image artículos [P2]

**Problema:** Solo featured image. Artículos sin inline images tienen menor dwell time y peor SEO.

**Idea:** 2-3 inline images por artículo:
- Hero (DALL-E o Unsplash, current).
- Mid-article (Unsplash conceptual).
- Comparison table screenshot (if applicable).

**Impacto:** MEDIUM — UX y dwell time.

**Esfuerzo:** M — coordinar 3 image sources, alt text generation, placement logic.

---

### A8. Audio narration / TTS [P2]

**Problema:** Solo texto. No diversificación de formato.

**Idea:** TTS audio del artículo (Google Gemini TTS Pro, ~$0.02 por artículo de 2000w) embed al inicio.

**Impacto:** LOW pa' SEO directo, MEDIUM pa' UX, HIGH pa' GEO/AEO (ChatGPT cita audio transcripts).

**Esfuerzo:** M — TTS API integration + hosting MP3 (Supabase storage gratis hasta 1GB).

---

### A9. Schema enrichment [P1]

**Problema:** Actualmente solo BlogPosting + FAQPage schemas.

**Idea:** Agregar según article_type:
- **listicle** → `ItemList` schema (cada tool es un ListItem).
- **how-to** → `HowTo` schema (pasos numerados).
- **review** → `Review` schema con rating.
- **comparison** → `ItemList` + `Review` para cada tool.
- Si el artículo embed video → `VideoObject`.

Plus enrichment global:
- `BlogPosting.author` con `Person` schema completo (no solo string).
- `BlogPosting.publisher` con `Organization` + logo URL.
- `BlogPosting.image` con `ImageObject` (no solo URL string).

**Impacto:** MEDIUM-HIGH pa' rich snippets en SERP.

**Esfuerzo:** M — extender `lib/jsonld.js`, validar con Google Rich Results Test API.

---

### A10. Citation Capsule for AI search [P0]

**Problema:** Los artículos no están explícitamente optimizados pa' ser citados por ChatGPT/Perplexity/Google AI Overviews. La estrategia "GEO/AEO" (Generative/Answer Engine Optimization) es el siguiente SEO.

**Idea:** Cada H2 section termina con un "**Key fact**" callout — 1-2 oraciones perfectamente citables, factuales, fechadas:

```markdown
## Pricing breakdown

[... 300 words of pricing analysis ...]

> **Key fact (as of May 2026):** Jasper AI's Boss Mode starts at $59/month
> billed annually, with a 5-day free trial. The Business tier adds SSO and
> custom personas starting at $499/month for 5 seats.
```

Más:
- Schema.org `Quote` markup en estos callouts pa' que crawlers entiendan
- Source citation inline cuando posible
- Date stamps explícitos ("as of {month year}")

Reading: passages bien estructurados así son los que ChatGPT/Perplexity citan. Esto es el SEO del 2026-2027.

**Impacto:** HIGH pa' GEO/AEO + brand mentions en AI search results.

**Esfuerzo:** S — modificar el draft prompt + agregar regex pa' validar que cada H2 tiene un callout.

---

## B. Prevención de fallos (8 ideas)

### B1. Pre-publish HTML validator [P0]

Ver A3 (es la misma idea desde perspectiva de prevención de fallos). Implementación 1, beneficios para 2 categorías.

---

### B2. Idempotency keys pa' WP publish [P1]

**Problema:** El `lib/idempotency.js` existe pero no se usa en el `wp()` client. Si un retry pega 2x al WP, puedes crear posts duplicados.

**Idea:** Antes de POST a `wp-json/wp/v2/posts`, generar key:

```js
const idemKey = sha256(`${article.id}-${contentHash}`).slice(0, 16);
// Search WP for existing post with this idem key in custom field
const existing = await wpReq("GET", `posts?meta_key=aipickd_idem&meta_value=${idemKey}&_fields=id`);
if (existing.length > 0) {
  // Already published — link Supabase article to it
  return existing[0];
}
// POST with the idem key as meta
await wpReq("POST", "posts", { ..., meta: { aipickd_idem: idemKey } });
```

**Impacto:** MEDIUM — previene duplicates en retries.

**Esfuerzo:** S — usar lib existente.

---

### B3. Dead-letter queue activa [P1]

**Problema:** `lib/dlq.js` existe pero `requeue-failed-keywords.js` no parece usarlo. Después de 3 fails consecutivos pa' la misma keyword, está rebote en queue infinitamente.

**Idea:** Después de 3 fails con misma keyword:
1. Insert into `failed_keywords` table con diagnostic completo (last error, full QA issues, timestamps).
2. Remove from `keywords` queue.
3. Discord alert "Keyword X moved to DLQ after 3 fails. Inspect: [URL]".

Sub-feature: workflow `replay-dlq.yml` manual que toma un keyword del DLQ + lo regenera con un override prompt mejorado.

**Impacto:** MEDIUM — mantiene cola limpia, evita ciclos infinitos.

**Esfuerzo:** S — wire up lo que ya existe.

---

### B4. Circuit breakers en todos los HTTP clients [P1]

**Problema:** `lib/circuit-breaker.js` existe. ¿Está aplicado a todos los outbound HTTP calls?
- OpenAI ✓ (en clients.js)
- Anthropic ❓
- Unsplash ❓
- WP REST API ✓ (en clients.js)
- Supabase ❓
- DALL-E ❓
- IndexNow ❓
- Bing/Google sitemap ping ❓

**Idea:** Audit todos los `fetch()` calls. Wrap each external API behind un client en `lib/clients.js` que usa el circuit breaker.

**Impacto:** MEDIUM — si OpenAI tiene un outage de 30 min, el pipeline retries hasta gastar timeout budget. Circuit breaker fast-fails después del 5to fallo.

**Esfuerzo:** M — refactor de fetches dispersos.

---

### B5. Healthchecks granulares [P1]

**Problema:** `healthchecks.io` heartbeat solo se ping al final del run. Si el job se atasca en outline, no sabemos en qué step.

**Idea:** Ping diferentes endpoints per-step:
- `HEALTHCHECK_GENERATE_OUTLINE`
- `HEALTHCHECK_GENERATE_DRAFT`
- `HEALTHCHECK_PUBLISH_WP`
- `HEALTHCHECK_POST_PROCESS`

Cada uno con timeout adecuado al step. Si falta el ping, healthchecks.io alerta a Discord.

**Impacto:** MEDIUM — observability mejor pa' debug.

**Esfuerzo:** S — agregar `ping(name)` calls en el script.

---

### B6. Alert deduplication multi-window [P2]

**Problema:** Actual dedup es 60s. Si la misma alert se manda 24 veces en una semana (1/hora), 23 pasan.

**Idea:** Multi-window dedup:
- Same alert in 60s → silent suppress (current).
- Same alert ≥ 3 times in 7 days → group into "Sistema reporta X 3 veces esta semana. Posible problema sistémico" (super-alert), suppress originals.

Backed by Supabase table `alert_history` para tracking.

**Impacto:** LOW — UX (menos noise).

**Esfuerzo:** M — table + logic + tests.

---

### B7. Smart retry de qa_failed con prompt rescue [P1]

**Problema:** Cuando un keyword qa_failed por short content, requeue lo manda con el mismo prompt → probable que falle igual.

**Idea:** En `keywords` table agregar `retry_count` + `last_qa_issue`. Cuando count > 0, el draft prompt incluye:

```
This is RETRY ATTEMPT #{retry_count} for keyword "{keyword}".
Previous attempt failed QA: {last_qa_issue}.
This time, generate AT LEAST 30% above target word count.
Be more thorough in every section. Add examples, comparisons, sub-points.
```

**Impacto:** MEDIUM — recupera más keywords sin intervención manual.

**Esfuerzo:** S — prompt + Supabase column.

---

### B8. WP_PASSWORD expiration tracking [P1]

**Problema:** `wp-password-rotation-reminder.yml` es solo quarterly issue. Si el password expira fuera de ciclo (WP plugin update, manual revoke), nos pega cuando todo el pipeline ya está dependiendo.

**Idea:**
- Track `WP_PASSWORD_ROTATED_AT` como GitHub Secret (timestamp).
- Daily script `password-age-check.js` calcula days_since.
- Discord alerts:
  - 60 días → info "Password tiene 60d, rotation recommended en 30d"
  - 80 días → warning "Password tiene 80d, rotation overdue"
  - 90 días → critical "Rotate WP password NOW"

Plus: si publish falla con 401, el alert automáticamente sugiere rotation (ya hicimos esto hoy).

**Impacto:** LOW — previene sorpresas, no urgente.

**Esfuerzo:** S — script + workflow + secret.

---

## C. Discord (7 ideas)

### C1. Canal #drafts-review (opcional, P2) [P2]

**Problema:** Drafts solo se ven en Supabase. Si quisieras human approval antes de publish, no hay UI.

**Idea:** Nuevo webhook `DISCORD_WEBHOOK_DRAFTS`. Cuando un draft pasa QA pero antes de WP POST, opcional notify:
- Title + meta preview
- Word count, quality score
- Botones interactivos: ✅ Publish | 🔄 Regenerate | ❌ Reject

**Impacto:** Variable — depende si quieres human-in-the-loop. Va contra el goal de "100% autónomo" pero útil pa' primeras semanas después de cambios al prompt.

**Esfuerzo:** M — Discord interactivos requieren `application command` o slash button, no webhook simple.

---

### C2. Canal #seo-rankings [P1]

**Idea:** Daily digest 9am via cron:
- Top 10 keywords by GSC impressions (last 7d)
- Movers: keywords que subieron/bajaron >5 positions this week
- New keywords ranking (top 100) que no estaban hace 7d

Pulls data from Google Search Console API.

**Impacto:** HIGH — visibility de qué funciona pa' iterar la estrategia.

**Esfuerzo:** M — GSC API auth + queries + Discord embeds.

---

### C3. Canal #costs [P1]

**Idea:** Granular cost tracking. Cada artículo published agrega línea con su cost. Daily ASCII bar chart embed con spend ($/$50).

```
Day 1: ████████░░ $4.20 / $50  (8.4%)
Day 2: ███████░░░ $3.80 / $50  (16.0%)
...
```

**Impacto:** MEDIUM — financial transparency.

**Esfuerzo:** S — reading from existing `articles.generation_cost_usd` column.

---

### C4. Rich embeds with thumbnails [P2]

**Problema:** `notify.js` ya tiene rich embeds pero podría ser más visual.

**Idea:** En `notifyArticle()`, agregar:
- Thumbnail con la featured image del artículo
- Inline progress bar pa' quality score
- Color coding (verde >85, amarillo >70, rojo <70)

**Impacto:** LOW — UX.

**Esfuerzo:** S — extender el embed payload.

---

### C5. Slash commands [P1]

**Problema:** Bot solo responde a @mention o keyword channels. Slash commands son UX dramática mejora.

**Idea:** Registrar:
- `/status` → pipeline status (replaces text)
- `/generate keyword:"X" type:"comparison"` → trigger workflow
- `/audit slug:"X"` → quality audit del artículo
- `/republish slug:"X"` → re-render HTML
- `/pause` / `/resume` → kill switch
- `/cost period:"month"` → cost breakdown
- `/articles count:5` → últimos N artículos

Auto-complete pa' parameters via Discord application commands API.

**Impacto:** HIGH — mucho mejor UX que mensajes en lenguaje natural pa' tasks frequentes.

**Esfuerzo:** M — Discord.js soporta slash commands nativamente; ~1h de implementación.

---

### C6. Auto-thread on alerts [P1]

**Problema:** Cuando algo falla, vas a `#alertas`, lees el error, scrollea history pa' context, vuelves a desktop. Workflow lento.

**Idea:** Bot detecta cuando un alert es critical/high y auto-crea un Discord thread con:
- Full stack trace del run logs (via GitHub API)
- Last 3 successful runs context
- "Suggested fix" generated by Claude (system prompt: "You are AIPickd's reliability engineer...")
- Link a workflow re-run

Permite Slack-style debugging conversation in-thread.

**Impacto:** HIGH pa' fast debug. Lo que tomó 30 min hoy podría ser 5 min con un good thread.

**Esfuerzo:** M — bot extends + GitHub API + Anthropic call.

---

### C7. Pinned dashboard message [P1]

**Idea:** Canal `#dashboard` (o `#pipeline-status`) con UN pinned message que se actualiza cada hora via webhook edit:

```
🚦 AIPickd Status — Updated 2026-05-25 15:00 UTC
─────────────────────────────────────────
Pipeline:      🟢 Healthy (last run: 35 min ago)
Articles 24h:  12 published, 0 failed
Articles 7d:   42 published, 2 in DLQ
Cost MTD:      $3.63 / $50 (7.3%) ███░░░░░░░
Drafts:        0 pending, 0 stuck >24h
Keywords:      184 queued, 0 stuck
Last alert:    INFO "Nicho concentration" — 2h ago
─────────────────────────────────────────
Next cron run: 19:00 UTC (in 3h 25m)
```

Mucho mejor que rastrear con scroll history.

**Impacto:** HIGH — visibility instantánea de estado.

**Esfuerzo:** M — webhook edit API + scheduled update + state aggregation.

---

## D. Claude-bot (9 ideas)

### D1. Persistent conversation memory [P0]

**Problema:** `history` está en `Map` memory. Reboot del Railway service → bot olvida toda la conversación.

**Idea:** Tabla `bot_conversations` en Supabase:
```sql
CREATE TABLE bot_conversations (
  channel_id TEXT PRIMARY KEY,
  messages JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

En `askClaude()`:
1. Load history from DB on first message per channel.
2. After each message, upsert.
3. TTL implícito: garbage collect entries > 7d old.

**Impacto:** HIGH — UX (no recordar context cada reboot).

**Esfuerzo:** S — migration + 2 supabase calls.

---

### D2. Rate limiting anti-abuse [P0]

**Problema:** Bot no tiene rate limiting. Si alguien spammea, los Anthropic credits se queman.

**Idea:** Sliding window per-user:
- 30 mensajes/hora per user.
- 100 mensajes/hora per channel.
- Si user excede: respond "🐢 Aguanta manito, ya respondiste mucho. Espera 5 min."
- Track in memory (no need de Supabase pa' rate limits).

**Impacto:** HIGH — cost protection.

**Esfuerzo:** S — sliding window map + check antes del Anthropic call.

---

### D3. Nuevas tools para el bot [P0-P1]

**Problema:** El bot tiene 10 tools pero hoy hicimos cosas que no podía:
- Auditar un artículo específico
- Re-renderizar 1 artículo
- Disparar fix-stale-html.yml
- Pausar el pipeline
- Ver alertas recientes

**Idea:** Agregar tools:

```js
{ name: 'audit_article', schema: { slug: string } }  // P0
// Corre content-quality-check.js para 1 slug, devuelve issues

{ name: 'republish_article', schema: { slug: string } }  // P0
// Trigger fix-stale-html.yml con --slug

{ name: 'dispatch_workflow', schema: { name: string, inputs?: object } }  // P1
// Genérico — dispatch cualquier workflow

{ name: 'get_recent_alerts', schema: { hours: number } }  // P1
// Fetch alertas desde Supabase alert_history table (necesita B6)

{ name: 'pause_pipeline', schema: { reason: string } }  // P0
{ name: 'resume_pipeline', schema: {} }  // P0
// Escribir flag pipeline_paused en Supabase config table
// run-pipeline.js checks this flag at start, aborts if true

{ name: 'regenerate_article', schema: { slug: string, reason: string } }  // P1
// Mark article como qa_failed + requeue keyword con retry_count incrementado

{ name: 'cost_breakdown', schema: { period: 'day' | 'week' | 'month' } }  // P1
// Cost by article type / niche, top expensive articles

{ name: 'search_articles', schema: { query: string } }  // P1
// Fuzzy search en Supabase (Postgres full-text search)
```

**Impacto:** HIGH — convierte el bot de "info-only" a "operations-from-mobile".

**Esfuerzo:** M — 8 nuevas tools, ~1 día de implementación.

---

### D4. Bot persona (mexicano casual con "manito") [P2]

**Idea:** El system prompt ya pide "español mexicano casual". Reforzar con few-shot examples:
- Usuario: "como va el pipeline?"
- Bot: "Va tranquilo manito. 12 artículos hoy, $3.63 gastados de $50. Siguiente run en 2h."

Plus: variar greetings, no siempre "manito" (que aburre). "we", "buey", "carnal", etc. (matching la diversidad del user).

**Impacto:** LOW — UX delight.

**Esfuerzo:** S — prompt engineering.

---

### D5. Auto-thread sugerido en conversaciones largas [P1]

**Problema:** Si una conversa lleva 15+ mensajes en un canal compartido, inunda otros temas.

**Idea:** Después del mensaje 10 con el mismo user en 30 min, bot sugiere: "Esta conversa está creciendo — ¿hago un thread pa' continuar aquí?"

**Impacto:** LOW — UX.

**Esfuerzo:** S — counter + sugar.

---

### D6. Voice command support [P2]

**Idea:** Si Alexis manda audio note al bot:
1. Discord audio attachment → download.
2. OpenAI Whisper transcription ($0.006/min).
3. Tratar el transcript como mensaje normal.

**Impacto:** LOW pero diferenciador.

**Esfuerzo:** M — audio handling + Whisper.

---

### D7. Proactive bot alerts [P1]

**Problema:** Bot solo responde. Información valiosa solo si Alexis pregunta.

**Idea:** Bot polls cada hora:
- Si monthly cost > 65% → DM Alexis "Heads up, gastamos 65% del budget mensual"
- Si pipeline > 8h sin publicar → mensaje en `#pipeline-status` "Hace 8h no publica, ¿checo el último cron?"
- Si nuevo high-traffic article (GSC) → "El artículo X tiene 100+ impresiones en GSC hoy, considera meter más interlinks"

**Impacto:** MEDIUM — proactividad útil.

**Esfuerzo:** M — cron job + polling logic.

---

### D8. Multi-language [P2]

**Idea:** Si el user habla en inglés (mid-convo switch), bot detecta y responde en inglés.

**Impacto:** LOW.

**Esfuerzo:** S — detection via langdetect lib o regex simple.

---

### D9. Bot channel-aware tone [P1]

**Idea:** Bot ajusta tono según canal:
- `#general` → casual "va manito", emojis
- `#pipeline-status` → directo, métricas first
- `#alertas` → urgente, action items

**Impacto:** LOW — UX.

**Esfuerzo:** S — switch en system prompt según channel.name.

---

## E. Observability (6 ideas)

### E1. Dashboard channel pinned message [P1]

Ver C7 (misma idea).

---

### E2. Google Search Console integration [P1]

**Problema:** No hay tracking de SEO performance.

**Idea:** GSC API integration:
- Service account auth (free tier).
- Daily pull de impressions/clicks/position per page.
- Save to Supabase table `gsc_metrics`.
- Discord weekly digest "Top 10 by impressions" en `#seo-rankings`.

**Impacto:** HIGH — visibility de qué keywords/artículos ganan tráfico real.

**Esfuerzo:** M — GSC API auth + cron + DB schema.

---

### E3. AI Citation tracking [P0]

**Problema:** No sabemos si AI search engines (ChatGPT, Perplexity, AI Overviews) están citando aipickd.com.

**Idea:** Weekly script:
1. Query Perplexity API: "best AI tools for video editing", "best AI writing tools 2026", etc. (top 20 keywords).
2. Check si `aipickd.com` appears en `sources[]`.
3. Track count over time en `ai_citations` table.
4. Discord weekly report: "AIPickd.com citado X veces en Perplexity esta semana (vs Y semana pasada)".

ChatGPT no tiene API search citations en plus tier ($20/mes), pero ChatGPT plus + browse podría manual checkearse weekly.

**Impacto:** HIGH — métrica clave del GEO/AEO success.

**Esfuerzo:** S — Perplexity API ($5/mes paid plan) + script + cron.

---

### E4. Core Web Vitals tracking [P1]

**Problema:** No tracking de UX performance real (field data).

**Idea:** Google CrUX API integration:
- Pull weekly CWV per artículo (LCP, INP, CLS).
- Discord alert si regression (LCP > 2.5s, INP > 200ms, CLS > 0.1).
- Especial focus en INP que es el más volátil.

**Impacto:** MEDIUM — Google usa CWV como ranking factor.

**Esfuerzo:** S — CrUX API (free) + cron.

---

### E5. Page-level analytics [P2]

**Idea:** Cuando empiecen clicks (out of scope pa' ahora per user), agregar:
- Plausible o Google Analytics 4
- Track per-page metrics: views, time on page, scroll depth, bounce rate
- Discord weekly "Top engaged articles"

**Out of scope** pa' ahora.

---

### E6. Anomaly detector v2 con baseline learning [P1]

**Problema:** `anomaly-detector.js` actual usa hardcoded thresholds (e.g., word_count < 800, cost > $0.20). Si el sistema cambia (e.g., bajamos prompt target), los thresholds quedan obsoletos.

**Idea:** Baseline learning:
- Compute weekly histograms of metrics (word_count P50/P90, cost P50/P90, articles/day P50).
- Alert si current is > 2 std dev from baseline.
- Auto-adjust thresholds as system evolves.

**Impacto:** MEDIUM — alerts adaptativos vs hardcoded staleness.

**Esfuerzo:** M — stats computation + DB tables for baselines.

---

## Roadmap sugerido

Si tuvieras que escoger orden de implementación:

### Semana 1 (esta semana o la próxima)
- **P0**: A1 (polish model upgrade) — quick win, big impact
- **P0**: A3/B1 (pre-publish HTML validator) — previene exactly el bug de hoy
- **P0**: D1 (persistent memory) — bot no olvida context
- **P0**: D2 (rate limit) — cost protection
- **P0**: D3 partial (audit_article + republish_article tools) — operations from mobile

Estimated effort: ~12-16h de implementación.

### Semana 2
- **P0**: A10 (Citation Capsule) — future-proof GEO/AEO
- **P0**: A2 (AI-tells avanzado) — calidad
- **P0**: E3 (AI citation tracking) — visibility de GEO success
- **P1**: C5 (slash commands) — UX
- **P1**: C7 (pinned dashboard) — visibility

### Mes 2
- **P1**: A4 (SERP intent verify) — rankings boost
- **P1**: A6 (research kit) — calidad transformacional
- **P1**: C2 (#seo-rankings channel) — GSC integration
- **P1**: C6 (auto-thread on alerts) — debug speed
- **P1**: D7 (proactive alerts) — bot inteligencia

### Backlog (cuando haya tiempo)
- A5, A7, A8, A9 — calidad nice-to-have
- B6 — alert dedup multi-window
- C1, C4 — Discord polish
- D4-D9 — bot polish
- E5 — analytics (espera affiliates clicks)

---

## Anti-patterns que NO quiero implementar

- **Más automation en cascada** — el sistema ya tiene 27 workflows. Cada uno es debt. Si alguna idea aquí requiere "y otro workflow", reconsiderar.
- **Auto-respuesta del bot en cada canal** — tentador pero molesto. Mantener trigger explícito (@mention o keyword channels).
- **Sacrificio de cost por features marginales** — el budget $50/mes es duro. Cada idea que sume costo debe pasar test "vale la pena?".
- **Over-engineering pre-revenue** — no hay clicks aún. Algunas ideas (E5) deben esperar hasta tener data real de conversion.

---

## Costos extras estimados (mensual)

Si implementamos todos los P0 + top P1:

| Item | Costo/mes |
|------|-----------|
| A1: gpt-4o polish (vs mini) | +$10 |
| A6: Research kit (Playwright + caching) | +$0 (CI minutes) |
| A10: Citation Capsule | $0 (prompt only) |
| E3: Perplexity API | +$5 |
| E2: GSC API | $0 (free) |
| E4: CrUX API | $0 (free) |
| C2: GSC enrichment | $0 |
| Discord bot Anthropic costs (opus 4.5) | actual: ~$2/mes |
| **Total extra:** | **+$15/mes** |

Total estimated MONTHLY budget post-improvements: ~$65/mes (vs current $50 cap). Need to raise cap o reduce gen volume.

---

## Next steps

Cuando vuelvas, manito:

1. **Review este doc** — pick los P0 que quieres atacar primero.
2. **Pa' los que aprobes** → invoco `writing-plans` pa' generar implementation plan detallado del primero.
3. **Implementación gradual** — un PR pequeño a la vez, no big-bang.

Si quieres que yo escoja por ti (default mode): voy con los 5 top P0 listados al inicio del doc (polish upgrade + HTML validator + bot memory + rate limit + Citation Capsule).

Lo que sigue es escoger orden, no preocuparte por todas las 40. **Pickea 3-5, las hacemos, vemos impact, luego siguiente batch.** 🦖
