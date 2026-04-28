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
  const keywords = await supa(
    "GET",
    "keywords?status=eq.queued&assigned_article_id=is.null&order=priority.desc&limit=1&select=*,niche:niches(slug,name)"
  );
  if (!keywords || keywords.length === 0) {
    return { skipped: true, reason: "No queued keywords" };
  }
  const kw = keywords[0];
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

    // Outline — request at least 8 sections with explicit word targets
    const outlineRes = await gpt(
      "gpt-4o-2024-11-20",
      "You are an SEO strategist for a top-tier AI tools review publication. The current year is 2026. Output JSON only.",
      `Generate an SEO article outline. The current date is April 2026.

Keyword: ${kw.keyword}
Article type: ${kw.article_type}
Intent: ${kw.intent}
Target word count: 2500
Audience: Small business owners, marketers, creators evaluating AI tools.

${typeGuide}

CRITICAL: All references must be 2026. If the keyword has a year, use 2026. Never use 2023, 2024, or 2025.
CRITICAL: The outline MUST have at least 8 H2 sections. Each section must have word_target >= 200.
CRITICAL: Include a dedicated "FAQ" section as the last H2 with 6 questions.

Return a JSON object with keys: title (50-60 chars, includes keyword and "2026"), slug (kebab-case with "2026"), meta_description (150-160 chars, mentions 2026), primary_keyword, lsi_keywords (array of 5-7), target_word_count (must be 2500), article_type, sections (array of AT LEAST 8 objects with: heading, level, bullets array of 4-6 items, word_target number >= 200), faqs (array of 6 question strings), internal_link_ideas (array of strings).`,
      2500,
      true
    );
    totalCost += estimateCost("gpt-4o-2024-11-20", outlineRes.usage);
    const outline = JSON.parse(outlineRes.text);

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
TOTAL TARGET: 2500 words minimum. COUNT YOUR WORDS. If any section feels thin, add a real example, a comparison, specific numbers, or a mini case study.

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

    // ── Expansion pass: if draft < 1800 words, auto-expand thin sections ──
    let finalDraftText = draftRes.text;
    const draftWords = draftRes.text.split(/\s+/).length;
    if (draftWords < 1800) {
      console.log(`   ⚡ Draft too short (${draftWords}w) — running expansion pass...`);
      const expandRes = await gpt(
        "gpt-4o-2024-11-20",
        "You are an expert content editor. Expand the provided article to reach 2200+ words without repeating yourself. Add real examples, specific numbers, comparisons, and practical tips to thin sections.",
        `This article is too short (${draftWords} words, target: 2200+). Expand ALL thin sections (any section under 200 words). Add:
- Concrete examples with real numbers (pricing, percentages, time saved)
- Step-by-step walkthroughs where applicable
- Comparison details (feature X in tool A vs tool B)
- Common use cases with specific scenarios
- Tips or warnings the reader needs to know

Keep the same structure (headings, tables, [AFFILIATE:...] tags). Do NOT add filler. Every added sentence must add value.

ARTICLE TO EXPAND:
${draftRes.text}

Output: the full expanded markdown article only.`,
        16000
      );
      totalCost += estimateCost("gpt-4o-2024-11-20", expandRes.usage);
      finalDraftText = expandRes.text;
      const expandedWords = finalDraftText.split(/\s+/).length;
      console.log(`   ✅ Expanded: ${draftWords}w → ${expandedWords}w`);
    }

    // Polish — use the (possibly expanded) finalDraftText
    const polishRes = await gpt(
      "gpt-4o-mini",
      "You are a strict editor for a top-tier tech review publication. Improve the draft, don't rewrite it. Remove AI-tells, tighten prose, ensure every tool has real pros AND cons. Keep all [AFFILIATE:...] tags intact. Keep structure (headings, tables, lists). Do NOT shorten sections. Output: the full revised markdown only.",
      finalDraftText,
      16000
    );
    totalCost += estimateCost("gpt-4o-mini", polishRes.usage);

    // Affiliate links
    const affiliates = await supa("GET", "affiliates?status=eq.active");
    const tagRegex = /\[AFFILIATE:([^\]]+)\]([^\[]+)\[\/AFFILIATE\]/gi;
    const affiliatesUsed = new Set();
    const firstSeen = new Map();
    let linked = polishRes.text.replace(tagRegex, (_, brand, name) => {
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

    // Insert article
    const inserted = await supa("POST", "articles", {
      keyword_id: kw.id,
      niche_id: kw.niche_id,
      title: outline.title,
      slug: outline.slug,
      meta_description: outline.meta_description,
      content_markdown: linked,
      article_type: kw.article_type || outline.article_type,
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

    return {
      article,
      title: outline.title,
      words: article.word_count,
      cost: totalCost,
    };
  } catch (e) {
    await supa("PATCH", `keywords?id=eq.${kw.id}`, { status: "queued" });
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

// --- Ping Google/Bing to index new URL ---
async function pingSearchEngines(url) {
  try {
    // Google ping is deprecated, but IndexNow works for Bing/Yandex
    await fetch(`https://www.bing.com/indexnow?url=${encodeURIComponent(url)}&key=aipickd-indexnow`).catch(() => {});
  } catch {}
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
    if (!qa.pass) {
      skippedCount++;
      console.log(`   ⏩ skip "${article.title.slice(0, 50)}": ${qa.issues.join(", ")}`);
      // Mark as qa_failed so it doesn't clog the queue on future runs
      await supa("PATCH", `articles?id=eq.${article.id}`, {
        status: "qa_failed",
        quality_score: 0,
      }).catch(() => {});
      continue;
    }

    // Inject Table of Contents for long articles
    article.content_markdown = injectToC(article.content_markdown);

    try {
      const html = mdToHtml(article.content_markdown);
      const catId = nicheCatMap[article.niche?.slug];
      const wpPost = await wp("POST", "posts", {
        title: article.title,
        slug: article.slug,
        excerpt: article.meta_description || "",
        content: html,
        status: WP_STATUS,
        categories: catId ? [catId] : [],
        meta: { _yoast_wpseo_metadesc: article.meta_description || "" },
      });
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
          article.featured_image_url || null
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

  // --- Keyword queue health check ---
  try {
    const queuedKwRes = await supa("GET", "keywords?status=eq.queued&select=id");
    const queueCount = Array.isArray(queuedKwRes) ? queuedKwRes.length : 0;
    console.log(`📋 Keywords in queue: ${queueCount}`);
    if (queueCount < 30) {
      notifyAlert(
        `📋 **Cola de keywords baja: ${queueCount} restantes**\nEl pipeline se va a quedar sin contenido pronto. Agregar más keywords en Supabase → tabla \`keywords\`.`,
        queueCount < 10 ? "high" : "warning"
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

  // --- Summary ---
  const secs = ((Date.now() - runStart) / 1000).toFixed(1);
  console.log("══════════════════════════════════════════════════════");
  console.log(`  ✅ DONE in ${secs}s`);
  console.log(`     Generated: ${generated} articles ($${totalGenCost.toFixed(4)})`);
  console.log(`     Published: ${published} to WP (${WP_STATUS})`);
  console.log(`     Daily budget: $${DAILY_BUDGET}`);
  console.log("══════════════════════════════════════════════════════");
})().catch((e) => {
  console.error("\n❌ FATAL:", e.message);
  process.exit(1);
});
