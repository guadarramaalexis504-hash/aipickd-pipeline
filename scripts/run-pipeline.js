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
const { notify } = require("./notify.js");

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
  const attempt = async () => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`WP ${method} ${endpoint}: ${res.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(to);
    }
  };
  for (let i = 0; i < 3; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
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
    // Outline
    const outlineRes = await gpt(
      "gpt-4o-2024-11-20",
      "You are an SEO strategist for a top-tier AI tools review publication. The current year is 2026. Output JSON only.",
      `Generate an SEO article outline. The current date is April 2026.

Keyword: ${kw.keyword}
Article type: ${kw.article_type}
Intent: ${kw.intent}
Target word count: 2500
Audience: Small business owners, marketers, creators evaluating AI tools.

CRITICAL: All references must be 2026. If the keyword has a year, use 2026. Never use 2023, 2024, or 2025.

Return a JSON object with keys: title (50-60 chars, includes keyword and "2026"), slug (kebab-case with "2026"), meta_description (150-160 chars, mentions 2026), primary_keyword, lsi_keywords (array of 5-7), target_word_count, sections (array of objects with heading, level, bullets array, word_target number), faqs (array of 5 question strings), internal_link_ideas (array of strings).`,
      2500,
      true
    );
    totalCost += estimateCost("gpt-4o-2024-11-20", outlineRes.usage);
    const outline = JSON.parse(outlineRes.text);

    // Draft
    const draftRes = await gpt(
      "gpt-4o-2024-11-20",
      "You are a world-class technical writer for AI tools reviews. Style: clear, punchy, authoritative. Think Wirecutter meets a smart tech friend. The current date is April 2026 — all references must reflect this.",
      `Write a complete publication-ready article based on this outline:

${JSON.stringify(outline)}

Rules:
1. Current date: April 2026. Use "As of April 2026..." framing for pricing and features. NEVER reference 2023, 2024, or 2025 as "current" — those are the past.
2. Show pros AND cons of every tool.
3. Use markdown comparison tables when applicable.
4. At first mention of a product, wrap it: [AFFILIATE:brand_name_lowercase]Product Name[/AFFILIATE]
5. Add a 'Quick verdict' blockquote at the very top (before the intro) with 2-3 sentences.
6. AVOID AI-tells: "in today's fast-paced world", "it's important to note", "let's dive in", "revolutionary", "game-changer", "seamless", "cutting-edge", "unlock", "harness the power".
7. Use 2nd person ("you"), active voice, contractions OK.
8. Write AT LEAST 2000 words. More detail = better. Include examples, specific numbers, and trade-offs.
9. Cover EVERY section from the outline fully, with complete paragraphs under each heading.
10. End with FAQ section answering the outline's questions.

Output: pure markdown. Start with # H1. No commentary before or after.`,
      14000
    );
    totalCost += estimateCost("gpt-4o-2024-11-20", draftRes.usage);

    // Polish
    const polishRes = await gpt(
      "gpt-4o-mini",
      "You are a strict editor for a top-tier tech review publication. Improve the draft, don't rewrite it. Remove AI-tells, tighten prose, ensure every tool has real pros AND cons. Keep all [AFFILIATE:...] tags intact. Keep structure (headings, tables, lists). Output: the full revised markdown only.",
      draftRes.text,
      14000
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
      article_type: kw.article_type,
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
  if (!article.word_count || article.word_count < 1000) issues.push(`too short: ${article.word_count}w`);
  if (!article.title || article.title.length < 20) issues.push("title too short");
  if (/^[^a-zA-Z0-9]/.test(article.title || "")) issues.push("weird title char");
  if (/\b(?:as an AI|I cannot|as a language model)\b/i.test(article.content_markdown || "")) {
    issues.push("AI-tell in body");
  }
  return { pass: issues.length === 0, issues };
}

// --- DALL-E image generation (inline with publish) ---
async function generateFeaturedImage(title, slug, postId) {
  try {
    const prompt = `Modern editorial hero image for article: "${title}". Clean minimalist illustration style, abstract geometric concepts, vibrant blues and purples with green accents, 16:9, flat design. NO text, NO logos, NO faces, NO brand names.`;
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "dall-e-3", prompt, n: 1, size: "1792x1024", quality: "standard" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`DALL-E: ${JSON.stringify(data).slice(0, 200)}`);
    const imgRes = await fetch(data.data[0].url);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");
    const uploadRes = await fetch("https://aipickd.com/wp-json/wp/v2/media", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${slug}.png"`,
      },
      body: buffer,
    });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(`WP upload: ${uploadRes.status}`);
    await wp("POST", `posts/${postId}`, { featured_media: uploadData.id });
    return uploadData.source_url;
  } catch (e) {
    return null; // non-fatal — article publishes even if image fails
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
    // Quality gate + cleanup
    article.content_markdown = aggressiveClean(article.content_markdown);
    const qa = qualityGate(article);
    if (!qa.pass) {
      skippedCount++;
      console.log(`   ⏩ skip "${article.title.slice(0, 50)}": ${qa.issues.join(", ")}`);
      continue;
    }

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
        const imgUrl = await generateFeaturedImage(article.title, article.slug, wpPost.id);
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
      });
      published.push({ title: article.title, wp_id: wpPost.id, url: wpPost.link });
      console.log(`   ✓ ${WP_STATUS === "publish" ? "LIVE" : "Draft"} WP #${wpPost.id}: ${article.title.slice(0, 55)}`);
      // Fire-and-forget notification
      if (WP_STATUS === "publish") {
        notify(`📝 *New article LIVE on AIPickd*\n\n**${article.title}**\n\n🔗 ${wpPost.link}`).catch(() => {});
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
