#!/usr/bin/env node
/**
 * AIPickd — Multi-pass long-form article generator
 *
 * Strategy: Instead of one "write 2500 words" prompt that GPT truncates to ~1200,
 * we split it into PHASES and run multiple calls:
 *   1. Outline (JSON)
 *   2. Intro + first half of sections (~1200 words)
 *   3. Second half of sections + FAQ + conclusion (~1200 words)
 *   4. Polish final stitched article
 *
 * Result: consistent 2200-2800 word articles with full section coverage.
 *
 * Usage:
 *   node scripts/generate-long-article.js              # 1 article
 *   node scripts/generate-long-article.js --gen 5      # batch of 5
 *   node scripts/generate-long-article.js --no-pub     # skip WP publish step
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  OPENAI_API_KEY,
  WP_USERNAME,
  WP_ADMIN_PASSWORD,
  AUTO_PUBLISH,
} = env;

const WP_STATUS = (AUTO_PUBLISH || "false").toLowerCase() === "true" ? "publish" : "draft";
const args = process.argv.slice(2);
const GEN_COUNT = parseInt(args[args.indexOf("--gen") + 1]) || 1;
const DO_PUBLISH = !args.includes("--no-pub");

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
  if (!res.ok) throw new Error(`Supabase: ${res.status} ${text.slice(0, 300)}`);
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
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`GPT ${model}: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
      return { text: data.choices[0].message.content, usage: data.usage };
    } finally {
      clearTimeout(to);
    }
  };
  for (let i = 0; i < 3; i++) {
    try { return await attempt(); }
    catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

async function wp(method, endpoint, body) {
  const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");
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
        const err = new Error(`WP: ${res.status} ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return text ? JSON.parse(text) : null;
    } finally { clearTimeout(to); }
  };
  for (let i = 0; i < 5; i++) {
    try { return await attempt(); }
    catch (e) {
      if (i === 4) throw e;
      const baseWait = e.status === 429 ? 10000 : 2000;
      await new Promise((r) => setTimeout(r, baseWait * (i + 1)));
    }
  }
}

function mdToHtml(md) {
  md = (md || "").replace(/<!--[\s\S]*?-->/g, "");
  let html = md;
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*([^\*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^\*]+)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="nofollow sponsored" target="_blank">$1</a>');
  html = html.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>\n${m}</ul>\n`);
  html = html.replace(/(\|.+\|\n\|[\s\-\|:]+\|\n(?:\|.+\|\n?)+)/g, (m) => {
    const lines = m.trim().split("\n");
    const header = lines[0].split("|").slice(1, -1).map((c) => c.trim());
    const rows = lines.slice(2).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
    const thead = `<thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
    const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>`;
    return `<table class="wp-block-table">${thead}${tbody}</table>`;
  });
  html = html.split("\n\n").map((b) => {
    const t = b.trim();
    if (!t) return "";
    if (/^<(h[1-6]|ul|ol|blockquote|table|pre|div)/i.test(t)) return t;
    return `<p>${t}</p>`;
  }).join("\n\n");
  return html;
}

const COSTS = {
  "gpt-4o-2024-11-20": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
};
function estimateCost(model, usage) {
  const c = COSTS[model] || { in: 1, out: 3 };
  return (usage.prompt_tokens * c.in + usage.completion_tokens * c.out) / 1e6;
}

async function generateOne() {
  const kws = await supa("GET", "keywords?status=eq.queued&assigned_article_id=is.null&order=priority.desc&limit=1&select=*,niche:niches(slug,name)");
  if (!kws || kws.length === 0) return { skipped: true };
  const kw = kws[0];
  console.log(`   📝 "${kw.keyword}" (${kw.niche?.name})`);
  await supa("PATCH", `keywords?id=eq.${kw.id}`, { status: "in_progress" });
  let cost = 0;

  try {
    // Phase 1: Outline
    const outlineRes = await gpt(
      "gpt-4o-2024-11-20",
      "You are an SEO strategist for a top-tier AI tools review publication. The current year is 2026. Output JSON only.",
      `Generate an SEO article outline. Current date: April 2026.

Keyword: ${kw.keyword}
Article type: ${kw.article_type}
Intent: ${kw.intent}
Target word count: 2500
Audience: Small business owners, marketers, creators evaluating AI tools.

CRITICAL: All references must be 2026. Never use 2023, 2024, or 2025 as "current".

TITLE ENGINEERING (CRITICAL for CTR):
- 50-60 chars, include keyword naturally, end with "2026" or "(2026)" or "[2026]"
- Use ONE high-CTR formula:
  * Comparison: "X vs Y: Honest Comparison [2026]" or "X vs Y — Which Wins in 2026?"
  * Review: "X Review: Worth It in 2026? [Tested]" or "X Review — Pros, Cons & Pricing (2026)"
  * Listicle: "7 Best X for Y in 2026 [Free Options]" or "Top 10 X That Actually Work (2026)"
  * How-to: "How to X in 2026 [Step-by-Step]"
- MUST use at least ONE hook: brackets [Free]/[Tested]/[Honest], numbers, power words (Best, Proven, Honest, Worth It), or curiosity (Which Wins?, Worth It?)
- NEVER flat titles like "Best AI Tools 2026" — use "7 Best AI Tools That Actually Work [2026]"

Return JSON with: title (50-60 chars, high-CTR as above), slug (kebab-case with 2026), meta_description (150-160 chars, benefit + curiosity hook), primary_keyword, lsi_keywords (array 5-7), target_word_count, sections (array of 6-8 objects each with: heading, level, bullets array 3-5, word_target number ~300), faqs (array of 5 question strings), internal_link_ideas (array).`,
      2500,
      true
    );
    cost += estimateCost("gpt-4o-2024-11-20", outlineRes.usage);
    const outline = JSON.parse(outlineRes.text);

    // Split sections for two-pass generation
    const sections = outline.sections || [];
    const half = Math.ceil(sections.length / 2);
    const firstHalf = sections.slice(0, half);
    const secondHalf = sections.slice(half);

    // Phase 2: Write intro + first half of sections
    const firstPassRes = await gpt(
      "gpt-4o-2024-11-20",
      "You are a world-class technical writer for AI tools reviews. Style: clear, punchy, authoritative. Think Wirecutter meets a smart tech friend. Current date: April 2026.",
      `Write the FIRST HALF of this article. Include: H1 title, Quick verdict blockquote, intro (150 words), then cover these sections fully:

Title: ${outline.title}
Slug: ${outline.slug}
Sections to cover in this pass (each should be ~350 words with real detail):
${JSON.stringify(firstHalf, null, 2)}

Rules:
1. Date context: "As of April 2026...". Never reference 2023/2024/2025 as "current".
2. Show pros AND cons of every tool.
3. Use markdown comparison tables where applicable.
4. At first mention of a product, wrap it: [AFFILIATE:brand_lowercase]Product Name[/AFFILIATE]
5. Quick verdict blockquote at the top.
6. No AI-tells: avoid "game-changer", "seamless", "cutting-edge", "revolutionary", "in today's world", "let's dive in", "it's important to note".
7. 2nd person, active voice, contractions OK.
8. Write at least 1200 words in this pass.

Output: markdown starting with # H1. Do NOT include the second half sections or FAQ yet — I'll request those next.`,
      8000
    );
    cost += estimateCost("gpt-4o-2024-11-20", firstPassRes.usage);

    // Phase 3: Second half + FAQ + conclusion
    const secondPassRes = await gpt(
      "gpt-4o-2024-11-20",
      "You are the same technical writer continuing an article. Match the tone and style exactly. Current date: April 2026.",
      `Continue the article. The reader just finished this section:

---
[end of first pass content ~200 trailing words]
${firstPassRes.text.slice(-800)}
---

Now write the rest:

Remaining sections:
${JSON.stringify(secondHalf, null, 2)}

FAQs to answer (full paragraph each, not one-liners):
${JSON.stringify(outline.faqs, null, 2)}

Finally, a brief "Bottom line" conclusion section (100-150 words).

Rules:
1. Continue directly from where the first pass ended — no "as we discussed" lead-ins; just keep writing.
2. Each remaining section: ~350 words with real detail.
3. FAQ section: ## Frequently Asked Questions heading, then ### for each question and 2-3 paragraph answers.
4. Same AI-tell-free style and 2026 context.
5. Use [AFFILIATE:brand_lowercase]Name[/AFFILIATE] for first mentions of new tools.
6. Write at least 1200 words in this pass.

Output: pure markdown for the remaining sections + FAQ + conclusion. No H1 (we already have one).`,
      8000
    );
    cost += estimateCost("gpt-4o-2024-11-20", secondPassRes.usage);

    // Stitch both halves
    const fullDraft = firstPassRes.text.trim() + "\n\n" + secondPassRes.text.trim();

    // Phase 4: Light polish with mini (remove AI-tells, tighten)
    const polishRes = await gpt(
      "gpt-4o-mini",
      "You are a strict editor for a top-tier tech review publication. Improve the draft without rewriting it. Remove AI-tells ('revolutionary', 'game-changer', 'seamless', 'in today's world', 'it's important to note'). Tighten prose. Keep all [AFFILIATE:...] tags intact. Keep markdown structure (headings, tables, lists). Current date is April 2026 — fix any 2023/2024/2025 references to 2026. Output: the full revised markdown only.",
      fullDraft,
      14000
    );
    cost += estimateCost("gpt-4o-mini", polishRes.usage);

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

    // Insert
    const inserted = await supa("POST", "articles", {
      keyword_id: kw.id,
      niche_id: kw.niche_id,
      title: outline.title,
      slug: outline.slug,
      meta_description: outline.meta_description,
      content_markdown: linked,
      article_type: kw.article_type,
      status: "draft",
      generated_by: "gpt-multipass",
      word_count: linked.split(/\s+/).length,
      generation_cost_usd: Number(cost.toFixed(4)),
      affiliates_mentioned: [...affiliatesUsed],
    });
    const article = Array.isArray(inserted) ? inserted[0] : inserted;
    await supa("PATCH", `keywords?id=eq.${kw.id}`, {
      status: "published",
      assigned_article_id: article.id,
    });

    return { article, title: outline.title, words: article.word_count, cost };
  } catch (e) {
    await supa("PATCH", `keywords?id=eq.${kw.id}`, { status: "queued" });
    throw e;
  }
}

// Extract Q&A pairs from markdown FAQ section (handles ### and **bold** formats)
function extractFAQs(md) {
  if (!md) return [];
  const faqMatch = md.match(/^#{1,3}\s*(?:FAQ|Frequently Asked Questions|Common Questions|FAQs|Q&A)s?:?.*$/im);
  if (!faqMatch) return [];
  const start = md.indexOf(faqMatch[0]) + faqMatch[0].length;
  const rest = md.slice(start);
  const headerLevel = (faqMatch[0].match(/^#+/) || ["##"])[0].length;
  const endRegex = new RegExp(`^#{1,${headerLevel}}\\s+(?!FAQ)`, "m");
  const endMatch = rest.match(endRegex);
  const faqBlock = endMatch ? rest.slice(0, rest.indexOf(endMatch[0])) : rest;

  const qas = [];

  // Format 1: ### Question
  const headingPattern = /^###\s+(.+?)\n([\s\S]*?)(?=^###\s+|$)/gm;
  let m;
  while ((m = headingPattern.exec(faqBlock)) !== null) {
    const q = m[1].trim().replace(/^\*\*|\*\*$/g, "").replace(/^Q:\s*/i, "");
    const a = m[2].trim().replace(/^\*\*A:\*\*\s*/i, "").replace(/^A:\s*/i, "");
    if (q && a && q.length < 200 && a.length > 20) qas.push({ q, a: a.slice(0, 600) });
  }
  if (qas.length > 0) return qas.slice(0, 8);

  // Format 2: **Question?** followed by plain answer
  const boldPattern = /\*\*(.+?\?)\*\*\s*\n+([\s\S]*?)(?=\n\*\*[^*]+\?\*\*|$)/g;
  while ((m = boldPattern.exec(faqBlock)) !== null) {
    const q = m[1].trim();
    const a = m[2].trim();
    if (q && a && q.length < 200 && a.length > 20) qas.push({ q, a: a.slice(0, 600) });
  }
  return qas.slice(0, 8);
}

