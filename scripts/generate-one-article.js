#!/usr/bin/env node
/**
 * AIPickd — Content generation bridge test
 * Mimics workflow 02 (Content Generation) standalone.
 *
 * Flow:
 *   1. Get next queued keyword (not already used) from Supabase
 *   2. Mark keyword in_progress
 *   3. Claude — generate outline (JSON)
 *   4. Claude — write full markdown draft
 *   5. GPT-4o — editorial review (strip AI-tells, tighten prose)
 *   6. Get active affiliates
 *   7. Replace [AFFILIATE:brand]Name[/AFFILIATE] tags with real URLs
 *   8. Insert into articles as draft
 *   9. Mark keyword published
 *
 * Usage: node scripts/generate-one-article.js
 */

const fs = require("fs");
const path = require("path");

// --- Parse .env ---
const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL,
  OPENAI_API_KEY,
  OPENAI_MODEL,
} = env;

const CLAUDE_MODEL = ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const GPT_MODEL = OPENAI_MODEL || "gpt-4o";

// --- Helpers ---
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

async function claude(prompt, maxTokens = 4000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude: ${res.status} ${JSON.stringify(data)}`);
  return data.content[0].text;
}

async function gpt(system, user, maxTokens = 8000) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: GPT_MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GPT: ${res.status} ${JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

// --- Main ---
(async () => {
  console.log("== AIPickd generate-one-article ==");
  console.log(`   Claude model: ${CLAUDE_MODEL}`);
  console.log(`   GPT model: ${GPT_MODEL}\n`);

  // 1) Fetch next queued keyword that is NOT already covered
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
  console.log(`   Niche: ${kw.niche?.name || kw.niche_id}`);
  console.log(`   Type: ${kw.article_type}, Intent: ${kw.intent}\n`);

  // 2) Mark in_progress
  console.log("2) Marking keyword in_progress...");
  await supa("PATCH", `keywords?id=eq.${kw.id}`, { status: "in_progress" });
  console.log("   OK.\n");

  // 3) Outline (Claude)
  console.log("3) Generating outline with Claude...");
  const t0 = Date.now();
  const outlinePrompt = `Generate a detailed SEO article outline.

Keyword: ${kw.keyword}
Article type: ${kw.article_type}
Intent: ${kw.intent}
Target word count: 2500
Audience: Small business owners, marketers, creators evaluating AI tools.

Return valid JSON ONLY (no markdown fences, no prose) with: { title (50-60 chars, include keyword), slug (kebab-case), meta_description (150-160 chars), primary_keyword, lsi_keywords (array of 5-7), target_word_count, sections (array of {heading, level, bullets, word_target}), faqs (array of 5 questions), internal_link_ideas (array) }`;
  const outlineText = await claude(outlinePrompt, 3000);
  console.log(`   Claude responded in ${Date.now() - t0}ms, ${outlineText.length} chars\n`);

  // Parse outline
  let cleanOutline = outlineText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let outline;
  try {
    outline = JSON.parse(cleanOutline);
  } catch (e) {
    const match = cleanOutline.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Cannot parse outline as JSON");
    outline = JSON.parse(match[0]);
  }
  console.log(`   Title: "${outline.title}"`);
  console.log(`   Slug: ${outline.slug}\n`);

  // 4) Draft (Claude)
  console.log("4) Writing draft with Claude (this takes ~30s)...");
  const t1 = Date.now();
  const draftPrompt = `You are a world-class technical writer for AI tools reviews. Style: clear, punchy, authoritative. Think Wirecutter meets a smart tech friend.

Write a complete publication-ready article based on this outline:

${JSON.stringify(outline)}

Rules:
1. Use real features, real prices (with date context). If unsure, say 'As of [month 2026]...'
2. Show pros AND cons of every tool.
3. Use comparison tables in markdown when applicable.
4. At first mention of a product, wrap it: [AFFILIATE:brand_name]Product Name[/AFFILIATE]
5. Add a 'Quick verdict' blockquote at the top (before intro) with 2-3 sentences.
6. No AI-tells: avoid 'in today's fast-paced world', 'it's important to note', 'let's dive in', 'revolutionary', 'game-changer', 'seamless', 'cutting-edge'.
7. Use 2nd person (you), active voice, contractions OK.
8. Target ~2500 words.

Output: pure markdown starting with # H1 title, then HTML comment with meta, then quick verdict blockquote, then body. No extra commentary.`;
  const draft = await claude(draftPrompt, 8000);
  console.log(`   Draft ready in ${Date.now() - t1}ms, ${draft.length} chars\n`);

  // 5) GPT editorial review
  console.log("5) GPT-4o editorial review (this takes ~30s)...");
  const t2 = Date.now();
  const reviewed = await gpt(
    "You are a strict editor for a top-tier tech review publication. Improve the draft, don't rewrite it. Remove AI-tells, flag fake claims, tighten prose, ensure balanced view (each tool has real pros AND cons). Keep all [AFFILIATE:...] tags intact. Output: the full revised markdown.",
    draft,
    8000
  );
  console.log(`   Reviewed in ${Date.now() - t2}ms, ${reviewed.length} chars\n`);

  // 6) Get affiliates
  console.log("6) Fetching active affiliates...");
  const affiliates = await supa("GET", "affiliates?status=eq.active");
  console.log(`   ${affiliates.length} active affiliates.\n`);

  // 7) Replace [AFFILIATE:brand]Name[/AFFILIATE] tags
  console.log("7) Inserting affiliate links...");
  const tagRegex = /\[AFFILIATE:([^\]]+)\]([^\[]+)\[\/AFFILIATE\]/gi;
  const affiliatesUsed = new Set();
  const unlinked = new Set();
  const firstSeen = new Map();
  let linked = reviewed.replace(tagRegex, (match, brand, name) => {
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
  // Strip any remaining AFFILIATE tags (no match for those brands)
  linked = linked.replace(tagRegex, (_, __, name) => name);
  console.log(`   Affiliates linked: ${affiliatesUsed.size}`);
  console.log(`   Unlinked brands: ${[...unlinked].join(", ") || "(none)"}\n`);

  // 8) Insert article
  console.log("8) Inserting article into Supabase...");
  const inserted = await supa("POST", "articles", {
    keyword_id: kw.id,
    niche_id: kw.niche_id,
    title: outline.title,
    slug: outline.slug,
    meta_description: outline.meta_description,
    content_markdown: linked,
    article_type: kw.article_type,
    status: "draft",
    generated_by: "bridge",
    word_count: linked.split(/\s+/).length,
    affiliates_mentioned: [...affiliatesUsed],
  });
  const article = Array.isArray(inserted) ? inserted[0] : inserted;
  console.log(`   Article ID: ${article.id}`);
  console.log(`   Word count: ${article.word_count}\n`);

  // 9) Mark keyword done
  console.log("9) Marking keyword published...");
  await supa("PATCH", `keywords?id=eq.${kw.id}`, {
    status: "published",
    assigned_article_id: article.id,
  });
  console.log("   OK.\n");

  console.log("✅ BRIDGE PIPELINE WORKS END-TO-END.");
  console.log(`   Article '${outline.title}' saved as draft in Supabase.`);
  console.log(`   Run: node scripts/publish-one-article.js to push it to WP.`);
})().catch(async (e) => {
  console.error("❌ ERROR:", e.message);
  process.exit(1);
});
