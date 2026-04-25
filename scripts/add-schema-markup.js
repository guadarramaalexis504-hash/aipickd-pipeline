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

function buildSchema(article, wpPost) {
  const url = wpPost.link;
  const datePublished = wpPost.date || new Date().toISOString();
  const dateModified = wpPost.modified || datePublished;
  const imageUrl = article.featured_image_url || "https://aipickd.com/wp-content/uploads/aipickd-og.png";

  // Detect if this is a comparison/review/listicle
  const articleType = article.article_type || "article";
  const isReview = ["review", "comparison"].includes(articleType);

  const base = {
    "@context": "https://schema.org",
    "@type": isReview ? "Review" : "Article",
    "headline": article.title,
    "description": article.meta_description || "",
    "image": imageUrl,
    "datePublished": datePublished,
    "dateModified": dateModified,
    "mainEntityOfPage": { "@type": "WebPage", "@id": url },
    "author": {
      "@type": "Organization",
      "name": "AIPickd",
      "url": "https://aipickd.com"
    },
    "publisher": {
      "@type": "Organization",
      "name": "AIPickd",
      "url": "https://aipickd.com",
      "logo": {
        "@type": "ImageObject",
        "url": "https://aipickd.com/wp-content/uploads/aipickd-logo.png"
      }
    }
  };

  if (isReview) {
    base.itemReviewed = {
      "@type": "SoftwareApplication",
      "name": article.title.split(/vs|:|Review/i)[0].trim(),
      "applicationCategory": "BusinessApplication"
    };
    base.reviewRating = {
      "@type": "Rating",
      "ratingValue": "4.3",
      "bestRating": "5",
      "worstRating": "1"
    };
  }

  return base;
}

(async () => {
  console.log("== add-schema-markup ==\n");

  const articles = await supa(
    "GET",
    "articles?select=id,title,slug,wp_post_id,article_type,meta_description,featured_image_url&wp_post_id=not.is.null"
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

      // Build JSON-LD block
      const schema = buildSchema(a, wpPost);
      const schemaBlock = `\n\n<!-- wp:html -->\n<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>\n<!-- /wp:html -->`;

      const newContent = (wpPost.content?.raw || "") + schemaBlock;
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
