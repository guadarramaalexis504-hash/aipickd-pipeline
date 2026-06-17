#!/usr/bin/env node
/**
 * AIPickd — Auto Keywords Generator
 *
 * Runs after each pipeline run (or can be triggered manually / via GitHub Actions).
 * When the keyword queue drops below QUEUE_LOW_THRESHOLD, auto-generates new
 * keywords using GPT-4o and inserts them into Supabase.
 *
 * Strategy:
 *   1. Check current queue size
 *   2. If below threshold, fetch active niches + already-queued keywords
 *   3. GPT generates N unique keywords per niche (avoids duplicates)
 *   4. Insert into keywords table with status=queued
 *   5. Notify Discord if keywords were added
 *
 * Usage:
 *   node scripts/auto-keywords.js           # auto-mode: only runs if queue < 50
 *   node scripts/auto-keywords.js --force   # force-generate 20 new keywords
 *   node scripts/auto-keywords.js --count 30 # generate exactly 30
 */

const { loadEnv } = require("./lib/env");
const env = loadEnv();

const QUEUE_LOW_THRESHOLD = parseInt(process.env.QUEUE_LOW_THRESHOLD || "50");
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const COUNT = parseInt(args[args.indexOf("--count") + 1]) || 20;

// Article types and intents for keyword generation
const ARTICLE_CONFIGS = [
  { type: "comparison", intent: "comparison", weight: 2 },
  { type: "list", intent: "informational", weight: 2 },
  { type: "review", intent: "review", weight: 2 },
  { type: "how-to", intent: "how-to", weight: 1 },
];

async function supa(method, endpoint, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`Supabase ${method} ${endpoint}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function gptJson(prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-2024-11-20",
      max_tokens: 4000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are an SEO keyword researcher for a BRAND-NEW, ZERO-AUTHORITY website. " +
            "A new site cannot rank for competitive head terms — only for ultra-specific, " +
            "low-competition long-tail queries. You ONLY produce winnable long-tail keywords. " +
            "Output JSON only.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GPT: ${JSON.stringify(data).slice(0, 200)}`);
  return JSON.parse(data.choices[0].message.content);
}

