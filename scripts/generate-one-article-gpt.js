#!/usr/bin/env node
/**
 * AIPickd — GPT-only content generation (fallback when Anthropic credits = 0)
 *
 * Same output shape as the Bridge script but uses GPT-4o for both outline
 * and draft, then GPT-4o-mini for editorial polish. Cheaper, single-provider.
 *
 * Flow:
 *   1. Get next queued keyword
 *   2. Mark in_progress
 *   3. GPT-4o — outline JSON
 *   4. GPT-4o — full markdown draft
 *   5. GPT-4o-mini — editorial polish (strip AI-tells, tighten)
 *   6. Get active affiliates, replace [AFFILIATE:brand] tags
 *   7. Insert article as draft
 *   8. Mark keyword published
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY } = env;
// gpt-4o-2024-11-20 supports 16,384 max output tokens vs 4,096 for default gpt-4o
const MODEL_MAIN = "gpt-4o-2024-11-20";
const MODEL_POLISH = "gpt-4o-mini";

async function supa(method, endpoint, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${endpoint}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function gpt(model, system, user, maxTokens = 4000, jsonMode = false) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (jsonMode) body.response_format = { type: "json_object" };
  const attempt = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000); // 3 min
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`GPT ${model}: ${res.status} ${JSON.stringify(data)}`);
      return data.choices[0].message.content;
    } finally {
      clearTimeout(timeout);
    }
  };
  for (let i = 0; i < 3; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (i === 2) throw e;
      console.log(`   (retry ${i + 1} after error: ${e.message})`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

(async () => {
  console.log("== AIPickd generate-one-article (GPT-only) ==");
  console.log(`   Main: ${MODEL_MAIN}  |  Polish: ${MODEL_POLISH}\n`);

  // 1) Fetch next queued keyword
  console.log("1) Fetching next queued keyword...");
  const keywords = await supa(
    "GET",
    "keywords?status=eq.queued&assigned_article_id=is.null&order=priority.desc&limit=1&select=*,niche:niches(slug,name)"
  );
  if (!keywords || keywords.length === 0) {
    console.log("No queued keywords. Nothing to do.");
    return;
  }
  const kw = keywords[0];
  console.log(`   Keyword: "${kw.keyword}"`);
  console.log(`   Niche:   ${kw.niche?.name}`);
  console.log(`   Type:    ${kw.article_type} / ${kw.intent}\n`);

  // 2) Mark in_progress
  await supa("PATCH", `keywords?id=eq.${kw.id}`, { status: "in_progress" });

  try {
    // 3) Outline
    console.log("3) Generating outline (GPT-4o, JSON mode)...");
    const t0 = Date.now();
    const outlineRaw = await gpt(
      MODEL_MAIN,
      "You are an SEO strategist for a top-tier AI tools review publication. Output JSON only.",
      `Generate an SEO article outline.

Keyword: ${kw.keyword}
Article type: ${kw.article_type}
Intent: ${kw.intent}
Target word count: 2500
Audience: Small business owners, marketers, creators evaluating AI tools.

Return a JSON object with keys: title (50-60 chars, includes keyword), slug (kebab-case), meta_description (150-160 chars), primary_keyword, lsi_keywords (array of 5-7), target_word_count, sections (array of objects with heading, level, bullets array, word_target number), faqs (array of 5 question strings), internal_link_ideas (array of strings).`,
      2500,
      true
    );
    console.log(`   Done in ${Date.now() - t0}ms\n`);
    const outline = JSON.parse(outlineRaw);
    console.log(`   Title: "${outline.title}"`);
    console.log(`   Slug:  ${outline.slug}\n`);

    // 4) Draft
    console.log("4) Writing draft (GPT-4o, this takes ~45s)...");
    const t1 = Date.now();
    const draft = await gpt(
      MODEL_MAIN,
      "You are a world-class technical writer for AI tools reviews. Style: clear, punchy, authoritative. Think Wirecutter meets a smart tech friend.",
      `Write a complete publication-ready article based on this outline:

${JSON.stringify(outline)}

Rules:
1. Use real features and realistic prices with date context. If unsure, say "As of April 2026...".
2. Show pros AND cons of every tool.
3. Use markdown comparison tables when applicable.
4. At first mention of a product, wrap it: [AFFILIATE:brand_name_lowercase]Product Name[/AFFILIATE]
5. Add a 'Quick verdict' blockquote at the very top (before the intro) with 2-3 sentences.
6. AVOID AI-tells: "in today's fast-paced world", "it's important to note", "let's dive in", "revolutionary", "game-changer", "seamless", "cutting-edge", "unlock", "harness the power".
7. Use 2nd person ("you"), active voice, contractions OK.
8. Target ~2500 words.
9. End with an FAQ section with the provided FAQs.

Output: pure markdown starting with # H1 title, then an HTML comment <!-- meta: ... -->, then the Quick verdict blockquote, then the body. No commentary before or after.`,
      14000
    );
    console.log(`   Done in ${Date.now() - t1}ms, ${draft.length} chars, ~${draft.split(/\s+/).length} words\n`);

    // 5) Polish
    console.log("5) Editorial polish (GPT-4o-mini)...");
    const t2 = Date.now();
    const polished = await gpt(
      MODEL_POLISH,
      "You are a strict editor for a top-tier tech review publication. Improve the draft, don't rewrite it. Remove AI-tells (in today's world, revolutionary, seamless, game-changer, etc.), tighten prose, ensure every tool has real pros AND cons. Keep all [AFFILIATE:...] tags intact. Keep structure (headings, tables, lists). Output: the full revised markdown only, no commentary.",
      draft,
      14000
    );
    console.log(`   Done in ${Date.now() - t2}ms, ${polished.length} chars\n`);

    // 6) Affiliates
    console.log("6) Fetching active affiliates & inserting links...");
    const affiliates = await supa("GET", "affiliates?status=eq.active");
    const tagRegex = /\[AFFILIATE:([^\]]+)\]([^\[]+)\[\/AFFILIATE\]/gi;
    const affiliatesUsed = new Set();
    const unlinked = new Set();
    const firstSeen = new Map();
    let linked = polished.replace(tagRegex, (_, brand, name) => {
      const clean = brand.trim().toLowerCase();
      const aff = affiliates.find((a) => a.brand.toLowerCase() === clean);
      if (!aff) {
        unlinked.add(brand);
        return name;
      }
      affiliatesUsed.add(aff.id);
      const seen = firstSeen.get(clean) || 0;
      firstSeen.set(clean, seen + 1);
      if (seen >= 2) return name;
      const utm = `utm_source=aipickd&utm_medium=affiliate&utm_campaign=${outline.slug}`;
      const sep = aff.base_url.includes("?") ? "&" : "?";
      return `[${name}](${aff.base_url}${sep}${utm})`;
    });
    linked = linked.replace(tagRegex, (_, __, name) => name);
    console.log(`   Linked: ${affiliatesUsed.size}, Unlinked brands: ${[...unlinked].join(", ") || "(none)"}\n`);

    // 7) Insert article
    console.log("7) Inserting article into Supabase as draft...");
    const inserted = await supa("POST", "articles", {
      keyword_id: kw.id,
      niche_id: kw.niche_id,
      title: outline.title,
      slug: outline.slug,
      meta_description: outline.meta_description,
      content_markdown: linked,
      article_type: kw.article_type,
      status: "draft",
      generated_by: "gpt-only",
      word_count: linked.split(/\s+/).length,
      affiliates_mentioned: [...affiliatesUsed],
    });
    const article = Array.isArray(inserted) ? inserted[0] : inserted;
    console.log(`   Article ID: ${article.id}`);
    console.log(`   Words:      ${article.word_count}\n`);

    // 8) Mark keyword done
    await supa("PATCH", `keywords?id=eq.${kw.id}`, {
      status: "published",
      assigned_article_id: article.id,
    });

    console.log("✅ DONE. Article saved as draft in Supabase.");
    console.log(`   Run: node scripts/publish-one-article.js to push to WP.`);
  } catch (e) {
    // Reset keyword status on failure
    await supa("PATCH", `keywords?id=eq.${kw.id}`, { status: "queued" });
    throw e;
  }
})().catch((e) => {
  console.error("❌ ERROR:", e.message);
  process.exit(1);
});
