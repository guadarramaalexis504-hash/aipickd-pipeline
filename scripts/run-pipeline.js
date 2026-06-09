#!/usr/bin/env node
/**
 * AIPickd — Unified autonomous pipeline
 *
 * What it does each run:
 *   1. Check Anthropic credits — if available, prefer Bridge mode (Claude+GPT)
 *   2. Otherwise, GPT-only mode (gpt-4o generate + gpt-4o-mini polish)
 *   3. Generate ONE new article from the next queued keyword → saves to Supabase as draft
 *   4. Publish ALL unpublished drafts in Supabase → WordPress (as draft or publish per AUTO_PUBLISH env)
 *   5. Log totals + cost estimate
 *
 * Designed to be run by Windows Task Scheduler every ~4 hours.
 * Idempotent — if there's nothing to do, it exits cleanly.
 *
 * Usage:
 *   node scripts/run-pipeline.js            # normal run (gen 1 + publish all)
 *   node scripts/run-pipeline.js --gen 3    # generate 3 articles then publish
 *   node scripts/run-pipeline.js --no-gen   # skip generation, just publish
 *   node scripts/run-pipeline.js --no-pub   # generate but don't publish
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("node:child_process");
const { notify, notifyArticle, notifyPipeline, notifyAlert, calcQualityScore } = require("./notify.js");
const { loadEnv } = require("./lib/env");
const { fetchWithRetry } = require("./lib/http");
const { publishKey: idempotencyPublishKey } = require("./lib/idempotency");
const { validateRenderedHtml } = require("./lib/html-validator");
const { ping: hcPing } = require("./lib/heartbeat");
const { warmUp } = require("./lib/warmup");
const { buildSchemas, renderSchemaBlock, NICHE_TO_CATEGORY_SLUG } = require("./lib/schema");
const { filterPipelineKeywords, keywordStateForArticle, normalizeLanguage } = require("./lib/spanish-gate");

/**
 * Granular healthcheck — pings a per-step HEALTHCHECK_URL_<STEP> if
 * configured. Lets us see in healthchecks.io WHICH stage the pipeline
 * got far enough to ping, narrowing diagnosis when a cron run dies
 * silently mid-flight. Fire-and-forget: heartbeat failures don't
 * block the pipeline.
 *
 * Set these in GitHub Secrets to enable (each is OPTIONAL — missing
 * vars just skip the ping for that step):
 *   HEALTHCHECK_URL_PIPELINE_OUTLINE     — set after outline JSON is parsed
 *   HEALTHCHECK_URL_PIPELINE_DRAFT       — set after draft text returned
 *   HEALTHCHECK_URL_PIPELINE_POLISH      — set after polish step
 *   HEALTHCHECK_URL_PIPELINE_PUBLISH     — set after publishAllDrafts loop
 *   HEALTHCHECK_URL_PIPELINE_POSTSTEPS   — set after internal-links etc
 */
async function hcStep(stepName, opts = {}) {
  try {
    await hcPing(`PIPELINE_${stepName}`, opts);
  } catch (_) {
    // never block on heartbeat failures
  }
}

const env = loadEnv();

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ANTHROPIC_API_KEY,
  OPENAI_API_KEY,
  WP_USERNAME,
  WP_ADMIN_PASSWORD,
  AUTO_PUBLISH,
  MAX_AI_COST_PER_DAY_USD,
} = env;

const WP_STATUS = (AUTO_PUBLISH || "false").toLowerCase() === "true" ? "publish" : "draft";
const DAILY_BUDGET = parseFloat(MAX_AI_COST_PER_DAY_USD || "10");

// Parse args
const args = process.argv.slice(2);
const GEN_COUNT = parseInt(args[args.indexOf("--gen") + 1]) || (args.includes("--no-gen") ? 0 : 1);
const DO_PUBLISH = !args.includes("--no-pub");
const INCLUDE_ES = args.includes("--include-es");
let spanishPipelineEnabled = false;

// --- helpers ---
// Columns the pipeline writes that the production schema doesn't have yet.
// On a 42703 "column does not exist", supa() strips matching keys and retries
// once instead of failing the whole publish (which previously left WP posts
// orphaned with the article still marked draft in Supabase).
const OPTIONAL_COLUMNS = new Set([
  "idempotency_key",
  "quality_score",
  "qa_issues",
  "last_error",
  "last_error_at",
  "retry_count",
  "last_qa_at",
  "repair_status",
  "repair_notes",
  "last_publish_error",
  "language",
]);