(async () => {
  console.log("\n🔑 AIPickd Auto-Keywords Generator\n");

  // 1. Check queue size
  const queueRes = await supa("GET", "keywords?status=eq.queued&select=id");
  const queueSize = Array.isArray(queueRes) ? queueRes.length : 0;
  console.log(`   Queue size: ${queueSize}`);

  if (!FORCE && queueSize >= QUEUE_LOW_THRESHOLD) {
    console.log(`   ✅ Queue healthy (${queueSize} >= ${QUEUE_LOW_THRESHOLD}). Nothing to do.`);
    return;
  }

  const needed = FORCE ? COUNT : Math.max(COUNT, QUEUE_LOW_THRESHOLD - queueSize + 20);
  console.log(`   🔧 Generating ${needed} new keywords...`);

  // 2. Fetch niches + existing keywords (to avoid duplicates)
  const [niches, existingKws] = await Promise.all([
    supa("GET", "niches?select=id,name,slug"),
    supa("GET", "keywords?select=keyword&limit=500&order=discovered_at.desc"),
  ]);

  if (!Array.isArray(niches) || niches.length === 0) {
    console.error("   ❌ No niches found in database.");
    process.exit(1);
  }

  const existingSet = new Set((existingKws || []).map((k) => k.keyword.toLowerCase().trim()));
  console.log(
    `   📚 Found ${niches.length} niches, ${existingSet.size} existing keywords to avoid`
  );

  // 3. Generate keywords per niche using GPT
  const allNewKeywords = [];

  for (const niche of niches) {
    const perNiche = Math.ceil(needed / niches.length);

    // Weighted article type selection
    const types = ARTICLE_CONFIGS.flatMap((c) => Array(c.weight).fill(c));
    const shuffledTypes = types
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.min(perNiche, types.length));

    try {
      const result =
        await gptJson(`Generate ${perNiche} ULTRA-SPECIFIC LONG-TAIL SEO keywords for a NEW, zero-authority website about AI tools, niche: "${niche.name}".

CRITICAL CONTEXT: brand-new domain, NO authority. It CANNOT rank for competitive head terms. We need keywords where a new site can realistically reach Google page 1 — narrow, specific, low competition. Lower search volume is GOOD if it means we can actually rank and get clicks.

STRICT RULES:
- Each keyword MUST be 6-12 words: a NARROW audience + a NARROW task + ideally a specific tool, constraint, price, or platform.
- Favor question-style and problem-style queries a real person types when stuck.
- ENGLISH. Real solving/buying intent.
- BANNED — do NOT generate these, they are too competitive for a new site:
  * "best AI [broad category] tools 2026", "top N AI tools for [broad audience]", "best AI writing/coding/video/image tools"
  * any generic 3-6 word head term, anything a big site (Zapier, G2, TechRadar) already owns.
- GOOD examples (THIS is the style we want):
  * "how to remove the watermark from AI generated images for free"
  * "ChatGPT vs Claude for writing cold outreach emails that get replies"
  * "best free AI logo maker for a small bakery with no design skills"
  * "can Notion AI accurately summarize a two hour meeting transcript"
  * "cheapest AI tool to turn one blog post into a youtube script"
  * "how to make Midjourney images that do not look AI generated"
- For EACH keyword, judge "competition": "low" or "medium". NEVER output "high" — if the best you can do is high, make it more specific.
- AVOID near-duplicates of existing keywords below.

Existing keywords to AVOID:
${Array.from(existingSet).slice(0, 100).join(", ")}

Return JSON: { "keywords": [ { "keyword": "string", "article_type": "comparison|list|review|how-to", "intent": "comparison|informational|review|how-to", "search_volume_estimate": 10-800, "competition": "low|medium" } ] }`);

      if (Array.isArray(result.keywords)) {
        for (const kw of result.keywords) {
          const phrase = (kw.keyword || "").trim();
          const normalized = phrase.toLowerCase();
          if (!normalized || existingSet.has(normalized)) continue;
          // Defense-in-depth: reject head terms even if GPT slips. A winnable
          // long-tail keyword for a zero-authority site is specific (>=6 words)
          // and not a generic "best/top AI X tools" pattern a big site owns.
          const wordCount = normalized.split(/\s+/).filter(Boolean).length;
          const isHeadTerm =
            wordCount < 6 ||
            /^(?:best|top)\s+\d*\s*ai\b/.test(normalized) ||
            /\bbest\s+ai\s+\w+\s+tools?\b/.test(normalized) ||
            /^top\s+\d+\s+ai\b/.test(normalized);
          if (isHeadTerm) continue;
          existingSet.add(normalized); // prevent self-duplicates within this batch
          const lowComp = String(kw.competition || "medium").toLowerCase() === "low";
          // Winnability priority: long-tail leads the queue (above the legacy
          // head terms at ~10) but below the Spanish front-of-queue (1000).
          const priority = 40 + (lowComp ? 10 : 0) + (wordCount >= 8 ? 5 : 0);
          allNewKeywords.push({
            keyword: phrase,
            niche_id: niche.id,
            intent: kw.intent || "informational",
            article_type: kw.article_type || "how-to",
            search_volume: Math.min(800, kw.search_volume_estimate || 120),
            priority,
            status: "queued",
            discovered_at: new Date().toISOString(),
          });
        }
      }
    } catch (e) {
      console.log(`   ⚠️  GPT error for niche "${niche.name}": ${e.message.slice(0, 80)}`);
    }
  }

  if (allNewKeywords.length === 0) {
    console.log("   ⚠️  No new keywords generated. Try again or check GPT response.");
    return;
  }

  // 4. Insert into Supabase (batch insert)
  console.log(`   💾 Inserting ${allNewKeywords.length} keywords into Supabase...`);

  // Insert in batches of 50 to avoid request size limits
  let inserted = 0;
  for (let i = 0; i < allNewKeywords.length; i += 50) {
    const batch = allNewKeywords.slice(i, i + 50);
    try {
      await supa("POST", "keywords", batch);
      inserted += batch.length;
    } catch (e) {
      console.log(`   ⚠️  Batch insert error: ${e.message.slice(0, 100)}`);
    }
  }

  console.log(`   ✅ Inserted ${inserted} new keywords`);

  // 5. Notify Discord
  if (inserted > 0) {
    const { notifyAlert } = require("./notify.js");
    const nicheBreakdown = allNewKeywords.reduce((acc, k) => {
      const niche = niches.find((n) => n.id === k.niche_id);
      const name = niche?.name || "Unknown";
      acc[name] = (acc[name] || 0) + 1;
      return acc;
    }, {});
    const nicheLines = Object.entries(nicheBreakdown)
      .map(([n, c]) => `• ${n}: +${c}`)
      .join("\n");

    await notifyAlert(
      `🔑 **Auto-keywords: ${inserted} keywords añadidos a la cola**\n\nNueva cola total: ~${queueSize + inserted} keywords\n\n${nicheLines}`,
      "info"
    ).catch(() => {});
  }

  const newTotal = queueSize + inserted;
  console.log(`\n   📊 Queue was ${queueSize} → now ~${newTotal}`);
  console.log("\nDone!");
})().catch((e) => {
  console.error("❌ Auto-keywords failed:", e.message);
  process.exit(1);
});
