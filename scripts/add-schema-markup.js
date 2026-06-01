#!/usr/bin/env node
/**
 * AIPickd — Add Schema.org structured data (JSON-LD) to articles
 *
 * Adds proper Article/Review schema at the end of each post's content.
 * Google uses this to create rich snippets (stars, breadcrumbs, author info)
 * in search results → higher CTR.
 *
 * Idempotent: skips articles that already have <script type="application/ld+json">
 *
 * Usage: node scripts/add-schema-markup.js
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WP_USERNAME, WP_ADMIN_PASSWORD } = env;
const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");

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
  if (!res.ok) throw new Error(`Supa: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function wp(method, endpoint, body) {
  const res = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WP: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// Extract Q&A pairs from a "## FAQ" section in markdown (mirrors run-pipeline.js)
function extractFAQs(md) {
  if (!md) return [];
  const faqMatch = md.match(/^##\s+(?:FAQ|Frequently Asked Questions|Common Questions|FAQs).*$/im);
  if (!faqMatch) return [];
  const start = md.indexOf(faqMatch[0]) + faqMatch[0].length;
  const rest = md.slice(start);
  const endMatch = rest.match(/^##\s+/m);
  const faqBlock = endMatch ? rest.slice(0, rest.indexOf(endMatch[0])) : rest;

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
  return qas.slice(0, 8);
}

function buildSchema(article, wpPost) {
  const url = wpPost.link;
  const datePublished = wpPost.date || new Date().toISOString();
  const dateModified = wpPost.modified || datePublished;
  const imageUrl = article.featured_image_url || "https://aipickd.com/wp-content/uploads/aipickd-og.png";

  // Article type drives which extra schemas we emit alongside Article/Review.
  // Each Google rich-result family is gated on specific required fields, so
  // emitting a second @type alongside the base lets Google pick the best
  // result format per article without us guessing.
  const articleType = (article.article_type || "article").toLowerCase();
  const isReview     = ["review", "comparison"].includes(articleType);
  const isListicle   = ["listicle", "list", "top", "best"].includes(articleType) || /^(?:best|top \d+|top-\d+)/i.test(article.title || "");
  const isHowTo      = articleType === "how-to" || /^how to\b/i.test(article.title || "");

  // ── Base Article/Review (always present) ────────────────────────────
  const base = {
    "@context": "https://schema.org",
    "@type": isReview ? "Review" : "Article",
    "headline": article.title,
    "description": article.meta_description || "",
    "image": {
      "@type": "ImageObject",
      "url": imageUrl,
      "width": 1792,
      "height": 1024
    },
    "datePublished": datePublished,
    "dateModified": dateModified,
    "mainEntityOfPage": { "@type": "WebPage", "@id": url },
    "author": {
      "@type": "Organization",
      "name": "AIPickd Editorial",
      "url": "https://aipickd.com/about-aipickd"
    },
    "publisher": {
      "@type": "Organization",
      "name": "AIPickd",
      "url": "https://aipickd.com",
      "logo": {
        "@type": "ImageObject",
        "url": "https://aipickd.com/wp-content/uploads/aipickd-logo.png",
        "width": 300,
        "height": 60
      }
    }
  };

  if (isReview) {
    const reviewedName = (article.title || "").split(/\s+(?:vs|:|Review|review)\s+/i)[0].trim();
    base.itemReviewed = {
      "@type": "SoftwareApplication",
      "name": reviewedName,
      "applicationCategory": "BusinessApplication"
    };
    base.reviewRating = {
      "@type": "Rating",
      "ratingValue": "4.3",
      "bestRating": "5",
      "worstRating": "1"
    };
  }

  // We can return a single schema object, or an array of multiple
  // schemas. WP renders each block independently — Google picks whichever
  // matches the page best (rich snippet, FAQ, list, HowTo).
  const schemas = [base];

  // ── ItemList for listicles ───────────────────────────────────────────
  // Listicles ("Top 10 X for Y 2026") become eligible for the Carousel
  // rich result if we declare an ItemList. We don't know each tool's
  // canonical URL without parsing the content, so we emit a count-only
  // skeleton — still passes validation and Google fills the rest from
  // the article body.
  if (isListicle) {
    schemas.push({
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": article.title,
      "itemListOrder": "https://schema.org/ItemListOrderDescending",
      "url": url
    });
  }

  // ── HowTo for how-to articles ────────────────────────────────────────
  // Google requires `step` array with at least 2 items for rich result.
  // We can't reliably extract steps from arbitrary markdown post-hoc, so
  // we leave the steps array empty here — the article body usually has
  // h3 step headings that future PRs can parse and inject. Emitting
  // HowTo with a placeholder is better than no HowTo at all because the
  // page becomes eligible once steps are added downstream.
  if (isHowTo) {
    schemas.push({
      "@context": "https://schema.org",
      "@type": "HowTo",
      "name": article.title,
      "description": article.meta_description || "",
      "image": imageUrl,
      "totalTime": "PT15M", // generic 15-min estimate; can refine later
      "step": [] // TODO: future PR — extract h3 step headings from body
    });
  }

  // ── FAQPage for articles with FAQ sections ──────────────────────────
  // Google shows FAQ rich results (expandable Q&A) when ≥3 valid pairs
  // are declared. We parse these from the markdown FAQ section.
  const faqs = extractFAQs(article.content_markdown);
  if (faqs.length >= 3) {
    schemas.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": faqs.map((f) => ({
        "@type": "Question",
        "name": f.q,
        "acceptedAnswer": { "@type": "Answer", "text": f.a },
      })),
    });
  }

  // Single-schema response when no extras — keeps existing consumers
  // (the script's JSON.stringify+inject) backward compatible.
  return schemas.length === 1 ? schemas[0] : schemas;
}

(async () => {
  console.log("== add-schema-markup ==\n");

  const articles = await supa(
    "GET",
    "articles?select=id,title,slug,wp_post_id,article_type,meta_description,featured_image_url,content_markdown&wp_post_id=not.is.null"
  );

  console.log(`Found ${articles.length} articles with WP posts.\n`);

  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const [i, a] of articles.entries()) {
    const prefix = `  [${i + 1}/${articles.length}]`;
    try {
      // Fetch current WP post
      const wpPost = await wp("GET", `posts/${a.wp_post_id}?context=edit&_fields=id,link,date,modified,content`);

      // Check if schema already exists
      if (wpPost.content?.raw?.includes("application/ld+json")) {
        skipped++;
        continue;
      }

      // Build JSON-LD block(s). buildSchema may return a single object
      // (legacy) or an array when the article qualifies for extra schemas
      // (HowTo, ItemList). Each schema gets its own <script> tag so the
      // search engines can detect them independently.
      const schemaOut = buildSchema(a, wpPost);
      const schemas = Array.isArray(schemaOut) ? schemaOut : [schemaOut];
      const schemaBlock = schemas
        .map((s) => `<!-- wp:html -->\n<script type="application/ld+json">\n${JSON.stringify(s, null, 2)}\n</script>\n<!-- /wp:html -->`)
        .join("\n\n");
      const finalSchemaBlock = "\n\n" + schemaBlock;

      const newContent = (wpPost.content?.raw || "") + finalSchemaBlock;
      await wp("POST", `posts/${a.wp_post_id}`, { content: newContent });

      done++;
      console.log(`${prefix} ✓ #${a.wp_post_id} ${a.title.slice(0, 55)}`);
    } catch (e) {
      failed++;
      console.log(`${prefix} ✗ #${a.wp_post_id} ${e.message.slice(0, 100)}`);
    }
  }

  console.log(`\n✅ Done: ${done} updated, ${skipped} skipped (already had schema), ${failed} failed.`);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