function buildSchemaBlock(article, wpLink) {
  const isReview = ["review", "comparison"].includes(article.article_type);
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": isReview ? "Review" : "Article",
    "headline": article.title,
    "description": article.meta_description || "",
    "image": article.featured_image_url || "https://aipickd.com/wp-content/uploads/aipickd-og.png",
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

async function pingSearchEngines(url) {
  try {
    await fetch(`https://www.bing.com/indexnow?url=${encodeURIComponent(url)}&key=aipickd-indexnow`).catch(() => {});
  } catch {}
}

async function generateFeaturedImage(title, slug, postId) {
  try {
    const prompt = `Modern editorial hero image for article: "${title}". Clean minimalist illustration style, abstract geometric concepts, vibrant blues and purples with green accents, 16:9, flat design. NO text, NO logos, NO faces, NO brand names.`;
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "dall-e-3", prompt, n: 1, size: "1792x1024", quality: "standard" }),
    });
    const data = await res.json();
    if (!res.ok) return null;
    const imgRes = await fetch(data.data[0].url);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const wpAuthLocal = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");
    const uploadRes = await fetch("https://aipickd.com/wp-json/wp/v2/media", {
      method: "POST",
      headers: {
        Authorization: `Basic ${wpAuthLocal}`,
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${slug}.png"`,
      },
      body: buffer,
    });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) return null;
    await wp("POST", `posts/${postId}`, { featured_media: uploadData.id });
    return uploadData.source_url;
  } catch (e) {
    return null;
  }
}

