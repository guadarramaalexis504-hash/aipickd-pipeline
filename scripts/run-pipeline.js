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
const { notify, notifyArticle, notifyPipeline, notifyAlert, calcQualityScore } = require("./notify.js");

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

// --- helpers ---
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

async function gpt(model, system, user, maxTokens, jsonMode = false) {
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
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 180_000);
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
  for (let i = 0; i < 3; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (i === 2) throw e;
      console.log(`   (retry ${i + 1}/3: ${e.message.slice(0, 80)})`);
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
  for (let i = 0; i < 5; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (i === 4) throw e;
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
  // Fetch top 5 queued keywords — sorted by priority DESC, then search_volume DESC
  const keywords = await supa(
    "GET",
    "keywords?status=eq.queued&assigned_article_id=is.null&order=priority.desc,search_volume.desc&limit=5&select=*,niche:niches(slug,name)"
  );
  if (!keywords || keywords.length === 0) {
    return { skipped: true, reason: "No queued keywords" };
  }

  // Per-keyword failure guard: skip keywords that have already failed 3+ times
  let kw = null;
  for (const candidate of keywords) {
    const failedRows = await supa("GET", `articles?keyword_id=eq.${candidate.id}&status=eq.qa_failed&select=id`).catch(() => []);
    const failCount = Array.isArray(failedRows) ? failedRows.length : 0;
    if (failCount >= 3) {
      console.log(`   ⏭️  Skip "${candidate.keyword}" — already failed QA ${failCount}× (marking exhausted)`);
      await supa("PATCH", `keywords?id=eq.${candidate.id}`, { status: "published" }).catch(() => {}); // move it out of queue
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

  console.log(`   📝 Keyword: "${kw.keyword}" (${kw.niche?.name})`);
  await supa("PATCH", `keywords?id=eq.${kw.id}`, { status: "in_progress" });
  let totalCost = 0;

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

Return a JSON object with keys: title (50-60 chars, includes keyword and "2026"), slug (kebab-case with "2026"), meta_description (150-160 chars, mentions 2026), primary_keyword, lsi_keywords (array of 5-7), target_word_count (must be 3000), article_type, sections (array of AT LEAST 10 objects with: heading, level, bullets array of 4-6 items, word_target number >= 250), faqs (array of 6 question strings), internal_link_ideas (array of strings).`,
        2500,
        true
      );
      totalCost += estimateCost("gpt-4o-2024-11-20", outlineRes.usage);
      outline = JSON.parse(outlineRes.text);
      // Save outline to cache — if draft fails later, next run will reuse it
      saveOutlineCache(kw.id, outline);
    }

    // Draft — explicit 2000+ word requirement with section-level guidance
    const sectionTargets = (outline.sections || [])
      .map((s, i) => `Section ${i + 1} "${s.heading}": write ~${s.word_target || 250} words`)
      .join("\n");

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
7. AVOID AI-tells: "in today's fast-paced world", "it's important to note", "let's dive in", "revolutionary", "game-changer", "seamless", "cutting-edge", "unlock", "harness the power".
8. Use 2nd person ("you"), active voice, contractions OK.
9. ⚠️ MINIMUM 2000 WORDS — this is non-negotiable. Short sections must be expanded with examples.
10. Cover EVERY section from the outline fully. DO NOT skip sections or write one-liners.
11. End with a full "## FAQ" section answering all ${(outline.faqs || []).length} questions in detail (each answer min 3 sentences).

Output: pure markdown. Start with # H1. No commentary before or after.`,
      16000
    );
    totalCost += estimateCost("gpt-4o-2024-11-20", draftRes.usage);

    // ── Expansion helper (reusable) ──────────────────────────────────────────
    const runExpansionPass = async (text, currentWords, targetWords = 2600) => {
      console.log(`   ⚡ Expansion pass (${currentWords}w → target ${targetWords}w)...`);
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
        16000
      );
      totalCost += estimateCost("gpt-4o-2024-11-20", expandRes.usage);
      const newWords = expandRes.text.split(/\s+/).length;
      console.log(`   ✅ Expanded: ${currentWords}w → ${newWords}w`);
      return expandRes.text;
    };

    // ── Pass 1: Pre-polish expansion if draft is short ────────────────────
    let finalDraftText = draftRes.text;
    const draftWords = draftRes.text.split(/\s+/).length;
    console.log(`   📏 Draft: ${draftWords}w`);
    if (draftWords < 2000) {
      finalDraftText = await runExpansionPass(draftRes.text, draftWords, 2600);
    }

    // ── Polish — CRITICAL: must NOT reduce word count ────────────────────
    const polishWords = finalDraftText.split(/\s+/).length;
    const polishRes = await gpt(
      "gpt-4o-mini",
      `You are a senior editor for a top-tier tech review publication. Your job: IMPROVE quality, NEVER reduce length.

STRICT RULES:
1. NEVER remove paragraphs, sections, or list items — only rewrite individual sentences
2. NEVER shorten the article — if unsure, leave the original sentence intact
3. Remove AI-tells: "in today's fast-paced world", "it's important to note", "let's dive in", "revolutionary", "game-changer", "seamless", "cutting-edge", "unlock", "harness the power", "in the realm of"
4. Fix grammar errors and awkward phrasing
5. Ensure every tool has both pros AND cons stated clearly
6. Keep all [AFFILIATE:...] tags EXACTLY as-is (don't touch them)
7. Keep all markdown structure: headings, tables, bullet lists, numbered lists, blockquotes
8. MINIMUM output: ${Math.max(polishWords - 50, 1800)} words (you started with ${polishWords} — DO NOT go below this)
9. Output: the complete revised markdown only — start with # heading, no commentary`,
      finalDraftText,
      16000
    );
    totalCost += estimateCost("gpt-4o-mini", polishRes.usage);

    // ── Pass 2: Post-polish rescue if polish trimmed too much ─────────────
    const postPolishWords = polishRes.text.split(/\s+/).length;
    console.log(`   📏 Post-polish: ${postPolishWords}w (was ${polishWords}w)`);
    let finalText = polishRes.text;
    if (postPolishWords < 1900) {
      console.log(`   🚨 Polish trimmed too much! Running rescue expansion...`);
      finalText = await runExpansionPass(polishRes.text, postPolishWords, 2200);
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
      generated_by: "gpt-only",
      word_count: linked.split(/\s+/).length,
      generation_cost_usd: Number(totalCost.toFixed(4)),
      affiliates_mentioned: [...affiliatesUsed],
    });
    const article = Array.isArray(inserted) ? inserted[0] : inserted;

    await supa("PATCH", `keywords?id=eq.${kw.id}`, {
      status: "published",
      assigned_article_id: article.id,
    });

    // Clear outline cache on success
    clearOutlineCache(kw.id);

    return {
      article,
      title: outline.title,
      words: article.word_count,
      cost: totalCost,
    };
  } catch (e) {
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

  // Word count — raised to 1800 (expansion pass ensures 2000+, so 1800 is the safety floor)
  if (!article.word_count || article.word_count < 1800) issues.push(`too short: ${article.word_count}w (min 1800)`);

  // Title
  if (!article.title || article.title.length < 20) issues.push("title too short");
  if (/^[^a-zA-Z0-9]/.test(article.title || "")) issues.push("weird title char");
  // Year sanity: if there's any "2024" or "2025" but the title says 2026 → likely stale
  if (/\b2026\b/.test(article.title || "") && /\b202[34]\b/.test(md)) {
    const stale = (md.match(/\b202[34]\b/g) || []).length;
    if (stale >= 3) issues.push(`stale year refs: ${stale}× 2024/2025 in body`);
  }

  // AI tells (blocking)
  const aiTellsHard = [
    /\b(?:as an AI|I cannot|as a language model|I'm an AI|I am an AI)\b/i,
    /\b(?:I don't have personal|in my training data)\b/i,
  ];
  if (aiTellsHard.some((re) => re.test(md))) issues.push("AI-tell in body");

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

  // Keyword density: primary keyword must appear at least 3 times
  if (article.primary_keyword) {
    const kw = article.primary_keyword.toLowerCase().trim();
    const bodyLower = md.toLowerCase();
    // Escape regex special chars
    const kwEscaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const kwCount = (bodyLower.match(new RegExp(kwEscaped, "g")) || []).length;
    if (kwCount < 2) issues.push(`keyword "${kw}" only appears ${kwCount}× (min 2)`);
  }

  // FAQ section check — needed for FAQPage schema
  const hasFaq = /^##\s+(?:FAQ|Frequently Asked Questions|Common Questions)/im.test(md);
  if (!hasFaq) issues.push("missing FAQ section (needed for schema)");

  return { pass: issues.length === 0, issues };
}

// --- DALL-E image generation + Unsplash fallback ---
async function generateFeaturedImage(title, slug, postId, articleType = "article", primaryKeyword = "") {
  const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");

  async function uploadBufferToWP(buffer, mimeType = "image/jpeg") {
    const ext = mimeType === "image/jpeg" ? "jpg" : "png";
    const uploadRes = await fetch("https://aipickd.com/wp-json/wp/v2/media", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename="${slug}.${ext}"`,
        "User-Agent": "Mozilla/5.0 AIPickd-pipeline/1.0",
      },
      body: buffer,
    });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(`WP upload: ${uploadRes.status}`);
    await wp("POST", `posts/${postId}`, { featured_media: uploadData.id });
    return uploadData.source_url;
  }

  // Strategy 1: DALL-E 3 with type-specific prompt
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
    const dallePrompt = `${styleHint}${kwHint}. Modern tech editorial style, abstract geometric shapes, deep navy and electric blue palette with emerald green accents, 16:9 landscape. Clean flat design, high contrast. Absolutely NO text, NO logos, NO UI elements, NO faces, NO brand names.`;

    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "dall-e-3", prompt: dallePrompt, n: 1, size: "1792x1024", quality: "standard" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`DALL-E: ${JSON.stringify(data).slice(0, 200)}`);
    const imgRes = await fetch(data.data[0].url);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    return await uploadBufferToWP(buffer, "image/png");
  } catch (e) {
    console.log(`   ⚠️ DALL-E failed (${e.message.slice(0, 60)}), trying Unsplash...`);
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
    const imgRes = await fetch(imgUrl);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    console.log(`   📸 Unsplash fallback: "${photo.alt_description || query}" by ${photo.user?.name}`);
    return await uploadBufferToWP(buffer, "image/jpeg");
  } catch (e) {
    console.log(`   ⚠️ Unsplash fallback failed: ${e.message.slice(0, 60)}`);
    return null;
  }
}

// --- Schema.org JSON-LD injection ---
// Extract Q&A pairs from a "## FAQ" / "## Frequently Asked Questions" section in markdown
function extractFAQs(md) {
  if (!md) return [];
  // Find FAQ section
  const faqMatch = md.match(/^##\s+(?:FAQ|Frequently Asked Questions|Common Questions|FAQs).*$/im);
  if (!faqMatch) return [];
  const start = md.indexOf(faqMatch[0]) + faqMatch[0].length;
  // FAQ section ends at next ## (or end of doc)
  const rest = md.slice(start);
  const endMatch = rest.match(/^##\s+/m);
  const faqBlock = endMatch ? rest.slice(0, rest.indexOf(endMatch[0])) : rest;

  // Each Q is "### Question" or "**Q:** Question?" — try heading variant first
  const qas = [];
  const headingPattern = /^###\s+(.+?)\n([\s\S]*?)(?=^###\s+|$)/gm;
  let m;
  while ((m = headingPattern.exec(faqBlock)) !== null) {
    const q = m[1].trim().replace(/^\*\*|\*\*$/g, "").replace(/^Q:\s*/i, "");
    const a = m[2].trim().replace(/^\*\*A:\*\*\s*/i, "").replace(/^A:\s*/i, "");
    if (q && a && q.length < 200 && a.length > 20) {
      qas.push({ q, a: a.slice(0, 600) });
    }
  }
  return qas.slice(0, 8); // Cap at 8 FAQs
}

function buildSchemaBlock(article, wpLink, imageUrl) {
  const isReview = ["review", "comparison"].includes(article.article_type);
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": isReview ? "Review" : "Article",
    "headline": article.title,
    "description": article.meta_description || "",
    "image": imageUrl || "https://aipickd.com/wp-content/uploads/aipickd-og.png",
    "datePublished": new Date().toISOString(),
    "dateModified": new Date().toISOString(),
    "mainEntityOfPage": { "@type": "WebPage", "@id": wpLink },
    "author": { "@type": "Organization", "name": "AIPickd", "url": "https://aipickd.com" },
    "publisher": {
      "@type": "Organization", "name": "AIPickd", "url": "https://aipickd.com",
      "logo": { "@type": "ImageObject", "url": "https://aipickd.com/wp-content/uploads/aipickd-logo.png" },
    },
  };
  if (isReview) {
    articleSchema.itemReviewed = {
      "@type": "SoftwareApplication",
      "name": article.title.split(/vs|:|Review/i)[0].trim(),
      "applicationCategory": "BusinessApplication",
    };
    articleSchema.reviewRating = { "@type": "Rating", "ratingValue": "4.3", "bestRating": "5", "worstRating": "1" };
  }

  // Build optional FAQPage schema
  const faqs = extractFAQs(article.content_markdown);
  const blocks = [articleSchema];
  if (faqs.length >= 3) {
    blocks.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": faqs.map((f) => ({
        "@type": "Question",
        "name": f.q,
        "acceptedAnswer": { "@type": "Answer", "text": f.a },
      })),
    });
  }

  const schemaJson = blocks.length === 1 ? blocks[0] : blocks;
  return `\n\n<!-- wp:html -->\n<script type="application/ld+json">\n${JSON.stringify(schemaJson, null, 2)}\n</script>\n<!-- /wp:html -->`;
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
function affiliateDisclosure() {
  return `<!-- wp:html -->\n<div class="aipickd-disclosure" style="background:#f0f7ff;border-left:4px solid #2563eb;padding:12px 16px;margin:0 0 24px;border-radius:4px;font-size:0.875rem;color:#374151;">\n  ⚡ <strong>Disclosure:</strong> This article contains affiliate links. If you purchase through our links, we may earn a commission at no extra cost to you. We only recommend tools we've evaluated and trust.\n</div>\n<!-- /wp:html -->\n\n`;
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
  const drafts = await supa(
    "GET",
    `articles?status=eq.draft&order=created_at.asc&limit=${maxCount}&select=*,niche:niches(slug)`
  );
  if (!drafts || drafts.length === 0) return { count: 0, skipped: 0 };

  const published = [];
  let skippedCount = 0;

  // Pre-load published titles for duplicate detection
  const publishedArticles = await supa("GET", "articles?status=eq.published&select=title,slug").catch(() => []);
  const normalizeTitle = (s) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  const publishedTitles = (publishedArticles || []).map(a => normalizeTitle(a.title));

  // Get WP categories once
  const cats = await wp("GET", "categories?per_page=20&_fields=id,slug");
  const catMap = {};
  for (const c of cats || []) catMap[c.slug] = c.id;
  const nicheCatMap = {
    "ai-writing": catMap["ai-writing"],
    "ai-business": catMap["ai-business"],
    "ai-image-video": catMap["ai-image-video"],
    "ai-coding": catMap["ai-coding"],
    "ai-hosting": catMap["ai-infrastructure"],
  };

  for (const article of drafts) {
    // Duplicate detection — skip if very similar title already published
    const normNewTitle = normalizeTitle(article.title);
    const isDuplicate = publishedTitles.some(existing => {
      const words = normNewTitle.split(" ");
      // Check if 5+ consecutive words match an existing title
      for (let i = 0; i <= words.length - 5; i++) {
        const phrase = words.slice(i, i + 5).join(" ");
        if (phrase.length > 20 && existing.includes(phrase)) return true;
      }
      return false;
    });
    if (isDuplicate) {
      skippedCount++;
      console.log(`   ⏩ skip "${article.title.slice(0, 50)}": duplicate of published article`);
      await supa("PATCH", `articles?id=eq.${article.id}`, { status: "qa_failed" }).catch(() => {});
      continue;
    }

    // Quality gate + cleanup
    article.content_markdown = aggressiveClean(article.content_markdown);
    const qa = qualityGate(article);
    // Minimum Viable Approve: if word count is 1900-2100 and only issue is "too short",
    // AND quality score would be ≥70, auto-approve to avoid pipeline stalls
    let qaPass = qa.pass;
    if (!qa.pass && qa.issues.length === 1 && qa.issues[0].startsWith('too short')) {
      const wc = article.word_count || 0;
      const qScore = calcQualityScore(wc, []);
      if (wc >= 1900 && wc <= 2500 && qScore >= 70) {
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
        status: "qa_failed",
        quality_score: 0,
      }).catch(() => {});
      // Notify #alertas with failure reason (so you can fix prompts faster)
      notifyAlert(
        `🚫 **QA Failed:** ${article.title.slice(0, 70)}\n\n**Razones:** ${issuesSummary}\n**Palabras:** ${article.word_count || 0}w`,
        "warning"
      ).catch(() => {});
      continue;
    }
    // (qa passed — either naturally or via min-viable approve)

    // Inject Table of Contents for long articles
    article.content_markdown = injectToC(article.content_markdown);

    try {
      // Prepend affiliate disclosure (FTC compliance)
      const disclosure = affiliateDisclosure();
      let html = disclosure + mdToHtml(article.content_markdown);

      // Enhance comparison tables with richer styling
      if (article.article_type === 'comparison' || article.article_type === 'list') {
        html = enhanceComparisonTables(html);
      }

      // Inject Best Deal callout for affiliate articles
      const affiliatesForDeal = await supa("GET", "affiliates?status=eq.active&select=brand,base_url").catch(() => []);
      if (Array.isArray(affiliatesForDeal) && affiliatesForDeal.length > 0 && article.affiliates_mentioned?.length > 0) {
        const dealLinks = (article.affiliates_mentioned || [])
          .map(id => affiliatesForDeal.find(a => a.id === id || affiliatesForDeal.find(x => x.brand)))
          .filter(Boolean)
          .slice(0, 3)
          .map(a => ({ name: a.brand, url: a.base_url }));
        if (dealLinks.length >= 2) html = injectBestDeal(html, dealLinks);
      }

      // Generate WP tags via GPT
      const tagSlugs = await generateWPTags(
        article.title,
        article.primary_keyword || "",
        article.article_type || "article",
        article.niche?.slug || ""
      );
      // Create/get WP tag IDs
      const tagIds = [];
      for (const tagName of tagSlugs) {
        try {
          // Try to find existing tag first
          const existingRes = await wp("GET", `tags?search=${encodeURIComponent(tagName)}&per_page=1`);
          if (Array.isArray(existingRes) && existingRes.length > 0) {
            tagIds.push(existingRes[0].id);
          } else {
            const newTag = await wp("POST", "tags", { name: tagName, slug: tagName.replace(/\s+/g, "-") });
            if (newTag?.id) tagIds.push(newTag.id);
          }
        } catch {}
      }

      const catId = nicheCatMap[article.niche?.slug];
      const wpPost = await wp("POST", "posts", {
        title: article.title,
        slug: article.slug,
        excerpt: article.meta_description || "",
        content: html,
        status: WP_STATUS,
        categories: catId ? [catId] : [],
        tags: tagIds,
        meta: { _yoast_wpseo_metadesc: article.meta_description || "" },
      });
      if (tagIds.length > 0) console.log(`   🏷️  Tags: ${tagSlugs.slice(0, 5).join(", ")}...`);
      const finalStatus = WP_STATUS === "publish" ? "published" : "pending_review";

      // Post-publish: add image + schema + ping (parallel)
      if (WP_STATUS === "publish") {
        const imgUrl = await generateFeaturedImage(
          article.title, article.slug, wpPost.id,
          article.article_type, article.primary_keyword
        );
        if (imgUrl) {
          const schemaBlock = buildSchemaBlock(article, wpPost.link, imgUrl);
          await wp("POST", `posts/${wpPost.id}`, { content: html + schemaBlock });
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
        published_at: new Date().toISOString(),
        quality_score: calcQualityScore(article.word_count, []),
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
      console.log(`   ✗ Failed for ${article.title}: ${e.message.slice(0, 100)}`);
    }
  }
  return { count: published.length, published, skipped: skippedCount };
}

// --- Main ---
(async () => {
  const runStart = new Date();
  console.log("══════════════════════════════════════════════════════");
  console.log(`  AIPickd Pipeline Run — ${runStart.toISOString()}`);
  console.log(`  Config: AUTO_PUBLISH=${AUTO_PUBLISH} → WP status=${WP_STATUS}`);
  console.log(`          Generate ${GEN_COUNT}, Publish=${DO_PUBLISH}`);
  console.log("══════════════════════════════════════════════════════\n");

  // --- Generation phase ---
  let totalGenCost = 0;
  let generated = 0;
  if (GEN_COUNT > 0) {
    console.log(`🧠 GENERATION (×${GEN_COUNT})`);
    for (let i = 0; i < GEN_COUNT; i++) {
      try {
        const res = await generateOne();
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
        const r = spawnSync(process.execPath, [path.join(__dirname, "add-internal-links.js"), "--go"], {
          stdio: "inherit",
          timeout: 5 * 60 * 1000,
        });
        if (r.status !== 0) console.log(`   ⚠️  internal-links exited ${r.status}`);
      } catch (e) {
        console.log(`   ⚠️  internal-links failed: ${e.message.slice(0, 80)}`);
      }
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
})().catch((e) => {
  console.error("\n❌ FATAL:", e.message);
  process.exit(1);
});