async function supa(method, endpoint, body) {
  const doRequest = async (payload) => {
    const res = await fetchWithRetry(
      `${SUPABASE_URL}/rest/v1/${endpoint}`,
      {
        method,
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: payload ? JSON.stringify(payload) : undefined,
      },
      { timeout: 30000, retries: 3 }
    );
    const text = await res.text();
    return { res, text };
  };

  let { res, text } = await doRequest(body);

  // Missing-column errors come in two shapes:
  //   - 42703 (Postgres "undefined_column" when the query reaches PG)
  //   - PGRST204 ("Could not find the 'X' column ... in the schema cache",
  //     emitted by PostgREST before the query is sent)
  // Strip ALL optional columns we know about and retry once.
  const isMissingColumn = !res.ok && (text.includes("42703") || text.includes("PGRST204"));
  if (isMissingColumn && body && typeof body === "object" && !Array.isArray(body)) {
    const matchPg   = text.match(/column ['"]?[\w.]+\.([\w]+)['"]? does not exist/i);
    const matchRest = text.match(/Could not find the ['"]([\w]+)['"] column/i);
    const missingCol = (matchPg && matchPg[1]) || (matchRest && matchRest[1]);
    if (missingCol && OPTIONAL_COLUMNS.has(missingCol) && missingCol in body) {
      console.log(`   ℹ️  supa: column "${missingCol}" missing — retrying without optional columns`);
      const trimmed = { ...body };
      for (const k of OPTIONAL_COLUMNS) delete trimmed[k];
      ({ res, text } = await doRequest(trimmed));
    }
  }

  if (!res.ok) throw new Error(`Supabase ${method} ${endpoint}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// Cap max_tokens. 16000 was wildly over-provisioned, but 8000 turned out to
// be too tight for the polish step on 3000+ word drafts (input ~4000 tokens
// + the model needs headroom to rewrite without truncating). 12000 keeps
// faster responses than the original 16000 while leaving polish room to
// preserve length on long articles. Caller's request still wins if smaller.
const GPT_MAX_TOKENS_CAP = 12000;
const GPT_ATTEMPT_TIMEOUT_MS = 90_000; // per-attempt — was 180s
const GPT_MAX_RETRIES = 2;             // was 3 — third retry rarely succeeds within timeout budget

// Set per-generation by generateOne to force the article language. Prepended to
// EVERY gpt() system prompt so the whole pipeline (outline, draft, polish, FAQ,
// titles) writes in the target language. "" = English (default, unchanged).
let GEN_LANG_DIRECTIVE = "";

async function gpt(model, system, user, maxTokens, jsonMode = false) {
  const body = {
    model,
    max_tokens: Math.min(maxTokens || GPT_MAX_TOKENS_CAP, GPT_MAX_TOKENS_CAP),
    messages: [
      { role: "system", content: GEN_LANG_DIRECTIVE + system },
      { role: "user", content: user },
    ],
  };
  if (jsonMode) body.response_format = { type: "json_object" };
  const attempt = async () => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), GPT_ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`GPT ${model}: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
      return { text: data.choices[0].message.content, usage: data.usage };
    } finally {
      clearTimeout(to);
    }
  };
  for (let i = 0; i <= GPT_MAX_RETRIES; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (i === GPT_MAX_RETRIES) throw e;
      console.log(`   (retry ${i + 1}/${GPT_MAX_RETRIES}: ${e.message.slice(0, 80)})`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

async function wp(method, endpoint, body) {
  const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");
  // Real browser UA + standard headers to bypass Hostinger/LiteSpeed 429 rate limits on bot UAs
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const attempt = async () => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          "User-Agent": UA,
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`WP ${method} ${endpoint}: ${res.status} ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(to);
    }
  };
  // 3 attempts (was 5). Auth/4xx failures don't recover with more retries;
  // network/5xx/429 backed off with sane delays still recovers within budget.
  for (let i = 0; i < 3; i++) {
    try {
      return await attempt();
    } catch (e) {
      // Don't retry auth failures — they're config errors, not transient
      if (e.status === 401 || e.status === 403) throw e;
      if (i === 2) throw e;
      // Longer backoff for 429 (rate limit) — Hostinger may need 10-30s to clear
      const isRateLimit = e.status === 429;
      const baseWait = isRateLimit ? 10000 : 2000;
      await new Promise((r) => setTimeout(r, baseWait * (i + 1)));
    }
  }
}

// Generate Table of Contents from markdown headings
function generateToC(md) {
  const headings = [];
  const headingRegex = /^(#{2,3})\s+(.+)$/gm;
  let m;
  while ((m = headingRegex.exec(md)) !== null) {
    const level = m[1].length;
    const text = m[2].trim().replace(/\*\*/g, "").replace(/`/g, "");
    const anchor = text.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-");
    // Skip FAQ, Key Takeaways, Quick Verdict from ToC
    if (/^(faq|frequently asked|key takeaways|quick verdict|quick picks)/i.test(text)) {
      headings.push({ level, text, anchor, skip: true });
    } else {
      headings.push({ level, text, anchor, skip: false });
    }
  }
  const tocHeadings = headings.filter(h => !h.skip);
  if (tocHeadings.length < 5) return ""; // Only add ToC if 5+ headings
  const items = tocHeadings.map(h => {
    const indent = h.level === 3 ? "  " : "";
    return `${indent}- [${h.text}](#${h.anchor})`;
  }).join("\n");
  return `\n\n**📋 Table of Contents**\n\n${items}\n\n---\n\n`;
}

// Inject ToC after first heading and Quick Verdict block
function injectToC(md) {
  const wordCount = md.split(/\s+/).length;
  if (wordCount < 1500) return md; // Only for long articles
  const toc = generateToC(md);
  if (!toc) return md;
  // Insert after the first H1, after Quick Verdict blockquote and Key Takeaways if present
  // Find insertion point: after the first major block (blockquote / Key Takeaways / first paragraph)
  const insertAfterPatterns = [
    /(\*\*Key Takeaways\*\*[\s\S]*?\n\n)/, // After Key Takeaways block
    /(> \*\*Quick Verdict\*\*[\s\S]*?\n\n)/, // After Quick Verdict blockquote
    /(^# .+\n\n)/, // After H1 title
  ];
  for (const pattern of insertAfterPatterns) {
    const match = md.match(pattern);
    if (match) {
      const insertPos = md.indexOf(match[0]) + match[0].length;
      // Only insert if there's no ToC already
      if (!md.includes("📋 Table of Contents")) {
        return md.slice(0, insertPos) + toc + md.slice(insertPos);
      }
      return md;
    }
  }
  return md;
}

// Simple MD→HTML (same as publish-one-article.js)
function mdToHtml(md) {
  md = (md || "").replace(/<!--[\s\S]*?-->/g, "");

  // ── Strip stray code fences left over from GPT responses ─────────────
  // GPT-4o regularly wraps the entire article in ```markdown ... ``` or
  // ```...``` even when explicitly told not to. Those fences must NOT
  // appear in the rendered HTML — they render as literal text in the
  // article body (the "`markdown" we saw in best-ai-tools-for-video-
  // editing-2026 was exactly this). Strip them aggressively before any
  // other parsing runs.
  md = md.trim();
  md = md.replace(/^```[a-zA-Z]*\s*\n/, "");
  md = md.replace(/\n?```\s*$/, "");
  // Belt-and-suspenders: also kill any stray fence-only lines mid-doc.
  md = md.replace(/^```[a-zA-Z]*\s*$/gm, "");

  // ── Drop the first H1 if present ─────────────────────────────────────
  // WordPress already renders the post title as <h1>, so a leading "# Title"
  // creates a duplicate heading — visually redundant and Google flags it as
  // a multi-H1 issue. We only drop the FIRST H1; any later H1 (rare but
  // possible in long-form) is kept so we don't silently delete content.
  md = md.replace(/^#\s+.+\n+/, "");

  let html = md;
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*([^\*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^\*]+)\*/g, "<em>$1</em>");
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" rel="nofollow sponsored" target="_blank">$1</a>'
  );
  html = html.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>\n${m}</ul>\n`);
  html = html.replace(
    /(\|.+\|\n\|[\s\-\|:]+\|\n(?:\|.+\|\n?)+)/g,
    (m) => {
      const lines = m.trim().split("\n");
      const header = lines[0].split("|").slice(1, -1).map((c) => c.trim());
      const rows = lines.slice(2).map((l) =>
        l.split("|").slice(1, -1).map((c) => c.trim())
      );
      const thead = `<thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
      return `<table class="wp-block-table">${thead}${tbody}</table>`;
    }
  );
  html = html
    .split("\n\n")
    .map((block) => {
      const t = block.trim();
      if (!t) return "";
      if (/^<(h[1-6]|ul|ol|blockquote|table|pre|div)/i.test(t)) return t;
      return `<p>${t}</p>`;
    })
    .join("\n\n");
  return html;
}

// GPT cost estimates (per million tokens, April 2026 pricing)
const COSTS = {
  "gpt-4o-2024-11-20": { in: 2.5, out: 10 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
};

function estimateCost(model, usage) {
  const c = COSTS[model] || { in: 1, out: 3 };
  return (usage.prompt_tokens * c.in + usage.completion_tokens * c.out) / 1e6;
}

// --- Generation (GPT-only, proven working) ---
async function generateOne() {
  // Smart niche rotation — check what niches were generated in the last 24h
  // If a niche produced 3+ articles today, deprioritize its keywords
  const today = new Date().toISOString().slice(0, 10);
  let overloadedNicheIds = new Set();
  try {
    const todayArts = await supa("GET", `articles?created_at=gte.${today}&select=niche_id`);
    const nicheCounts = {};
    for (const a of (todayArts || [])) {
      nicheCounts[a.niche_id] = (nicheCounts[a.niche_id] || 0) + 1;
    }
    overloadedNicheIds = new Set(
      Object.entries(nicheCounts).filter(([, c]) => c >= 3).map(([id]) => id)
    );
    if (overloadedNicheIds.size > 0) {
      console.log(`   🔄 Niche rotation: avoiding overloaded niches today (${overloadedNicheIds.size} niches with 3+ articles)`);
    }
  } catch {}

  // Fetch top 5 queued keywords — sorted by priority DESC, then search_volume DESC
  const rawKeywords = await supa(
    "GET",
    "keywords?status=eq.queued&assigned_article_id=is.null&order=priority.desc,search_volume.desc&limit=50&select=*,niche:niches(slug,name)"
  );
  const keywords = filterPipelineKeywords(rawKeywords || [], {
    includeEs: INCLUDE_ES,
    spanishPipelineEnabled,
  });
  if (!keywords || keywords.length === 0) {
    return { skipped: true, reason: "No queued keywords after language gate" };
  }
  // (sortedKeywords is built below after overload check)

  // Per-keyword failure guard: skip keywords that have already failed 3+ times
  // Also apply smart niche rotation: prefer keywords from non-overloaded niches
  let kw = null;
  // Sort so non-overloaded niches come first, then overloaded (fallback)
  const sortedKeywords = [...(keywords || [])].sort((a, b) => {
    const aOverloaded = overloadedNicheIds.has(a.niche_id) ? 1 : 0;
    const bOverloaded = overloadedNicheIds.has(b.niche_id) ? 1 : 0;
    return aOverloaded - bOverloaded; // non-overloaded first
  });
  for (const candidate of sortedKeywords) {
    const failedRows = await supa("GET", `articles?keyword_id=eq.${candidate.id}&status=eq.qa_failed&select=id`).catch(() => []);
    const failCount = Array.isArray(failedRows) ? failedRows.length : 0;
    if (failCount >= 3) {
      console.log(`   ⏭️  Skip "${candidate.keyword}" — already failed QA ${failCount}× (marking exhausted)`);
      await supa("PATCH", `keywords?id=eq.${candidate.id}`, { status: "qa_failed" }).catch(() => {});
      continue;
    }
    if (failCount > 0) {
      console.log(`   ⚠️  "${candidate.keyword}" failed QA ${failCount}× before — attempting again with extra effort`);
    }
    kw = candidate;
    break;
  }
  if (!kw) {
    return { skipped: true, reason: "All top-5 keywords are exhausted (3+ failures each)" };
  }

  console.log(`${ts()} 📝 Keyword: "${kw.keyword}" (${kw.niche?.name})`);

  // ── Language: force Spanish (/es/) generation when the keyword is es ──────
  const LANG = normalizeLanguage(kw.language);
  const ES = LANG === "es";
  GEN_LANG_DIRECTIVE = ES
    ? `🌎 IDIOMA OBLIGATORIO — Escribe ABSOLUTAMENTE TODO en ESPAÑOL DE MÉXICO natural (usa "tú", nunca "usted"), para una audiencia de Latinoamérica. Título, slug, encabezados, cuerpo, tablas, FAQ, "Veredicto rápido", "Puntos clave", cada "Dato clave", y la meta description: TODO en español. JAMÁS en inglés. Suena como un reviewer mexicano que SÍ probó las herramientas en persona. Evita clichés y traducciones literales: "en el mundo actual", "sin duda alguna", "es importante destacar", "en conclusión", "descubre el poder", "lleva tu X al siguiente nivel", "en la era digital", "revoluciona". Los TÍTULOS deben tener gancho (40-60 caracteres, con un número + "2026", ángulo "lo probé/comparé yo"). Ejemplos del estilo: "Probé 7 IAs para crear videos: solo 2 valen la pena", "ChatGPT vs Claude vs Gemini: ¿cuál explica mejor? (2026)", "IA gratis vs de pago: ¿cuándo SÍ vale pagar? (2026)". NUNCA títulos fríos como "Mejores herramientas IA 2026".\n\n`
    : "";
  if (ES) console.log(`${ts()} 🇲🇽 Modo ESPAÑOL activado para este artículo`);

  await supa("PATCH", `keywords?id=eq.${kw.id}`, { status: "in_progress" });
  let totalCost = 0;
  const genStart = Date.now();

  try {
    // Article-type-specific structural requirements
    const typeRequirements = {
      comparison: `ARTICLE TYPE: COMPARISON
Required sections (all mandatory):
1. Quick Verdict (who wins overall)
2. Overview (what both tools do)
3. Feature Comparison (markdown table: Feature | Tool A | Tool B, min 8 rows)
4. Pricing Comparison (markdown table with all tiers)
5. Performance & Speed
6. Ease of Use
7. Integrations & Compatibility
8. Best Use Cases (Tool A for X, Tool B for Y)
9. Pros & Cons (table for each tool)
10. Final Verdict & Recommendation
11. FAQ`,
      review: `ARTICLE TYPE: REVIEW
Required sections (all mandatory):
1. Quick Verdict (2-3 sentences)
2. What Is [Tool] (overview)
3. Key Features (deep-dive, one H3 per major feature)
4. Pricing & Plans (markdown table: Plan | Price | Features)
5. Pros & Cons (markdown table)
6. Performance in Practice (real use cases, specific results)
7. How It Compares (brief comparison with 2 competitors)
8. Who Should Use It (target audience breakdown)
9. Setup & Getting Started
10. FAQ`,
      "how-to": `ARTICLE TYPE: HOW-TO GUIDE
Required sections (all mandatory):
1. What You'll Need (prerequisites + tools list)
2. Quick Overview (what we'll accomplish)
3. Step-by-Step Instructions (numbered, min 6 steps, each 150+ words)
4. Common Mistakes to Avoid
5. Pro Tips & Shortcuts
6. Troubleshooting (min 3 common issues + solutions)
7. Real-World Examples
8. FAQ`,
      list: `ARTICLE TYPE: LISTICLE
Required sections (all mandatory):
1. Quick Picks (top 3 for different use cases)
2. How We Evaluated (criteria used)
3. One H2 per tool/item (min 7 items, each 200+ words with pros/cons + pricing)
4. Comparison Table (all tools: Name | Best For | Price | Rating)
5. How to Choose (decision guide)
6. FAQ`,
    };
    const typeGuide = typeRequirements[kw.article_type] || `ARTICLE TYPE: ${(kw.article_type || "guide").toUpperCase()}
Ensure deep coverage with at least 8 substantive H2 sections.`;

    // Outline — try cache first (used when previous draft failed mid-generation)
    let outline = loadOutlineCache(kw.id);
    if (outline) {
      console.log(`   📂 Using cached outline for "${kw.keyword}" (saved earlier)`);
    } else {
      const outlineRes = await gpt(
        "gpt-4o-2024-11-20",
        "You are an SEO strategist for a top-tier AI tools review publication. The current year is 2026. Output JSON only.",
        `Generate an SEO article outline. The current date is April 2026.

Keyword: ${kw.keyword}
Article type: ${kw.article_type}
Intent: ${kw.intent}
Target word count: 3000 (HARD MINIMUM: 2000 words after editing)
Audience: Small business owners, marketers, creators evaluating AI tools.

${typeGuide}

CRITICAL: All references must be 2026. If the keyword has a year, use 2026. Never use 2023, 2024, or 2025 as "current" — those are the past.
CRITICAL: The outline MUST have at least 10 H2 sections. Each section must have word_target >= 250. Total word_targets must sum to 3000+.
CRITICAL: Include a dedicated "FAQ" section as the last H2 with 6 substantive questions.

TITLE ENGINEERING — the single biggest CTR lever (a flat title = zero clicks). Research-backed (Backlinko, Copyblogger):
- 40-60 chars (highest SERP CTR). Front-load the hook; include the primary keyword naturally; END with the year (2026 / (2026) / [2026]).
- Numbers lift CTR ~36% — use a SPECIFIC number when it fits (7, 9, $0, "30 Days", "20 Tested").
- Use 2-3 TRUST power words: Honest, Tested, Proven, Actually Work, Worth It, Real, Ranked, Data-Backed.
- Open a curiosity / knowledge gap or a clear STAKE — a reason to click NOW ("Which Wins?", "Worth It?", "The Truth", "What Nobody Tells You").
- A first-person testing angle reads as trustworthy and intriguing: "We Tested", "I Tried", "After 50 Hours".
- ONE bracket value-add max: [Tested] [Honest] [Free] [Ranked] [Step-by-Step].
HIGH-CTR FORMULAS by type — pick the PUNCHIEST fit and VARY them (never reuse one pattern run-to-run):
  * comparison: "X vs Y: Which Wins in 2026? [Tested]" / "X vs Y — I Tested Both, Here's the Winner" / "X vs Y: The Honest 2026 Verdict"
  * review:     "X Review 2026: Worth It? [Tested]" / "Is X Worth It in 2026? Honest Review" / "X Review: The Truth After Testing [2026]"
  * listicle:   "7 Best X That Actually Work in 2026 [Tested]" / "9 Best X for Y (Free + Paid, Ranked 2026)" / "Top 7 X in 2026: We Tested 20, These Won"
  * how-to:     "How to X in 2026 [Step-by-Step]" / "How to X Without Y — 2026 Guide"
  * alternative:"7 Best X Alternatives in 2026 [Cheaper + Free]"
BANNED — boring (kills CTR): "Best X 2026", "X Guide", "Everything About X", "Ultimate Guide to X", "A Comprehensive Look at X".
BANNED — hype clichés (read as AI spam): "elevate", "unlock your potential", "supercharge", "game-changer", "revolutionary", "seamless", "dive into".
Good: "7 AI Writing Tools We Tested — Only 3 Actually Work [2026]"  ·  Bad: "Best AI Writing Tools 2026"

Return a JSON object with keys: title (50-60 chars, high-CTR formula as described above), slug (kebab-case with "2026"), meta_description (150-160 chars, MUST follow these CTR rules: start with a benefit/result NOT "In this article" or "Learn about", include primary keyword in first 80 chars, end with curiosity hook or CTA like "See the results" or "Find out which wins", use a number or specific detail when possible. Example: "We tested 7 AI writing tools head-to-head. Here's which one actually delivers for small businesses in 2026."), primary_keyword, lsi_keywords (array of 5-7), target_word_count (must be 3000), article_type, sections (array of AT LEAST 10 objects with: heading, level, bullets array of 4-6 items, word_target number >= 250), faqs (array of 6 question strings), internal_link_ideas (array of strings).`,
        2500,
        true
      );
      totalCost += estimateCost("gpt-4o-2024-11-20", outlineRes.usage);
      outline = JSON.parse(outlineRes.text);
      // Save outline to cache — if draft fails later, next run will reuse it
      saveOutlineCache(kw.id, outline);
    }
    // Healthcheck: outline complete. If the pipeline dies after this point,
    // we'll see OUTLINE pinged but DRAFT not — instantly narrowing the
    // post-mortem to the draft generation step.
    hcStep("OUTLINE", { message: `keyword="${kw.keyword}"` });

    // Draft — explicit 2000+ word requirement with section-level guidance
    const sectionTargets = (outline.sections || [])
      .map((s, i) => `Section ${i + 1} "${s.heading}": write ~${s.word_target || 250} words`)
      .join("\n");

    // Mark we're about to spend the most-expensive call so the heartbeat
    // tells us whether the cron died before or after this $$.
    hcStep("DRAFT_START", { state: "start" });
    const draftRes = await gpt(
      "gpt-4o-2024-11-20",
      "You are a world-class technical writer for AI tools reviews. Style: clear, punchy, authoritative. Think Wirecutter meets a smart tech friend. The current date is April 2026 — all references must reflect this.",
      `Write a complete publication-ready article based on this outline.

${JSON.stringify(outline)}

ARTICLE TYPE REQUIREMENTS:
${typeGuide}

WORD COUNT TARGETS PER SECTION (you MUST meet these):
${sectionTargets}
TOTAL TARGET: 3000 words minimum — this is a HARD requirement. COUNT YOUR WORDS. If any section feels thin, add a real example, a comparison, specific numbers, or a mini case study. Thin sections (< 200 words) are NOT acceptable.

Rules:
1. Current date: April 2026. Use "As of April 2026..." framing for pricing and features. NEVER reference 2023, 2024, or 2025 as "current" — those are the past.
2. Show pros AND cons of every tool. Be specific: cost, limitations, learning curve.
3. ⚠️ Use at least ONE markdown comparison table with real specs (required).
4. At first mention of a product, wrap it: [AFFILIATE:brand_name_lowercase]Product Name[/AFFILIATE]
5. Add a '> **Quick Verdict:**' blockquote at the very top (before the intro) — 2-3 sentences with a clear recommendation.
6. Add a '**Key Takeaways**' bullet list right after the Quick Verdict.
7. AVOID AI-tells: "in today's fast-paced world", "it's important to note", "let's dive in", "revolutionary", "game-changer", "seamless", "cutting-edge", "unlock", "harness the power", "when it comes to", "delve into", "let's explore", "elevate your".
8. Use 2nd person ("you"), active voice, contractions OK.
9. ⚠️ MINIMUM 2000 WORDS — this is non-negotiable. Short sections must be expanded with examples.
10. Cover EVERY section from the outline fully. DO NOT skip sections or write one-liners.
11. End with a full "## FAQ" section answering all ${(outline.faqs || []).length} questions in detail (each answer min 3 sentences).
12. ⭐ CITATION CAPSULE (GEO/AEO requirement): EVERY H2 section (except FAQ) MUST end with a "Key fact" blockquote — exactly this format:

> **Key fact (as of April 2026):** [One factual, citable sentence with a specific number, date, comparison, or claim that an AI search engine like ChatGPT, Perplexity, or Google AI Overview would quote verbatim. Must be standalone — no pronouns like "this" or "that" referring to context above.]

   Good example:
   > **Key fact (as of April 2026):** Jasper AI's Boss Mode starts at $59/month billed annually, with a 5-day free trial. The Business tier adds SSO and custom personas starting at $499/month for 5 seats.

   Bad example (do NOT do this):
   > **Key fact:** This tool is the best for content creation. [too vague, no number/date, uses "this"]

   These callouts are what AI search engines extract as citation passages. Without them, our articles are invisible to ChatGPT/Perplexity even if they rank #1 in Google. EVERY H2 needs one — no exceptions except the FAQ section.

13. DO NOT wrap your output in code fences (\`\`\`markdown ... \`\`\`). Output ONLY raw markdown body. Start with the # H1 heading directly.

Output: pure markdown. Start with # H1. No commentary before or after.`,
      16000
    );
    totalCost += estimateCost("gpt-4o-2024-11-20", draftRes.usage);
    // Draft returned successfully (most expensive single call).
    hcStep("DRAFT", { message: `words≈${(draftRes.text || "").split(/\s+/).length}` });

    // ── Expansion helper (reusable) ──────────────────────────────────────────
    const runExpansionPass = async (text, currentWords, targetWords = 2600) => {
      console.log(`${ts()} ⚡ Expansion pass (${currentWords}w → target ${targetWords}w)...`);
      const expandRes = await gpt(
        "gpt-4o-2024-11-20",
        "You are an expert content editor for a tech review publication. Expand the article to reach the target word count WITHOUT padding. Every sentence you add must provide real value: concrete examples, specific numbers, step-by-step walkthroughs, real-world scenarios, or comparison data.",
        `This article needs expansion. Current: ${currentWords} words. Target: ${targetWords}+ words (hard minimum 2000).

EXPANSION RULES:
1. Expand EVERY section that is under 250 words — add examples, sub-points, real numbers
2. For comparison articles: expand each feature row in tables with explanation paragraphs
3. For how-to articles: add sub-steps, screenshots descriptions, troubleshooting notes
4. For listicles: deepen each item with more pros/cons, pricing details, use cases
5. For reviews: add Performance, Real-World Testing, and Alternatives sections if missing
6. Keep all [AFFILIATE:brand] tags intact
7. Keep all markdown structure (headings, tables, lists) — add content, don't remove
8. NEVER add filler phrases like "In conclusion", "It's worth noting", "As we mentioned"

ARTICLE TO EXPAND (${currentWords} words — EXPAND TO ${targetWords}+):
${text}

Output: the COMPLETE expanded markdown article starting with # heading. No preamble.`,
        8000
      );
      totalCost += estimateCost("gpt-4o-2024-11-20", expandRes.usage);
      const newWords = expandRes.text.split(/\s+/).length;
      // Guard against the "creative" rewrite that returns FEWER words. If the
      // model regressed (commonly happens with 4o on rescue passes), keep the
      // original — we already met the minimum-viable threshold by entering this
      // pass, so a regression is worse than no-op.
      if (newWords < currentWords) {
        console.log(`${ts()} ⚠️  Expansion regressed (${currentWords}w → ${newWords}w) — keeping original`);
        return text;
      }
      console.log(`${ts()} ✅ Expanded: ${currentWords}w → ${newWords}w`);
      return expandRes.text;
    };

    // ── Pass 1: Pre-polish expansion if draft is short ────────────────────
    let finalDraftText = draftRes.text;
    const draftWords = draftRes.text.split(/\s+/).length;
    console.log(`${ts()} 📏 Draft: ${draftWords}w (gen elapsed ${((Date.now()-genStart)/1000).toFixed(1)}s)`);
    if (draftWords < 2000) {
      finalDraftText = await runExpansionPass(draftRes.text, draftWords, 2600);
    }

    // ── Polish — CRITICAL: must NOT reduce word count ────────────────────
    // 2026-05-25: upgraded from gpt-4o-mini → gpt-4o-2024-11-20.
    // Mini was the documented root cause of qa_failed-too-short: it kept
    // trimming 2800w drafts down to <1200w even with explicit MIN
    // instructions. The full 4o respects length constraints far more
    // reliably. Cost delta is ~+$0.03/article (~+30% per polish call),
    // single digit % of monthly spend — worth paying to kill the
    // qa_failed cycle that wasted whole drafts.
    const polishWords = finalDraftText.split(/\s+/).length;
    const polishRes = await gpt(
      "gpt-4o-2024-11-20",
      `You are a senior editor for a top-tier tech review publication. Your job: IMPROVE quality, NEVER reduce length.

STRICT RULES:
1. NEVER remove paragraphs, sections, or list items — only rewrite individual sentences
2. NEVER shorten the article — if unsure, leave the original sentence intact
3. Remove AI-tells: "in today's fast-paced world", "it's important to note", "let's dive in", "revolutionary", "game-changer", "seamless", "cutting-edge", "unlock", "harness the power", "in the realm of", "when it comes to", "whether you're", "in the world of", "delve into", "let's explore", "let's take a look", "elevate your", "landscape", "ecosystem"
4. Fix grammar errors and awkward phrasing
5. Ensure every tool has both pros AND cons stated clearly
6. Keep all [AFFILIATE:...] tags EXACTLY as-is (don't touch them)
7. Keep all markdown structure: headings, tables, bullet lists, numbered lists, blockquotes
8. CRITICAL: Keep "> **Key fact (as of {month year}):** ..." blockquotes EXACTLY as written. These are Citation Capsules — AI search engines extract them verbatim. Do not paraphrase, shorten, or remove them. Every H2 should have one.
9. MINIMUM output: ${Math.max(polishWords - 50, 1800)} words (you started with ${polishWords} — DO NOT go below this)
10. Output: the complete revised markdown only — start with # heading, no commentary
11. DO NOT wrap your output in code fences (\`\`\`markdown ... \`\`\`). Output ONLY raw markdown.`,
      finalDraftText,
      16000
    );
    totalCost += estimateCost("gpt-4o-2024-11-20", polishRes.usage);
    // Polish done — past the most-risky regression zone (length trim).
    hcStep("POLISH", { message: `polished_words=${polishRes.text.split(/\s+/).length}` });

    // ── Pass 2: Post-polish rescue if polish trimmed too much ─────────────
    const postPolishWords = polishRes.text.split(/\s+/).length;
    console.log(`${ts()} 📏 Post-polish: ${postPolishWords}w (was ${polishWords}w, gen elapsed ${((Date.now()-genStart)/1000).toFixed(1)}s)`);
    let finalText = polishRes.text;
    if (postPolishWords < 1900) {
      console.log(`   🚨 Polish trimmed too much! Running rescue expansion...`);
      finalText = await runExpansionPass(polishRes.text, postPolishWords, 2200);
    }

    // ── Pass 3: FAQ injection if missing ──────────────────────────────────
    // GPT-4o frequently omits the FAQ section despite prompt instructions.
    // QA gate requires it for FAQPage schema, so we inject it programmatically.
    if (!/^##\s+(?:FAQ|Frequently Asked Questions|Common Questions)/im.test(finalText) && Array.isArray(outline.faqs) && outline.faqs.length > 0) {
      console.log(`   📝 FAQ missing — injecting ${outline.faqs.length} Q&A`);
      try {
        const faqRes = await gpt(
          "gpt-4o-mini",
          "You are a technical writer for AI tool reviews. Write FAQ answers in 2-3 clear sentences each, using 2026 framing. Output markdown only.",
          `Write a FAQ section for an article about "${outline.primary_keyword || kw.keyword}". Answer these questions concisely:

${outline.faqs.map((q, i) => `${i + 1}. ${q}`).join("\n")}

Format EXACTLY like this:
## FAQ

### ${outline.faqs[0]}
[2-3 sentence answer]

### [next question]
[2-3 sentence answer]

(continue for all ${outline.faqs.length} questions)

Rules: Start with "## FAQ" heading. Each question as "###" sub-heading. Each answer 2-3 sentences. No preamble or commentary.`,
          1500
        );
        totalCost += estimateCost("gpt-4o-mini", faqRes.usage);
        finalText = finalText.trim() + "\n\n" + faqRes.text.trim() + "\n";
      } catch (e) {
        console.log(`   ⚠️  FAQ injection failed: ${e.message.slice(0, 80)}`);
      }
    }

    // Affiliate links
    const affiliates = await supa("GET", "affiliates?status=eq.active");
    const tagRegex = /\[AFFILIATE:([^\]]+)\]([^\[]+)\[\/AFFILIATE\]/gi;
    const affiliatesUsed = new Set();
    const firstSeen = new Map();
    let linked = finalText.replace(tagRegex, (_, brand, name) => {
      const clean = brand.trim().toLowerCase();
      const aff = affiliates.find((a) => a.brand.toLowerCase() === clean);
      if (!aff) return name;
      affiliatesUsed.add(aff.id);
      const seen = firstSeen.get(clean) || 0;
      firstSeen.set(clean, seen + 1);
      if (seen >= 2) return name;
      const utm = `utm_source=aipickd&utm_medium=affiliate&utm_campaign=${outline.slug}`;
      const sep = aff.base_url.includes("?") ? "&" : "?";
      return `[${name}](${aff.base_url}${sep}${utm})`;
    });
    linked = linked.replace(tagRegex, (_, __, name) => name);

    // Auto-correct article_type if keyword title doesn't match declared type
    let correctedType = kw.article_type;
    const kwLower = kw.keyword.toLowerCase();
    if (/\bvs\.?\b|versus/.test(kwLower) && correctedType !== "comparison") {
      console.log(`   🔧 Auto-corrected article_type: ${correctedType} → comparison (keyword has "vs")`);
      correctedType = "comparison";
    } else if (/^best\b|top \d+|top-\d+/.test(kwLower) && correctedType !== "list" && correctedType !== "review") {
      console.log(`   🔧 Auto-corrected article_type: ${correctedType} → list (keyword starts with "Best"/"Top N")`);
      correctedType = "list";
    } else if (/^how (to|do|can|should)\b/i.test(kwLower) && correctedType !== "how-to") {
      console.log(`   🔧 Auto-corrected article_type: ${correctedType} → how-to (keyword starts with "How")`);
      correctedType = "how-to";
    }

    // Format numbers for readability (1000 → 1,000 etc.)
    linked = formatNumbers(linked);

    // Generate 2 A/B title variants via GPT-mini (cheap, fire-and-forget)
    let titleVariants = [];
    try {
      const varRes = await gpt(
        "gpt-4o-mini",
        "You are an SEO headline specialist. Output JSON only.",
        `Generate 2 high-CTR alternative title variants for this article.
Primary title: "${outline.title}"
Primary keyword: "${kw.keyword}"
Article type: "${kw.article_type}"

Rules for EACH variant:
- Under 60 chars, include keyword naturally, end with "2026" or "(2026)" or "[2026]"
- Each variant MUST use a DIFFERENT psychological hook pattern:
  Variant 1: Use brackets + power word (e.g. "[Tested]", "[Free Options]", "[Honest Review]")
  Variant 2: Use curiosity/emotion (e.g. "Worth It?", "Which One Wins?", "You Need This")
- Include at least one: number, bracket, or question mark per variant
- NEVER be generic/flat like "Best X Tools 2026" — that gets ZERO clicks
Return JSON: { "variants": ["Title 1", "Title 2"] }`,
        200,
        true
      );
      const varData = JSON.parse(varRes.text);
      titleVariants = Array.isArray(varData.variants) ? varData.variants.slice(0, 2) : [];
    } catch {}

    // Insert article
    const inserted = await supa("POST", "articles", {
      keyword_id: kw.id,
      niche_id: kw.niche_id,
      title: outline.title,
      slug: outline.slug,
      meta_description: outline.meta_description,
      content_markdown: linked,
      article_type: correctedType || outline.article_type,
      primary_keyword: outline.primary_keyword || kw.keyword,
      status: "draft",
      language: LANG,
      generated_by: "gpt-only",
      word_count: linked.split(/\s+/).length,
      generation_cost_usd: Number(totalCost.toFixed(4)),
      affiliates_mentioned: [...affiliatesUsed],
      // A/B title variants — stored for future testing (column may not exist yet, graceful fail)
      ...(titleVariants.length > 0 ? { title_variants: titleVariants } : {}),
    });
    const article = Array.isArray(inserted) ? inserted[0] : inserted;

    await supa("PATCH", `keywords?id=eq.${kw.id}`, {
      status: "generated",
      assigned_article_id: article.id,
    });

    // Clear outline cache on success
    clearOutlineCache(kw.id);

    GEN_LANG_DIRECTIVE = ""; // reset so the publish phase isn't forced into es
    return {
      article,
      title: outline.title,
      words: article.word_count,
      cost: totalCost,
    };
  } catch (e) {
    GEN_LANG_DIRECTIVE = ""; // reset language so a failure can't leak into later gpt() calls
    // Duplicate-slug (Postgres 23505): a PRIOR run already created the article
    // for this keyword but died (timeout) before marking the keyword done, so
    // the orphan-unstucker reset it to `queued`. Re-queuing again re-picks the
    // SAME keyword forever (poisoned queue → 0 articles/run — the 2026-06-03
    // outage). Instead reconcile: link the keyword to the existing article +
    // mark it published, and tell the caller to try the NEXT keyword.
    if (/23505|duplicate key|already exists/i.test(e.message)) {
      const dupSlug = (e.message.match(/\(slug\)=\(([^)]+)\)/) || [])[1];
      try {
        let artId = null;
        if (dupSlug) {
          const existing = await supa("GET", `articles?slug=eq.${encodeURIComponent(dupSlug)}&select=id&limit=1`);
          artId = Array.isArray(existing) && existing[0] ? existing[0].id : null;
        }
        await supa("PATCH", `keywords?id=eq.${kw.id}`, {
          status: "published",
          ...(artId ? { assigned_article_id: artId } : {}),
        });
        clearOutlineCache(kw.id);
        console.log(`   ⚠️  Slug "${dupSlug || "?"}" already existed — reconciled keyword (no re-queue).`);
        return { reconciled: true, reason: `duplicate slug ${dupSlug || ""}`.trim() };
      } catch (_) {
        // reconciliation itself failed — fall through to the normal re-queue
      }
    }
    await supa("PATCH", `keywords?id=eq.${kw.id}`, { status: "queued" });
    // Outline cache is kept — next run will reuse it and skip outline generation
    throw e;
  }
}

// --- Quality gate: cleans + validates article before publish ---
function aggressiveClean(md) {
  let out = md || "";
  out = out.replace(/\[AFFILIATE:[^\]]+\]([^\[]*)\[\/AFFILIATE\]/gi, "$1");
  out = out.replace(/\[AFFILIATE:[^\]]+\]/gi, "");
  out = out.replace(/\[\/AFFILIATE\]/gi, "");
  return out;
}

function qualityGate(article) {
  const issues = [];
  const md = article.content_markdown || "";

  // Word count — minimum 1100 (GPT-mini polish sometimes shortens; rescue expansion target is 1500+)
  // 2026-05-25: bumped from 1200 → 1100. With the polish-trim issue we were
  // qa_failing 9/run when polish trimmed 3000w drafts to 1100-1199w. The
  // content at that length is still publish-worthy; the min-viable approve
  // path below picks up 1000-1099w cases.
  if (!article.word_count || article.word_count < 1100) issues.push(`too short: ${article.word_count}w (min 1100)`);

  // Title
  if (!article.title || article.title.length < 20) issues.push("title too short");
  if (/^[^a-zA-Z0-9]/.test(article.title || "")) issues.push("weird title char");
  // Year sanity: if there's any "2024" or "2025" but the title says 2026 → likely stale
  if (/\b2026\b/.test(article.title || "") && /\b202[34]\b/.test(md)) {
    const stale = (md.match(/\b202[34]\b/g) || []).length;
    if (stale >= 3) issues.push(`stale year refs: ${stale}× 2024/2025 in body`);
  }

  // AI tells (blocking) — the hard set is identity reveal (AI/LM
  // admission), always rejected. The soft set is filler phrasing the
  // polish step is supposed to scrub; we don't reject on individual
  // hits (they leak through occasionally) but flag if 5+ accumulate,
  // which signals the polish step didn't clean the draft and we'd
  // ship slop. Threshold tuned conservative — false positives are
  // cheap (just regenerate), false negatives ship junk.
  const aiTellsHard = [
    /\b(?:as an AI|I cannot|as a language model|I'm an AI|I am an AI)\b/i,
    /\b(?:I don't have personal|in my training data)\b/i,
  ];
  if (aiTellsHard.some((re) => re.test(md))) issues.push("AI-tell in body");

  const aiTellsSoft = [
    /\bwhen it comes to\b/i,
    /\bwhether you'?re\b/i,
    /\bin (?:the |today's )?(?:fast-paced|digital|modern) world\b/i,
    /\bin the (?:realm|world|landscape|ecosystem) of\b/i,
    /\blet'?s (?:dive|explore|take a look|delve)\b/i,
    /\b(?:revolutioniz|game[- ]chang|cutting[- ]edge|seamless(?:ly)?|harness the power)\b/i,
    /\b(?:unlock the (?:full )?potential|elevate your)\b/i,
    /\bit'?s (?:important|worth) (?:to note|noting)\b/i,
    /\bdelve into\b/i,
  ];
  const softHits = aiTellsSoft.reduce((sum, re) => {
    const m = md.match(new RegExp(re.source, re.flags + "g"));
    return sum + (m ? m.length : 0);
  }, 0);
  if (softHits >= 5) issues.push(`${softHits} AI-tell phrases (polish step didn't scrub)`);

  // Unfinished templates
  if (/\[AFFILIATE:[^\]]*\][^\[]*\[\/AFFILIATE\]/i.test(md)) {
    // OK if matched and being processed by pipeline; only flag if active affiliates exist
    // Actually: pipeline strips these later, so keep this as soft warning only.
    // → not blocking
  }

  // Placeholder / lorem-ipsum / TODO markers
  if (/\b(?:TODO|FIXME|XXX|lorem ipsum)\b/i.test(md)) issues.push("placeholder text in body");

  // Truncation indicators (GPT might truncate output)
  if (md.endsWith("...") || md.endsWith("…")) issues.push("appears truncated");

  // ── Quality regressions we found in published articles 2026-05-25 ────
  // Stray code fences (```markdown, ```html, bare ```) — GPT wraps
  // responses in code fences when it shouldn't, and those render as
  // literal "`markdown" text in the published article. mdToHtml strips
  // them but if any survive past the cleaner, that's still a smell:
  // refuse to publish so we don't pollute the site again.
  if (/^```[a-zA-Z]*\s*$/m.test(md)) issues.push("stray code fence");

  // Duplicate H1 with the post title — when content starts with
  // "# {title}", WP renders both its <h1> and our converted <h1> →
  // duplicate heading. mdToHtml drops the leading H1 now, but we still
  // flag here so we catch any unexpected mid-doc H1 collisions.
  const leadingH1 = md.match(/^#\s+(.+?)\s*$/m);
  if (leadingH1 && article.title) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (norm(leadingH1[1]) === norm(article.title)) {
      // mdToHtml strips this so it's not strictly publish-blocking, but
      // worth surfacing as a soft warning in the logs (not in issues[]).
      // (intentionally a no-op flag — we don't push to issues here)
    }
  }

  // Duplicate consecutive paragraphs (common GPT failure mode)
  const paras = md.split(/\n\n+/).filter((p) => p.length > 100);
  for (let i = 1; i < paras.length; i++) {
    if (paras[i] === paras[i - 1]) {
      issues.push("duplicate consecutive paragraph");
      break;
    }
  }

  // Heading sanity: must have at least 5 ## headings (proper structure for 2000+ word article)
  const h2Count = (md.match(/^##\s+/gm) || []).length;
  if (h2Count < 5) issues.push(`only ${h2Count} H2 headings (min 5)`);

  // Citation Capsule coverage (GEO/AEO requirement — see brainstorm A10).
  // Every H2 should end with a "Key fact" blockquote so AI search engines
  // have a citable passage to extract. We count how many H2 sections have
  // one and warn if coverage is below 60% (excluding FAQ — that section
  // legitimately doesn't need a Key fact since the questions ARE the
  // citables). Non-blocking flag because the prompt is new and GPT may
  // ignore it occasionally on the first rollout; we'll harden once
  // baseline coverage is established.
  const sections = md.split(/^##\s+/gm).slice(1); // drop the pre-first-H2 chunk
  let citableSections = 0;
  let countedSections = 0;
  for (const s of sections) {
    const firstLine = (s.split("\n")[0] || "").toLowerCase();
    if (/^(faq|frequently asked|common questions)/i.test(firstLine)) continue;
    countedSections++;
    if (/^>\s*\*\*Key fact\b/im.test(s)) citableSections++;
  }
  if (countedSections > 0) {
    const coverage = citableSections / countedSections;
    if (coverage < 0.6) {
      // Soft flag — log only, doesn't block publish yet
      console.log(`   ℹ️  Citation Capsule coverage: ${citableSections}/${countedSections} H2s (${(coverage * 100).toFixed(0)}%) — target ≥60%`);
    }
  }

  // Keyword density: primary keyword must appear at least once, OR ≥70% of meaningful words present
  // Long-tail keywords like "best ai tools for image enhancement 2026" rarely appear verbatim;
  // word-fraction match is more forgiving while still catching off-topic content.
  if (article.primary_keyword) {
    const kw = article.primary_keyword.toLowerCase().trim();
    const bodyLower = md.toLowerCase();
    const kwEscaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactCount = (bodyLower.match(new RegExp(kwEscaped, "g")) || []).length;
    const meaningfulWords = kw.split(/\s+/).filter((w) => w.length >= 4);
    const matchedWords = meaningfulWords.filter((w) => bodyLower.includes(w));
    const wordCoverage = meaningfulWords.length > 0 ? matchedWords.length / meaningfulWords.length : 1;
    if (exactCount < 1 && wordCoverage < 0.7) {
      issues.push(`keyword "${kw}" never appears verbatim and only ${Math.round(wordCoverage * 100)}% of words present (min 70%)`);
    }
  }

  // FAQ section check — needed for FAQPage schema
  const hasFaq = /^##\s+(?:FAQ|Frequently Asked Questions|Common Questions)/im.test(md);
  if (!hasFaq) issues.push("missing FAQ section (needed for schema)");

  return { pass: issues.length === 0, issues };
}

function qaIssueCode(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("too short")) return "too_short";
  if (text.includes("faq")) return "missing_faq";
  if (text.includes("keyword")) return "missing_keyword";
  if (text.includes("html")) return "html_validator";
  if (text.includes("duplicate")) return "duplicate";
  if (text.includes("language")) return "language_mismatch";
  if (text.includes("schema")) return "schema_error";
  return "qa_failed";
}

function qaIssueObjects(issues, fallbackCode = "qa_failed") {
  return (issues || []).map((issue) => {
    const message = typeof issue === "string" ? issue : issue.message || issue.code || fallbackCode;
    return {
      code: issue.code || qaIssueCode(message) || fallbackCode,
      message,
      severity: issue.severity || "blocking",
      repairable: issue.repairable !== false,
      recommendation: issue.recommendation || "repair or regenerate before publishing",
    };
  });
}

function qaFailurePatch(issues, fallbackCode = "qa_failed") {
  const structured = qaIssueObjects(issues, fallbackCode);
  return {
    status: "qa_failed",
    quality_score: 0,
    qa_issues: structured,
    last_error: structured.map((issue) => issue.message).join(", ").slice(0, 1000),
    last_error_at: new Date().toISOString(),
    last_qa_at: new Date().toISOString(),
    repair_status: structured.every((issue) => issue.repairable) ? "repairable" : "blocked",
  };
}

async function markKeywordForArticle(article, stateOverride = null) {
  if (!article || !article.keyword_id) return;
  const status = stateOverride || keywordStateForArticle(article);
  await supa("PATCH", `keywords?id=eq.${article.keyword_id}`, {
    status,
    assigned_article_id: article.id,
    updated_at: new Date().toISOString(),
  }).catch(() => {});
}

function runWpLanguageBridgeProbe() {
  const probe = spawnSync(process.execPath, [path.join(__dirname, "wp-language-bridge-probe.js")], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 60_000,
  });
  if (probe.status === 0) return { pass: true, output: probe.stdout || "" };
  return {
    pass: false,
    output: `${probe.stdout || ""}${probe.stderr || ""}`.trim(),
  };
}

// --- DALL-E image generation + Unsplash fallback ---
async function generateFeaturedImage(title, slug, postId, articleType = "article", primaryKeyword = "") {
  const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");

  async function uploadBufferToWP(buffer, mimeType = "image/jpeg") {
    const ext = mimeType === "image/jpeg" ? "jpg" : "png";
    // Hard 90s cap on the upload — Hostinger can hang silently on shared hosting,
    // and a missing timeout here was a primary contributor to the 25-min runaway.
    const uploadRes = await fetch("https://aipickd.com/wp-json/wp/v2/media", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${slug}.${ext}"`,
        "User-Agent": "Mozilla/5.0 AIPickd-pipeline/1.0",
      },
      body: buffer,
      signal: AbortSignal.timeout(90_000),
    });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(`WP upload: ${uploadRes.status}`);
    await wp("POST", `posts/${postId}`, { featured_media: uploadData.id });
    return uploadData.source_url;
  }

  // Strategy 1: gpt-image-1 with type-specific prompt.
  // NOTE: OpenAI removed dall-e-3 from this account (only gpt-image-1 remains).
  // gpt-image-1 differs from dall-e-3: it returns base64 (b64_json), NOT a URL,
  // has no 1792x1024 size (use 1536x1024 landscape), and quality is low/medium/
  // high (not "standard"). This was the silent cause of ~56% of articles having
  // no featured image (and, before schema was decoupled, no schema either).
  try {
    const typeStyles = {
      comparison: "split-panel composition showing two contrasting tech concepts side by side",
      review: "product spotlight editorial — single tool in hero position, feature highlights",
      "how-to": "step-by-step process visualization, clean numbered flow diagram",
      list: "grid mosaic of diverse tech icons representing multiple AI tools",
      guide: "roadmap or journey visualization, progressive steps leading to a goal",
    };
    const styleHint = typeStyles[articleType] || "editorial tech illustration";
    const kwHint = primaryKeyword ? ` (topic: ${primaryKeyword})` : "";
    const imgPrompt = `${styleHint}${kwHint}. Modern tech editorial style, abstract geometric shapes, deep navy and electric blue palette with emerald green accents, 16:9 landscape. Clean flat design, high contrast. Absolutely NO text, NO logos, NO UI elements, NO faces, NO brand names.`;

    // 90s cap — gpt-image-1 is slower than the old DALL-E endpoint.
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: imgPrompt,
        n: 1,
        size: "1536x1024", // landscape; gpt-image-1 has no 1792x1024
        quality: "low",     // abstract art → "low" looks fine and keeps cost ~$0.02/img
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`gpt-image-1: ${JSON.stringify(data).slice(0, 200)}`);
    // gpt-image-1 returns base64 directly — no separate CDN download needed.
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) throw new Error("gpt-image-1: no b64_json in response");
    const buffer = Buffer.from(b64, "base64");
    return await uploadBufferToWP(buffer, "image/png");
  } catch (e) {
    console.log(`   ⚠️ gpt-image-1 failed (${e.message.slice(0, 80)}), trying Unsplash...`);
  }

  // Strategy 2: Unsplash fallback
  try {
    const UNSPLASH_KEY = env.UNSPLASH_ACCESS_KEY;
    if (!UNSPLASH_KEY) throw new Error("No Unsplash key");
    const query = (primaryKeyword || title).split(" ").slice(0, 3).join(" ");
    const unsplashRes = await fetch(
      `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}&orientation=landscape&client_id=${UNSPLASH_KEY}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!unsplashRes.ok) throw new Error(`Unsplash: ${unsplashRes.status}`);
    const photo = await unsplashRes.json();
    const imgUrl = photo.urls?.regular;
    if (!imgUrl) throw new Error("No image URL from Unsplash");
    const imgRes = await fetch(imgUrl, { signal: AbortSignal.timeout(20_000) });
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    console.log(`   📸 Unsplash fallback: "${photo.alt_description || query}" by ${photo.user?.name}`);
    return await uploadBufferToWP(buffer, "image/jpeg");
  } catch (e) {
    console.log(`   ⚠️ Unsplash fallback failed: ${e.message.slice(0, 60)}`);
    return null;
  }
}

// --- Schema.org JSON-LD injection ---
// Delegates to the shared lib/schema.js module so new articles and the
// add-schema-markup.js backfill emit IDENTICAL structured data (Article/Review,
// BreadcrumbList, ItemList, HowTo with real steps, FAQPage). `categorySlug`
// drives the breadcrumb trail (Home > Category > Title).
function buildSchemaBlock(article, wpLink, imageUrl, categorySlug) {
  const now = new Date().toISOString();
  const schemas = buildSchemas(article, {
    url: wpLink,
    imageUrl,
    datePublished: now,
    dateModified: now,
    wordCount: article.word_count || 0,
    categorySlug: categorySlug || null,
  });
  return renderSchemaBlock(schemas);
}

// --- Enhanced comparison table HTML (richer styles for comparison articles) ---
function enhanceComparisonTables(html) {
  // Replace plain <table> with styled comparison tables
  return html.replace(
    /<table class="wp-block-table">([\s\S]*?)<\/table>/g,
    (match, inner) => {
      // Only enhance tables that look like comparisons (have Feature/Tool/Price headers)
      const isComparison = /<th>(Feature|Plan|Price|Rating|Tool|Metric|Criteria)/i.test(inner);
      if (!isComparison) return match;
      return `<table class="wp-block-table aipickd-comparison-table" style="width:100%;border-collapse:collapse;margin:24px 0;font-size:0.95rem;">${inner
        .replace(/<th>/g, '<th style="background:#1e3a5f;color:#fff;padding:10px 14px;text-align:left;font-weight:600;">')
        .replace(/<td>/g, '<td style="padding:9px 14px;border-bottom:1px solid #e5e7eb;vertical-align:top;">')
        .replace(/<tr>/g, '<tr style="transition:background 0.15s;" onmouseover="this.style.background=\'#f0f7ff\'" onmouseout="this.style.background=\'\'">')
      }</table>`;
    }
  );
}

// --- Best Deal callout box (injected before FAQ for affiliate articles) ---
function injectBestDeal(html, affiliateLinks) {
  if (!affiliateLinks || affiliateLinks.length === 0) return html;
  // Build callout with top 3 affiliate links
  const topLinks = affiliateLinks.slice(0, 3);
  const linkHtml = topLinks.map(({name, url}, i) => {
    const badges = ['🥇 Best Overall', '🥈 Runner-Up', '🥉 Budget Pick'];
    return `<li style="margin:6px 0;"><strong>${badges[i] || '✅'}:</strong> <a href="${url}" rel="nofollow sponsored" target="_blank" style="color:#2563eb;font-weight:600;">${name}</a></li>`;
  }).join('');

  const callout = `\n<!-- wp:html -->\n<div class="aipickd-best-deal" style="background:linear-gradient(135deg,#f0f9ff,#e0f2fe);border:2px solid #0ea5e9;border-radius:8px;padding:20px 24px;margin:32px 0;">\n  <h3 style="margin:0 0 12px;font-size:1.1rem;color:#0c4a6e;">🏆 Best Deals Right Now</h3>\n  <ul style="list-style:none;padding:0;margin:0;">${linkHtml}</ul>\n  <p style="margin:12px 0 0;font-size:0.8rem;color:#64748b;">Prices may vary. We may earn a commission at no extra cost to you.</p>\n</div>\n<!-- /wp:html -->\n\n`;

  // Insert before FAQ section or before the last H2
  const faqMatch = html.match(/<h2[^>]*>(?:FAQ|Frequently Asked Questions)/i);
  if (faqMatch) {
    return html.slice(0, html.indexOf(faqMatch[0])) + callout + html.slice(html.indexOf(faqMatch[0]));
  }
  // Fallback: append before last </p> block
  const lastH2 = [...html.matchAll(/<h2/g)].at(-2);
  if (lastH2) {
    return html.slice(0, lastH2.index) + callout + html.slice(lastH2.index);
  }
  return html + callout;
}

// --- Cloudflare cache purge for a URL ---
async function purgeCloudflareCache(url) {
  const CF_TOKEN = env.CLOUDFLARE_API_TOKEN;
  const CF_ZONE  = env.CLOUDFLARE_ZONE_ID;
  if (!CF_TOKEN || !CF_ZONE) return; // Skip if not configured
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/purge_cache`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: [url] }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (data.success) console.log(`   ☁️ Cloudflare cache purged: ${url.slice(-60)}`);
    else console.log(`   ⚠️ Cloudflare purge failed: ${JSON.stringify(data.errors).slice(0, 100)}`);
  } catch (e) {
    console.log(`   ⚠️ Cloudflare purge error: ${e.message.slice(0, 60)}`);
  }
}

// --- Outline cache: save/load outlines for retry on failure ---
const OUTLINE_CACHE_DIR = path.join(__dirname, '..', '.outline-cache');
function saveOutlineCache(keywordId, outline) {
  try {
    if (!require('fs').existsSync(OUTLINE_CACHE_DIR)) require('fs').mkdirSync(OUTLINE_CACHE_DIR);
    require('fs').writeFileSync(
      path.join(OUTLINE_CACHE_DIR, `${keywordId}.json`),
      JSON.stringify({ outline, savedAt: new Date().toISOString() })
    );
  } catch {}
}
function loadOutlineCache(keywordId) {
  try {
    const p = path.join(OUTLINE_CACHE_DIR, `${keywordId}.json`);
    if (!require('fs').existsSync(p)) return null;
    const data = JSON.parse(require('fs').readFileSync(p, 'utf8'));
    // Only use cache if < 48h old
    if (Date.now() - new Date(data.savedAt).getTime() > 48 * 3600000) return null;
    return data.outline;
  } catch { return null; }
}
function clearOutlineCache(keywordId) {
  try { require('fs').unlinkSync(path.join(OUTLINE_CACHE_DIR, `${keywordId}.json`)); } catch {}
}

// --- Format numbers in markdown (1000 → 1,000 | 1500000 → $1.5M) ---
function formatNumbers(text) {
  // Format large plain integers (not inside URLs, code blocks, or already formatted)
  return text
    .replace(/(?<![/$€£¥,.\w])(\d{4,})(?!\d|,|\.|%|\w)/g, (m, n) => {
      const num = parseInt(n, 10);
      if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
      if (num >= 10_000)    return num.toLocaleString("en-US");
      return m;
    });
}

// --- Affiliate disclosure block (FTC compliance) ---
function affiliateDisclosure(language = "en") {
  const lang = normalizeLanguage(language);
  const text = lang === "es"
    ? `⚡ <strong>Aviso:</strong> Este artículo contiene enlaces de afiliado. Si compras a través de nuestros enlaces, podríamos ganar una comisión sin costo extra para ti. Solo recomendamos herramientas que probamos y en las que confiamos.`
    : `⚡ <strong>Disclosure:</strong> This article contains affiliate links. If you purchase through our links, we may earn a commission at no extra cost to you. We only recommend tools we've evaluated and trust.`;
  return `<!-- wp:html -->\n<div class="aipickd-disclosure" style="background:#f0f7ff;border-left:4px solid #2563eb;padding:12px 16px;margin:0 0 24px;border-radius:4px;font-size:0.875rem;color:#374151;">\n  ${text}\n</div>\n<!-- /wp:html -->\n\n`;
}

// --- Generate WP tags from article content via GPT ---
async function generateWPTags(title, keyword, articleType, niche) {
  try {
    const res = await gpt(
      "gpt-4o-mini",
      "You are an SEO tagging specialist. Return JSON only.",
      `Generate 10-15 WordPress tags for this article:
Title: "${title}"
Primary keyword: "${keyword}"
Article type: ${articleType}
Niche: ${niche}

Rules:
- Mix of: specific tool names, broader category tags, intent tags, year tags
- Include "2026" as one tag
- Each tag: 1-4 words, lowercase, no special chars except hyphens
- Return JSON: { "tags": ["tag1", "tag2", ...] }`,
      500,
      true
    );
    const data = JSON.parse(res.text);
    return Array.isArray(data.tags) ? data.tags.slice(0, 15) : [];
  } catch { return []; }
}

// --- Ping search engines to index new URL ---
async function pingSearchEngines(url) {
  const key = env.INDEXNOW_KEY || "aipickd2026";
  const engines = [
    `https://www.bing.com/indexnow?url=${encodeURIComponent(url)}&key=${key}`,
    `https://yandex.com/indexnow?url=${encodeURIComponent(url)}&key=${key}`,
    `https://api.indexnow.org/indexnow?url=${encodeURIComponent(url)}&key=${key}`,
  ];
  await Promise.allSettled(engines.map(e => fetch(e, { signal: AbortSignal.timeout(8000) })));
  console.log(`   🔍 IndexNow pinged (Bing + Yandex + IndexNow API) for: ${url.slice(-60)}`);
}

// --- Publishing (all unpublished drafts) ---
async function publishAllDrafts(maxCount = 10) {
  // Telemetry: every entry/branch/error notifies Discord directly.
  // After 21 days of silent failures + a "success" run that published 0 of 6
  // drafts WITHOUT firing iter catches, we can no longer trust that "no log
  // = nothing happened". Each step now emits a trace marker.
  const trace = (msg) => {
    console.log(`${ts()} [publish] ${msg}`);
  };

  trace(`▶ publishAllDrafts(maxCount=${maxCount}) start`);

  // Auto-archive drafts older than 7 days that never got a wp_post_id.
  // These have been retried many times and are clogging the queue. Mirrors
  // the qa_failed archive logic that already runs at the end of main().
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const archived = await supa(
      "PATCH",
      `articles?status=eq.draft&wp_post_id=is.null&created_at=lt.${sevenDaysAgo}`,
      { status: "archived" }
    );
    const archivedCount = Array.isArray(archived) ? archived.length : 0;
    if (archivedCount > 0) {
      trace(`🗄️  auto-archived ${archivedCount} draft(s) older than 7 days (stuck without wp_post_id)`);
      notifyAlert(
        `🗄️ **Auto-archived ${archivedCount} stuck draft(s)** (>7 days old, never published to WP). Cleared from publish queue.`,
        "info"
      ).catch(() => {});
    }
  } catch (e) {
    trace(`⚠️ auto-archive query failed: ${e.message?.slice(0, 120)}`);
  }

  // Only fetch articles that haven't been pushed to WP yet
  let drafts;
  try {
    drafts = await supa(
      "GET",
      `articles?status=eq.draft&wp_post_id=is.null&order=created_at.asc&limit=${maxCount}&select=*,niche:niches(slug)`
    );
  } catch (e) {
    const msg = `supa("GET" drafts) threw: ${e.message?.slice(0, 200)}`;
    trace(`❌ ${msg}`);
    notifyAlert(`🚨 **publishAllDrafts: drafts query failed**\n\`\`\`\n${msg}\n\`\`\``, "critical").catch(() => {});
    throw e;
  }

  trace(`fetched ${Array.isArray(drafts) ? drafts.length : "NON-ARRAY:" + typeof drafts} drafts`);

  if (!drafts || drafts.length === 0) {
    // Sanity check: confirm via direct fetch whether Supabase truly has zero
    // unpublished drafts. If our helper got [] but a raw fetch finds rows,
    // there's a bug in supa() or fetchWithRetry — surface it loudly.
    try {
      const directRes = await fetch(
        `${SUPABASE_URL}/rest/v1/articles?status=eq.draft&wp_post_id=is.null&select=id&limit=20`,
        { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }, signal: AbortSignal.timeout(15_000) }
      );
      const rawText = await directRes.text();
      let directCount = "?";
      try { directCount = JSON.parse(rawText).length; } catch {}
      trace(`sanity raw fetch → status=${directRes.status} drafts=${directCount}`);
      if (typeof directCount === "number" && directCount > 0) {
        notifyAlert(
          `🚨 **publishAllDrafts mismatch!** supa() returned 0 drafts but a raw fetch found ${directCount}. ` +
          `That means the helper, fetchWithRetry, or SSRF allowlist is corrupting the response.\n\n` +
          `Raw body[0:300]: \`${rawText.slice(0, 300).replace(/`/g, "'")}\``,
          "critical"
        ).catch(() => {});
      }
    } catch (e) {
      trace(`sanity raw fetch failed: ${e.message?.slice(0, 200)}`);
    }
    trace(`◀ early return: no drafts`);
    return { count: 0, skipped: 0 };
  }

  const published = [];
  let skippedCount = 0;

  // Pre-load published titles for duplicate detection
  const publishedArticles = await supa("GET", "articles?status=eq.published&select=title,slug").catch(() => []);
  const normalizeTitle = (s) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  const publishedTitles = (publishedArticles || []).map(a => normalizeTitle(a.title));
  trace(`pre-loaded ${publishedTitles.length} published titles for dup detection`);

  // Warm the (possibly 4h-idle) Hostinger shared host BEFORE the first WP call.
  // On GitHub Actions this categories GET is the first hit after a long idle, so
  // it cold-starts (slow TLS / LiteSpeed 5xx). warmUp pings the homepage until
  // the site answers quickly; it never throws.
  await warmUp({ log: true }).catch(() => {});

  // Get WP categories once. Categories are a NICE-TO-HAVE: the post still
  // publishes without one, and categorize-posts.js back-fills it later in the
  // SAME workflow. So a transient WP blip here must NOT be fatal. This used to
  // `throw e` → publishAllDrafts died → the WHOLE publish phase exited 1 AFTER
  // generation had already produced a draft (the 2026-06-04→05 outage: 3 runs
  // each generated 1 article then crashed right here, 0 published). Now: warm
  // up, and on failure log + alert + publish UNCATEGORIZED instead of dying.
  let cats = [];
  try {
    cats = await wp("GET", "categories?per_page=20&_fields=id,slug");
  } catch (e) {
    const msg = `wp("GET" categories) failed: ${(e?.message || String(e)).slice(0, 200)}${e?.status ? ` [HTTP ${e.status}]` : ""}`;
    trace(`⚠️ ${msg} — publishing UNCATEGORIZED this run (categorize-posts.js back-fills)`);
    notifyAlert(
      `⚠️ **WP categories fetch falló (NO fatal)** — publicando sin categoría este run; \`categorize-posts.js\` la corrige después.\n\`\`\`\n${msg}\n\`\`\``,
      "warning"
    ).catch(() => {});
    cats = [];
  }
  trace(`fetched ${Array.isArray(cats) ? cats.length : "NON-ARRAY"} WP categories`);

  const catMap = {};
  for (const c of cats || []) catMap[c.slug] = c.id;
  const nicheCatMap = {
    "ai-writing": catMap["ai-writing"],
    "ai-business": catMap["ai-business"],
    "ai-image-video": catMap["ai-image-video"],
    "ai-coding": catMap["ai-coding"],
    "ai-hosting": catMap["ai-infrastructure"],
  };

  trace(`entering for-loop with ${drafts.length} drafts to process`);

  // Send a one-shot summary to Discord so we KNOW the loop started, regardless
  // of what happens inside it.
  notifyAlert(
    `📤 **publishAllDrafts iter starting**\n` +
    `Drafts: ${drafts.length} · Published titles: ${publishedTitles.length} · ` +
    `WP cats: ${Array.isArray(cats) ? cats.length : "?"} · WP_STATUS: \`${WP_STATUS}\``,
    "info"
  ).catch(() => {});

  // Per-article hard cap: each publish is wrapped in a 4-min budget. If it
  // exceeds that, log + skip + move on so one stuck article doesn't burn the
  // entire workflow timeout. (Image gen + WP upload + schema = ~60s normal,
  // 4 min is a generous ceiling.)
  const ARTICLE_PUBLISH_BUDGET_MS = 4 * 60_000;
  let wpLanguageBridgeOk = null;

  for (const article of drafts) {
    const articleStart = Date.now();
    console.log(`${ts()} 📤 Publishing "${article.title?.slice(0, 60)}"`);

    // Duplicate detection — skip if very similar title already published.
    if (normalizeLanguage(article.language) === "es") {
      if (wpLanguageBridgeOk === null) {
        const probe = runWpLanguageBridgeProbe();
        wpLanguageBridgeOk = probe.pass;
        if (!probe.pass) {
          const msg = `WordPress language bridge probe failed; Spanish publishing is blocked. ${probe.output.slice(0, 700)}`;
          trace(msg);
          notifyAlert(`Spanish publish blocked\n${msg}`, "critical").catch(() => {});
        }
      }
      if (!wpLanguageBridgeOk) {
        skippedCount++;
        console.log("   BLOCKER: Spanish article skipped because _pipeline_lang=es could not be verified.");
        continue;
      }
    }

    // Previously the threshold was "any 5-word phrase matches" which produced
    // false positives like "best ai writing tools 2026" against any other
    // "best * 2026" article. Tightened to 7 words AND require >= 0.6 jaccard
    // word-set similarity to consider it a duplicate. Either alone isn't enough.
    const normNewTitle = normalizeTitle(article.title);
    const newWords = new Set(normNewTitle.split(" ").filter((w) => w.length >= 3));
    const isDuplicate = publishedTitles.some((existing) => {
      // Cheap reject: very short titles can't be meaningful duplicates here
      if (!existing || existing.length < 20) return false;
      // Test 1: any 7-word consecutive phrase shared
      const words = normNewTitle.split(" ");
      let phraseMatch = false;
      for (let i = 0; i <= words.length - 7; i++) {
        const phrase = words.slice(i, i + 7).join(" ");
        if (phrase.length > 25 && existing.includes(phrase)) {
          phraseMatch = true;
          break;
        }
      }
      if (!phraseMatch) return false;
      // Test 2: jaccard ≥ 0.6 over 3+ char word sets
      const existingWords = new Set(existing.split(" ").filter((w) => w.length >= 3));
      let inter = 0;
      for (const w of newWords) if (existingWords.has(w)) inter++;
      const union = newWords.size + existingWords.size - inter;
      const jaccard = union === 0 ? 0 : inter / union;
      return jaccard >= 0.6;
    });
    if (isDuplicate) {
      skippedCount++;
      console.log(`   ⏩ skip "${article.title.slice(0, 50)}": duplicate of published article`);
      await supa("PATCH", `articles?id=eq.${article.id}`, qaFailurePatch(["duplicate of published article"], "duplicate")).catch(() => {});
      await markKeywordForArticle(article, "qa_failed");
      continue;
    }

    // Quality gate + cleanup — GUARDED. A throw in aggressiveClean / qualityGate
    // (or injectToC, moved into the try below) must skip THIS draft, never crash
    // publishAllDrafts → exit 1 → block ALL publishing (2026-06 outage lesson).
    let qa;
    try {
      article.content_markdown = aggressiveClean(article.content_markdown);
      qa = qualityGate(article);
    } catch (prepErr) {
      skippedCount++;
      console.log(`   ⏩ skip "${article.title?.slice(0, 50)}": QA prep threw — ${(prepErr?.message || String(prepErr)).slice(0, 120)}`);
      await supa("PATCH", `articles?id=eq.${article.id}`, { status: "qa_failed", quality_score: 0 }).catch(() => {});
      continue;
    }
    // Minimum Viable Approve: if only issue is "too short" (1000-1099w), auto-approve to avoid stalls
    let qaPass = qa.pass;
    if (!qa.pass && qa.issues.length === 1 && qa.issues[0].startsWith('too short')) {
      const wc = article.word_count || 0;
      const qScore = calcQualityScore(wc, []);
      if (wc >= 1000 && qScore >= 50) {
        console.log(`   ✅ Min-viable approve: ${wc}w / score ${qScore} — accepting borderline article`);
        qaPass = true;
      }
    }
    if (!qaPass) {
      skippedCount++;
      const issuesSummary = qa.issues.join(", ");
      console.log(`   ⏩ skip "${article.title.slice(0, 50)}": ${issuesSummary}`);
      // Mark as qa_failed so it doesn't clog the queue on future runs
      await supa("PATCH", `articles?id=eq.${article.id}`, {
        ...qaFailurePatch(qa.issues),
      }).catch(() => {});
      await markKeywordForArticle(article, "qa_failed");
      // Notify #alertas with failure reason (so you can fix prompts faster)
      notifyAlert(
        `🚫 **QA Failed:** ${article.title.slice(0, 70)}\n\n**Razones:** ${issuesSummary}\n**Palabras:** ${article.word_count || 0}w`,
        "warning"
      ).catch(() => {});
      continue;
    }
    // (qa passed — either naturally or via min-viable approve)

    try {
      // Inject Table of Contents for long articles (inside the per-article try
      // so a ToC parse error skips this draft instead of crashing the run).
      article.content_markdown = injectToC(article.content_markdown);
      const artLang = normalizeLanguage(article.language);
      const isES = artLang === "es";

      // Prepend affiliate disclosure (FTC compliance) — localized per language
      const disclosure = affiliateDisclosure(artLang);
      let html = disclosure + mdToHtml(article.content_markdown);

      // ── Pre-publish HTML validator (defense in depth) ────────────────
      // The qualityGate above checked the MARKDOWN. This validates the
      // RENDERED HTML — catches bugs the markdown checks can't see, like
      // the markdown fence + duplicate H1 incident that shipped to 13
      // articles on 2026-05-25 before we noticed. If anything is wrong,
      // refuse to publish and mark qa_failed with a clear reason.
      const htmlIssues = validateRenderedHtml(html, article.title);
      if (htmlIssues.length > 0) {
        skippedCount++;
        const issuesSummary = htmlIssues.join(", ");
        console.log(`   ⏩ skip "${article.title.slice(0, 50)}": HTML issues — ${issuesSummary}`);
        await supa("PATCH", `articles?id=eq.${article.id}`, {
          ...qaFailurePatch(htmlIssues, "html_validator"),
        }).catch(() => {});
        await markKeywordForArticle(article, "qa_failed");
        notifyAlert(
          `🚫 **HTML validator blocked publish:** ${article.title.slice(0, 70)}\n\n**Issues:** ${issuesSummary}\n\nThis is the post-render check that catches what the markdown qualityGate misses. Inspect the article markdown and either fix the generation prompt or run \`fix-stale-html\` after manual cleanup.`,
          "warning"
        ).catch(() => {});
        continue;
      }

      // Enhance comparison tables with richer styling
      if (article.article_type === 'comparison' || article.article_type === 'list') {
        html = enhanceComparisonTables(html);
      }

      // Inject Best Deal callout for affiliate articles that have active affiliates linked
      const mentioned = Array.isArray(article.affiliates_mentioned) ? article.affiliates_mentioned : [];
      if (mentioned.length >= 2) {
        try {
          const affIds = mentioned.slice(0, 5).join(',');
          const affiliatesForDeal = await supa("GET", `affiliates?id=in.(${affIds})&status=eq.active&select=id,brand,base_url`);
          if (Array.isArray(affiliatesForDeal) && affiliatesForDeal.length >= 2) {
            const dealLinks = affiliatesForDeal.slice(0, 3).map(a => ({ name: a.brand, url: a.base_url }));
            html = injectBestDeal(html, dealLinks);
          }
        } catch {}
      }

      // Generate WP tags via GPT. Spanish posts skip WP tags + categories for
      // now: Polylang taxonomy terms are per-language and the existing terms are
      // all English, so assigning them to an /es/ post would mismatch. Spanish
      // taxonomy translations are a later refinement — the post still publishes
      // to /es/ with full Spanish content, title, meta and image.
      let tagSlugs = [];
      const tagIds = [];
      if (!isES) {
        tagSlugs = await generateWPTags(
          article.title,
          article.primary_keyword || "",
          article.article_type || "article",
          article.niche?.slug || ""
        );
        for (const tagName of tagSlugs) {
          try {
            const existingRes = await wp("GET", `tags?search=${encodeURIComponent(tagName)}&per_page=1`);
            if (Array.isArray(existingRes) && existingRes.length > 0) {
              tagIds.push(existingRes[0].id);
            } else {
              const newTag = await wp("POST", "tags", { name: tagName, slug: tagName.replace(/\s+/g, "-") });
              if (newTag?.id) tagIds.push(newTag.id);
            }
          } catch {}
        }
      }

      const catId = isES ? null : nicheCatMap[article.niche?.slug];

      // Idempotency guard: a deterministic key (slug + UTC day + body hash)
      // prevents republishing the same article when a previous run crashed
      // mid-publish. If a row with this key already exists, mark this draft
      // as already-published using the existing wp_post_id and skip POST.
      const idempotencyKey = idempotencyPublishKey({
        slug: article.slug,
        body: html,
      });
      const existingByKey = await supa(
        "GET",
        `articles?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=id,wp_post_id,wp_url&limit=1`
      ).catch(() => []);
      if (Array.isArray(existingByKey) && existingByKey.length > 0 && existingByKey[0].wp_post_id) {
        const dup = existingByKey[0];
        console.log(`   ⏩ skip "${article.title.slice(0, 50)}": idempotent match (wp_post_id=${dup.wp_post_id})`);
        await supa("PATCH", `articles?id=eq.${article.id}`, {
          status: "published",
          wp_post_id: dup.wp_post_id,
          wp_url: dup.wp_url,
          idempotency_key: idempotencyKey,
          published_at: new Date().toISOString(),
        }).catch(() => {});
        await markKeywordForArticle({
          ...article,
          status: "published",
          wp_post_id: dup.wp_post_id,
          wp_url: dup.wp_url,
        });
        published.push(article);
        continue;
      }

      // Guard: skip if a post with this slug already exists in WordPress
      const existingBySlug = await wp("GET", `posts?slug=${encodeURIComponent(article.slug)}&_fields=id,link`).catch(() => []);
      if (Array.isArray(existingBySlug) && existingBySlug.length > 0) {
        const existing = existingBySlug[0];
        console.log(`   ⏩ skip "${article.title.slice(0, 50)}": already in WP (id=${existing.id})`);
        await supa("PATCH", `articles?id=eq.${article.id}`, {
          status: "published",
          wp_post_id: existing.id,
          wp_url: existing.link,
          idempotency_key: idempotencyKey,
          published_at: new Date().toISOString(),
        }).catch(() => {});
        await markKeywordForArticle({
          ...article,
          status: "published",
          wp_post_id: existing.id,
          wp_url: existing.link,
        });
        published.push(article);
        continue;
      }

      const wpPost = await wp("POST", "posts", {
        title: article.title,
        slug: article.slug,
        excerpt: article.meta_description || "",
        content: html,
        status: WP_STATUS,
        categories: catId ? [catId] : [],
        tags: tagIds,
        // _pipeline_lang is read by the aipickd-lang-bridge mu-plugin to set the
        // post's Polylang language → Spanish posts land under /es/ with hreflang.
        // (Dropped the dead _yoast_wpseo_metadesc — no Yoast installed; the
        // excerpt already feeds the aipickd-seo-meta plugin's meta description.)
        meta: { _pipeline_lang: artLang },
      });
      if (tagIds.length > 0) console.log(`   🏷️  Tags: ${tagSlugs.slice(0, 5).join(", ")}...`);
      const finalStatus = WP_STATUS === "publish" ? "published" : "pending_review";

      // Post-publish: add image + schema + ping
      if (WP_STATUS === "publish") {
        const imgUrl = await generateFeaturedImage(
          article.title, article.slug, wpPost.id,
          article.article_type, article.primary_keyword
        );
        // ALWAYS inject schema — decoupled from image success. Schema is a
        // top CTR lever (breadcrumbs, review stars, dates) and must NOT depend
        // on whether DALL-E/Unsplash produced an image this run. Historically
        // ~56% of articles had no schema because image gen failed and skipped
        // this whole block. The schema builder falls back to the default OG
        // image when imgUrl is null.
        const schemaBlock = buildSchemaBlock(
          article, wpPost.link, imgUrl || null, NICHE_TO_CATEGORY_SLUG[article.niche?.slug]
        );
        await wp("POST", `posts/${wpPost.id}`, { content: html + schemaBlock });
        if (imgUrl) {
          await supa("PATCH", `articles?id=eq.${article.id}`, {
            featured_image_url: imgUrl,
          });
        }
        pingSearchEngines(wpPost.link); // fire-and-forget
        purgeCloudflareCache(wpPost.link); // fire-and-forget
      }

      await supa("PATCH", `articles?id=eq.${article.id}`, {
        status: finalStatus,
        wp_post_id: wpPost.id,
        wp_url: wpPost.link,
        idempotency_key: idempotencyKey,
        published_at: new Date().toISOString(),
        quality_score: calcQualityScore(article.word_count, []),
      });
      await markKeywordForArticle({
        ...article,
        status: finalStatus,
        wp_post_id: wpPost.id,
        wp_url: wpPost.link,
      });
      published.push({ title: article.title, wp_id: wpPost.id, url: wpPost.link });
      console.log(`   ✓ ${WP_STATUS === "publish" ? "LIVE" : "Draft"} WP #${wpPost.id}: ${article.title.slice(0, 55)}`);

      // Post-publish URL verification (async, non-blocking)
      if (WP_STATUS === "publish" && wpPost.link) {
        setTimeout(async () => {
          try {
            const verifyRes = await fetch(wpPost.link, {
              signal: AbortSignal.timeout(15000),
              headers: { "User-Agent": "AIPickd-verify/1.0" },
            });
            if (!verifyRes.ok) {
              console.log(`   ⚠️ Post-publish verify: ${wpPost.link} → ${verifyRes.status}`);
              notifyAlert(
                `⚠️ Artículo publicado pero URL retorna **${verifyRes.status}**\n${wpPost.link}`,
                "warning"
              ).catch(() => {});
            } else {
              console.log(`   ✅ URL verified: ${verifyRes.status} (${wpPost.link.slice(-40)})`);
            }
          } catch (e) { /* non-fatal */ }
        }, 8000); // Wait 8s for WP cache to warm up
      }
      // Fire-and-forget rich Discord notification
      if (WP_STATUS === "publish") {
        // Calculate quality score from word count + issues (article already passed QA so 0 issues)
        const qScore = calcQualityScore(article.word_count, []);
        // Get affiliate names from IDs (affiliates_mentioned = array of affiliate IDs)
        const affiliateNames = [];
        try {
          if (article.affiliates_mentioned && article.affiliates_mentioned.length > 0) {
            const affData = await supa("GET", `affiliates?id=in.(${article.affiliates_mentioned.join(',')})&select=brand`);
            if (Array.isArray(affData)) affiliateNames.push(...affData.map(a => a.brand));
          }
        } catch {}
        notifyArticle(
          article.title,
          wpPost.link,
          article.word_count || 0,
          affiliateNames,
          qScore,
          article.featured_image_url || null,
          article.article_type || 'article'
        ).catch(() => {});
      }
    } catch (e) {
      // Surface publish failures to Discord #alertas + count as skipped so
      // the loop summary is honest. Previously the catch was log-only:
      // the run reported published=0 skipped=0 (lie) because skippedCount
      // never incremented on iter errors, masking the bug.
      skippedCount++;
      const errMsg = e?.message || String(e);
      const errStatus = e?.status ? ` [HTTP ${e.status}]` : "";
      const errStack = (e?.stack || "").split("\n").slice(0, 4).join("\n");
      console.log(`${ts()} ✗ Failed for ${article.title}: ${errMsg.slice(0, 200)}${errStatus}`);
      console.log(`     stack: ${errStack}`);
      // Auth errors (401/403) are non-recoverable until WP_ADMIN_PASSWORD is
      // rotated or the user role is fixed. Surface a concrete remediation
      // step in the alert so we don't have to dig through stack traces.
      const isAuthFail = e?.status === 401 || e?.status === 403;
      const remediation = isAuthFail
        ? `\n\n**🛠 Action required:** \`${errMsg.includes("rest_cannot_create") ? "user lacks publish_posts capability" : "credentials rejected"}\`\n` +
          `1. Open aipickd.com/wp-admin → Users → your profile → **Application Passwords**\n` +
          `2. Verify the user role is **Administrator** or **Editor** (Authors can post but not publish others' drafts)\n` +
          `3. Revoke the existing app password + generate a new one named \`github-actions\`\n` +
          `4. Update \`WP_ADMIN_PASSWORD\` in GitHub Secrets, then re-run the workflow`
        : "";
      notifyAlert(
        `🚫 **Publish failed:** ${article.title?.slice(0, 80)}\n` +
        `**Error${errStatus}:** \`${errMsg.slice(0, 300)}\`\n` +
        `**Article ID:** \`${article.id}\` · **Slug:** \`${article.slug}\`\n` +
        `\`\`\`\n${errStack.slice(0, 400)}\n\`\`\`${remediation}`,
        isAuthFail ? "critical" : "warning"
      ).catch(() => {});
      // Tag the article with the failure so the dashboard / next-run logic
      // knows this isn't an unprocessed draft. We DON'T mark qa_failed —
      // the draft itself is valid, the failure is in our publish path. Stay
      // as `draft` but stamp a `last_publish_error` so it's diagnosable.
      await supa("PATCH", `articles?id=eq.${article.id}`, {
        last_updated_at: new Date().toISOString(),
        last_publish_error: errMsg.slice(0, 1000),
        last_error: errMsg.slice(0, 1000),
        last_error_at: new Date().toISOString(),
      }).catch(() => {});
    }

    const articleMs = Date.now() - articleStart;
    if (articleMs > ARTICLE_PUBLISH_BUDGET_MS) {
      console.log(`${ts()} ⚠️  Article publish took ${(articleMs/1000).toFixed(1)}s (exceeded ${ARTICLE_PUBLISH_BUDGET_MS/1000}s budget) — possible upstream slowness`);
    } else {
      console.log(`${ts()} ⏱️  Article publish: ${(articleMs/1000).toFixed(1)}s`);
    }
  }
  return { count: published.length, published, skipped: skippedCount };
}