async function publishAllDrafts() {
  const drafts = await supa("GET", "articles?status=eq.draft&order=created_at.asc&limit=20");
  if (!drafts || drafts.length === 0) return 0;
  let ok = 0;
  for (const a of drafts) {
    try {
      let html = mdToHtml(a.content_markdown);
      // First publish as DRAFT to get permalink, then attach schema, then update
      const wpPost = await wp("POST", "posts", {
        title: a.title,
        slug: a.slug,
        excerpt: a.meta_description || "",
        content: html,
        status: WP_STATUS,
        meta: { _yoast_wpseo_metadesc: a.meta_description || "" },
      });
      // Generate featured image (DALL-E, $0.04 each)
      let imgUrl = null;
      try {
        imgUrl = await generateFeaturedImage(a.title, a.slug, wpPost.id);
      } catch {}
      // Attach schema with the actual URL + image
      try {
        const articleWithImg = { ...a, featured_image_url: imgUrl };
        const schemaBlock = buildSchemaBlock(articleWithImg, wpPost.link);
        await wp("POST", `posts/${wpPost.id}`, { content: html + schemaBlock });
      } catch (e) {
        console.log(`   ⚠️  schema inject failed: ${e.message.slice(0, 60)}`);
      }
      await supa("PATCH", `articles?id=eq.${a.id}`, {
        status: WP_STATUS === "publish" ? "published" : "pending_review",
        wp_post_id: wpPost.id,
        wp_url: wpPost.link,
        published_at: new Date().toISOString(),
      });
      // Ping for indexing
      pingSearchEngines(wpPost.link);
      ok++;
      console.log(`   ✓ WP #${wpPost.id}: ${a.title.slice(0, 60)}`);
    } catch (e) {
      console.log(`   ✗ ${a.title.slice(0, 40)}: ${e.message.slice(0, 80)}`);
    }
  }
  return ok;
}

