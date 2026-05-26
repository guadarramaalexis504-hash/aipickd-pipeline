#!/usr/bin/env node
/**
 * AIPickd — AI Citation tracker via Perplexity API
 *
 * Weekly probe: for a set of relevant queries (pulled from our top-ranking
 * Supabase keywords + a few seed queries), call Perplexity's API and check
 * whether aipickd.com appears in the citations[] array. Record every probe
 * in ai_citations table.
 *
 * Why this matters: shipping Citation Capsules without measuring citations
 * is optimizing blind. This script gives us the feedback loop.
 *
 * Cost: Perplexity API ~$0.005 per query. We probe ~20 queries/week = ~$0.10/week.
 *
 * Usage:
 *   node scripts/check-ai-citations.js              # dry-run (logs only)
 *   node scripts/check-ai-citations.js --go         # actually write to DB
 *   node scripts/check-ai-citations.js --limit 5    # only first N queries
 *
 * Env vars required:
 *   PERPLEXITY_API_KEY    (get one at https://perplexity.ai/settings/api)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   DISCORD_WEBHOOK_PIPELINE (for the summary post)
 */

const { loadEnv } = require("./lib/env");
const { notifyPipeline, notifyAlert } = require("./notify.js");

const env = loadEnv();
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PERPLEXITY_API_KEY,
} = env;

const args = process.argv.slice(2);
const DO_WRITE = args.includes("--go");
const LIMIT = parseInt(args[args.indexOf("--limit") + 1]) || 20;

if (!PERPLEXITY_API_KEY) {
  console.error("❌ Missing PERPLEXITY_API_KEY — set in Railway / GitHub Secrets");
  console.error("   Get one at: https://perplexity.ai/settings/api");
  console.error("   Cost: ~$0.005 per query (~$5/mo at our probe volume)");
  process.exit(2);
}

const SUPA_HEADERS = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

async function supaGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: SUPA_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Supabase GET: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function supaInsert(path, rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`Supabase INSERT: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

/**
 * Probe a single query via Perplexity's chat/completions API.
 * Returns { cited, position, totalSources, excerpt, raw }.
 *
 * Perplexity returns sources in `citations` (legacy) or `search_results`
 * depending on model. We check both to be defensive.
 */
async function probePerplexity(query) {
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar", // cheapest model with web search + citations
      messages: [{ role: "user", content: query }],
      max_tokens: 500,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Perplexity ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();

  const sources = data.citations || data.search_results || [];
  const sourceUrls = sources.map((s) => typeof s === "string" ? s : s.url || "").filter(Boolean);

  const aipickdIndex = sourceUrls.findIndex((u) => /(?:^|\.)aipickd\.com/i.test(u));
  const cited = aipickdIndex !== -1;
  const excerpt = (data.choices?.[0]?.message?.content || "").slice(0, 500);

  return {
    cited,
    position: cited ? aipickdIndex + 1 : null,
    cited_url: cited ? sourceUrls[aipickdIndex] : null,
    totalSources: sourceUrls.length,
    excerpt,
    raw: data,
  };
}

/**
 * Pick the queries to probe. Strategy: take the top-priority published
 * keywords from Supabase (they correspond to articles we WANT cited) +
 * a few hand-curated seed queries that test the general domain.
 */
async function pickQueries(limit) {
  const seedQueries = [
    "best AI tools for content writing 2026",
    "best AI tools for video editing 2026",
    "best AI coding assistants 2026",
    "AI hosting comparison 2026",
    "Jasper AI vs Writesonic 2026",
  ];

  // Pull top keywords whose articles are published
  try {
    const keywords = await supaGet(
      `keywords?status=eq.published&order=priority.desc,search_volume.desc&limit=${Math.max(0, limit - seedQueries.length)}&select=keyword`
    );
    const fromDb = keywords.map((k) => k.keyword).filter(Boolean);
    return [...seedQueries, ...fromDb].slice(0, limit);
  } catch (e) {
    console.log(`⚠️  Couldn't pull keywords from DB (${e.message.slice(0, 80)}), using seeds only`);
    return seedQueries.slice(0, limit);
  }
}

(async () => {
  console.log(`\n🔍 AI Citation Probe (Perplexity)\n`);
  console.log(`Mode: ${DO_WRITE ? "LIVE WRITE" : "DRY RUN"}`);

  const queries = await pickQueries(LIMIT);
  console.log(`Probing ${queries.length} queries...\n`);

  const results = [];
  let citedCount = 0;
  let totalCostUsd = 0;

  for (const [i, q] of queries.entries()) {
    process.stdout.write(`  [${i + 1}/${queries.length}] "${q.slice(0, 60)}..." `);
    try {
      const r = await probePerplexity(q);
      results.push({ query: q, ...r });
      totalCostUsd += 0.005; // rough per-query estimate
      if (r.cited) {
        citedCount++;
        console.log(`✅ cited #${r.position}/${r.totalSources} → ${r.cited_url}`);
      } else {
        console.log(`❌ not cited (${r.totalSources} sources, none aipickd)`);
      }
      // Throttle ~1.5s between calls to be a polite client
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      console.log(`⚠️  error: ${e.message.slice(0, 80)}`);
      results.push({ query: q, error: e.message });
    }
  }

  const citationRate = queries.length > 0 ? (citedCount / queries.length) * 100 : 0;

  console.log(`\n📊 Summary:`);
  console.log(`  Queries probed:   ${queries.length}`);
  console.log(`  Citations:        ${citedCount} (${citationRate.toFixed(1)}%)`);
  console.log(`  Cost estimate:    $${totalCostUsd.toFixed(3)}`);

  if (DO_WRITE) {
    const rows = results.filter((r) => !r.error).map((r) => ({
      source: "perplexity",
      query: r.query,
      cited: r.cited,
      cited_url: r.cited_url,
      citation_position: r.position,
      total_sources: r.totalSources,
      response_excerpt: r.excerpt,
      raw_response: r.raw,
    }));
    if (rows.length > 0) {
      await supaInsert("ai_citations", rows);
      console.log(`  💾 Inserted ${rows.length} probes into ai_citations`);
    }

    // Compare to last week — meaningful only if we have history
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const lastWeek = await supaGet(
        `ai_citations?source=eq.perplexity&probed_at=gte.${weekAgo}&select=cited`
      );
      const prev = lastWeek.filter((c) => c.cited).length;
      const delta = citedCount - prev;
      const arrow = delta > 0 ? "📈" : delta < 0 ? "📉" : "➖";

      await notifyPipeline(
        `🔍 **AI Citation Probe — Perplexity**\n` +
        `Citations this run: **${citedCount}/${queries.length}** (${citationRate.toFixed(0)}%)\n` +
        `vs last 7d: ${arrow} ${delta >= 0 ? "+" : ""}${delta}\n` +
        `Cost: $${totalCostUsd.toFixed(3)}`,
        { articlesGenerated: 0, keywordsRemaining: 0 }
      ).catch(() => {});
    } catch (e) {
      console.log(`  ⚠️  comparison query failed: ${e.message.slice(0, 80)}`);
    }
  } else {
    console.log(`\n💡 Dry run — pass --go to write results to DB and notify Discord.`);
  }
})().catch((e) => {
  console.error(`❌ FATAL: ${e.message}`);
  notifyAlert(`check-ai-citations.js failed: ${e.message.slice(0, 200)}`, "warning").catch(() => {});
  process.exit(1);
});