// --- Main ---
// Timestamp helper for trace logs — every long-running stage prints [HH:MM:SS]
// so a stuck run can be diagnosed without re-running locally.
function ts() {
  const d = new Date();
  return `[${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}:${String(d.getUTCSeconds()).padStart(2,"0")}Z]`;
}

// 20-min soft warning — Discord ping BEFORE the 45-min workflow timeout fires,
// so a stuck run is visible while it still has time to finish (or be killed).
function startSoftTimeoutWarning(label = "pipeline") {
  return setTimeout(() => {
    notifyAlert(
      `⏰ **Soft timeout warning:** \`${label}\` lleva 20 min corriendo en GitHub Actions.\nQuedan ~25 min antes del kill automático. Si no termina, revisar logs.`,
      "warning"
    ).catch(() => {});
  }, 20 * 60_000).unref?.();
}

(async () => {
  const runStart = new Date();
  console.log("══════════════════════════════════════════════════════");
  console.log(`  AIPickd Pipeline Run — ${runStart.toISOString()}`);
  console.log(`  Config: AUTO_PUBLISH=${AUTO_PUBLISH} → WP status=${WP_STATUS}`);
  console.log(`          Generate ${GEN_COUNT}, Publish=${DO_PUBLISH}`);
  console.log("══════════════════════════════════════════════════════\n");

  // ── Pause-flag check ──────────────────────────────────────────────────
  // The Discord bot can flip pipeline_config.paused to TRUE when debugging.
  // If we're paused, abort BEFORE touching keywords/articles so partial
  // state can't leak. Table missing → treat as not paused (don't
  // accidentally block prod if migration hasn't run yet).
  try {
    const cfgRows = await supa(
      "GET",
      "pipeline_config?id=eq.00000000-0000-0000-0000-000000000001&select=paused,paused_reason,paused_by,paused_at,spanish_pipeline_enabled"
    );
    const cfg = Array.isArray(cfgRows) && cfgRows.length > 0 ? cfgRows[0] : null;
    spanishPipelineEnabled = Boolean(cfg && cfg.spanish_pipeline_enabled);
    if (INCLUDE_ES || spanishPipelineEnabled) {
      console.log(`   Spanish gate: enabled (${INCLUDE_ES ? "--include-es" : "pipeline_config"})`);
    } else {
      console.log("   Spanish gate: disabled (language=es keywords ignored)");
    }
    if (cfg && cfg.paused === true) {
      const reason = cfg.paused_reason || "(no reason given)";
      const by = cfg.paused_by || "(unknown)";
      const since = cfg.paused_at ? ` since ${cfg.paused_at}` : "";
      console.log(`⏸  Pipeline paused${since} by ${by}: ${reason}`);
      console.log("    Skipping this run. Resume via Discord bot or directly in Supabase.");
      // Notify so we don't silently no-op forever
      await notifyAlert(
        `⏸ Pipeline paused${since} by **${by}**\nReason: ${reason}\n\nThis run skipped generation + publish. Use \`resume_pipeline\` from the bot when ready.`,
        "info"
      ).catch(() => {});
      process.exit(0);
    }
  } catch (e) {
    // Table might not exist yet (migration pending). Don't block prod on it.
    if (!/PGRST205|relation .* does not exist/i.test(e.message)) {
      console.log(`   ⚠️  pause-flag check failed (continuing anyway): ${e.message.slice(0, 120)}`);
    }
  }

  // Schedule the soft warning. Only meaningful in CI (where a 45-min timeout
  // is enforced); harmless locally.
  startSoftTimeoutWarning("generate.yml");

  // Unstuck any keyword left in `in_progress` by a prior killed run. The
  // workflow's `concurrency: aipickd-mutations / cancel-in-progress: false`
  // guarantees no other run is touching them right now, so it's safe to reset.
  try {
    const orphans = await supa("GET", "keywords?status=eq.in_progress&select=id,keyword");
    if (Array.isArray(orphans) && orphans.length > 0) {
      console.log(`${ts()} 🔓 Found ${orphans.length} orphan keyword(s) stuck in_progress — resetting to queued`);
      await supa("PATCH", "keywords?status=eq.in_progress", { status: "queued" });
    }
  } catch (e) {
    console.log(`${ts()} ⚠️  Orphan unstucker failed: ${e.message.slice(0, 100)}`);
  }

  // --- Generation phase ---
  let totalGenCost = 0;
  let generated = 0;
  if (GEN_COUNT > 0) {
    console.log(`🧠 GENERATION (×${GEN_COUNT})`);
    let dupRetries = 0;
    for (let i = 0; i < GEN_COUNT; i++) {
      try {
        const res = await generateOne();
        if (res.reconciled) {
          // A poisoned keyword (its article already existed) was just cleared.
          // Don't count it — try ANOTHER keyword so the run still produces.
          // Capped so a burst of poisoned keywords can't loop forever.
          if (++dupRetries <= 5) { i--; continue; }
          console.log(`   Stopped after ${dupRetries} duplicate reconciliations this run.`);
          break;
        }
        if (res.skipped) {
          console.log(`   [${i + 1}/${GEN_COUNT}] skipped: ${res.reason}`);
          break;
        }
        generated++;
        totalGenCost += res.cost;
        console.log(
          `   [${i + 1}/${GEN_COUNT}] ✅ "${res.title}" (${res.words} words, $${res.cost.toFixed(4)})`
        );
      } catch (e) {
        console.log(`   [${i + 1}/${GEN_COUNT}] ❌ ${e.message.slice(0, 150)}`);
      }
    }
    console.log();
  }

  // --- Publishing phase ---
  let published = 0;
  let skipped = 0;
  if (DO_PUBLISH) {
    console.log(`📤 PUBLISHING (as ${WP_STATUS}) [quality gate + images + schema]`);
    const res = await publishAllDrafts(20);
    published = res.count;
    skipped = res.skipped || 0;
    console.log(`   Published ${published} drafts, skipped ${skipped} (failed QA)\n`);
    // Publishing loop done — distinguishes "WP path broke" from "post-
    // publish hooks broke" in healthchecks dashboard.
    hcStep("PUBLISH", { message: `published=${published} skipped=${skipped}` });

    // Alert Discord if QA failures are accumulating
    if (skipped > 3) {
      notifyAlert(
        `⚠️ **${skipped} artículos fallaron QA** en este run.\nGeneración produciendo contenido demasiado corto — revisar prompt.\n\nRun: https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
        "warning"
      ).catch(() => {});
    }

    // Auto-add internal links to new articles (post-publish hook)
    if (published > 0) {
      console.log(`🔗 INTERNAL LINKS (auto-link new articles to existing)`);
      try {
        const { spawnSync } = require("child_process");
        const r = spawnSync(process.execPath, [path.join(__dirname, "add-internal-links.js")], {
          stdio: "inherit",
          timeout: 5 * 60 * 1000,
        });
        if (r.status !== 0) console.log(`   ⚠️  internal-links exited ${r.status}`);
      } catch (e) {
        console.log(`   ⚠️  internal-links failed: ${e.message.slice(0, 80)}`);
      }

      // Ping sitemap after publishing (async, non-blocking)
      try {
        const sitemapUrl = `https://www.bing.com/indexnow?url=${encodeURIComponent('https://aipickd.com/sitemap.xml')}&key=${env.INDEXNOW_KEY || 'aipickd2026'}`;
        fetch(sitemapUrl, { signal: AbortSignal.timeout(8000) }).catch(() => {});
        console.log(`   🗺️  Sitemap ping fired (Bing)`);
      } catch {}
    }
  }

  // --- Niche diversity check — alert if 3+ articles from same niche today ---
  try {
    const today = new Date().toISOString().slice(0, 10);
    const todayPublished = await supa("GET", `articles?published_at=gte.${today}&status=eq.published&select=niche_id,niche:niches(name)`);
    if (Array.isArray(todayPublished) && todayPublished.length >= 3) {
      const nicheCounts = {};
      todayPublished.forEach(a => {
        const name = a.niche?.name || a.niche_id || "unknown";
        nicheCounts[name] = (nicheCounts[name] || 0) + 1;
      });
      const overloaded = Object.entries(nicheCounts).filter(([, c]) => c >= 3);
      if (overloaded.length > 0) {
        const msg = overloaded.map(([n, c]) => `• ${n}: ${c} artículos`).join("\n");
        notifyAlert(
          `🎯 **Concentración de nicho detectada hoy:**\n${msg}\n\nConsiderar diversificar keywords en la cola.`,
          "info"
        ).catch(() => {});
      }
    }
  } catch {}

  // --- Keyword queue health check (critical alert at < 20) ---
  try {
    const queuedKwRes = await supa("GET", "keywords?status=eq.queued&select=id");
    const queueCount = Array.isArray(queuedKwRes) ? queuedKwRes.length : 0;
    console.log(`📋 Keywords in queue: ${queueCount}`);
    if (queueCount < 20) {
      notifyAlert(
        `🚨 **CRÍTICO: Cola de keywords muy baja: ${queueCount} restantes**\nEl pipeline se quedará sin contenido en ~${queueCount * 4} horas.\nCorrer: \`node scripts/auto-keywords.js --force --count 50\``,
        "critical"
      ).catch(() => {});
    } else if (queueCount < 30) {
      notifyAlert(
        `📋 **Cola de keywords baja: ${queueCount} restantes**\nEl pipeline se va a quedar sin contenido pronto. auto-keywords.js correrá automáticamente en el próximo run.`,
        "warning"
      ).catch(() => {});
    }
  } catch {}

  // --- Auto-archive qa_failed articles older than 7 days ---
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const archived = await supa(
      "PATCH",
      `articles?status=eq.qa_failed&created_at=lt.${sevenDaysAgo}`,
      { status: "archived" }
    );
    const archivedCount = Array.isArray(archived) ? archived.length : 0;
    if (archivedCount > 0) console.log(`🗄️  Archived ${archivedCount} old qa_failed articles`);
  } catch {}

  // All post-publish hooks ran. Final granular ping — if this is missing
  // but PUBLISH was hit, we know the failure is in poststeps (sitemap,
  // indexnow, internal-links, etc), not in the publish path itself.
  hcStep("POSTSTEPS");

  // --- Pipeline run summary Discord embed ---
  const secs = ((Date.now() - runStart) / 1000).toFixed(1);
  console.log("══════════════════════════════════════════════════════");
  console.log(`  ✅ DONE in ${secs}s`);
  console.log(`     Generated: ${generated} articles ($${totalGenCost.toFixed(4)})`);
  console.log(`     Published: ${published} to WP (${WP_STATUS})`);
  console.log(`     Daily budget: $${DAILY_BUDGET}`);
  console.log("══════════════════════════════════════════════════════");

  // Post pipeline summary to Discord #pipeline-status
  try {
    const { notifyPipeline } = require("./notify.js");
    const costPct = ((totalGenCost / DAILY_BUDGET) * 100).toFixed(0);
    const runIdLink = process.env.GITHUB_RUN_ID
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
    await notifyPipeline(
      `✅ Pipeline completado en ${secs}s`,
      {
        articlesGenerated: generated,
        articlesPublished: published,
        qaFailed: skipped,
        costUsd: totalGenCost,
        budgetPct: Number(costPct),
        runUrl: runIdLink,
      }
    );
  } catch {}
})().catch(async (e) => {
  const message = (e?.message || String(e)).slice(0, 500);
  const stack = (e?.stack || message).slice(0, 1500);
  console.error("\n❌ FATAL:", message);
  // OBSERVABILITY: this used to ONLY console.error → a crash in publishAllDrafts
  // died invisibly to a CI log we couldn't read, while generation had already
  // produced a draft. Now the fatal is BOTH alerted to Discord AND recorded to
  // Supabase (pipeline_config.last_run_error) so it's diagnosable without the log.
  try {
    await notifyAlert(
      `🔥 **Pipeline FATAL (exit 1)**\nEl run murió (la generación pudo haber corrido ya).\n\`\`\`\n${stack.slice(0, 600)}\n\`\`\``,
      "critical"
    );
  } catch (_) {}
  try {
    await supa("PATCH", "pipeline_config?id=eq.00000000-0000-0000-0000-000000000001", {
      last_run_error: { at: new Date().toISOString(), message, stack },
    });
  } catch (_) {}
  process.exit(1);
});