(async () => {
  const start = Date.now();
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  AIPickd LONG-form Pipeline — ${new Date().toISOString()}`);
  console.log(`  Config: AUTO_PUBLISH=${AUTO_PUBLISH} → WP ${WP_STATUS}`);
  console.log(`          Generate ${GEN_COUNT}, Publish=${DO_PUBLISH}`);
  console.log("═══════════════════════════════════════════════════════\n");

  let totalCost = 0;
  let generated = 0;
  console.log(`🧠 GENERATION (×${GEN_COUNT}, multi-pass 2500 words target)`);
  for (let i = 0; i < GEN_COUNT; i++) {
    try {
      const r = await generateOne();
      if (r.skipped) { console.log(`   [${i + 1}/${GEN_COUNT}] skip (no queued keywords)`); break; }
      generated++;
      totalCost += r.cost;
      console.log(`   [${i + 1}/${GEN_COUNT}] ✅ "${r.title}" (${r.words}w, $${r.cost.toFixed(4)})`);
    } catch (e) {
      console.log(`   [${i + 1}/${GEN_COUNT}] ❌ ${e.message.slice(0, 120)}`);
    }
  }
  console.log();

  let published = 0;
  if (DO_PUBLISH) {
    console.log(`📤 PUBLISHING`);
    published = await publishAllDrafts();
    console.log(`   Published ${published}\n`);
  }

  console.log("═══════════════════════════════════════════════════════");
  console.log(`  ✅ DONE in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`     Generated: ${generated}  Cost: $${totalCost.toFixed(4)}`);
  console.log(`     Published: ${published}`);
  console.log("═══════════════════════════════════════════════════════");
})().catch((e) => { console.error("❌ FATAL:", e.message); process.exit(1); });
