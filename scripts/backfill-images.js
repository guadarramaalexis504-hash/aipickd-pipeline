#!/usr/bin/env node
/**
 * AIPickd — Backfill featured images on articles that have none
 *
 * ~65 published articles never got a featured image because the pipeline called
 * the (now-removed) `dall-e-3` model and the Unsplash fallback key is invalid.
 * Both image strategies failed silently → no image → no SERP thumbnail / OG card.
 *
 * This generates a fresh image with gpt-image-1, uploads it to WordPress, sets it
 * as the featured media, and records the URL in Supabase. Idempotent: only touches
 * articles whose featured_image_url is null.
 *
 * Flags:
 *   --dry-run    List what would be generated; spend nothing
 *   --limit N    Cap how many images to generate this run (default 10; cost control)
 *
 * Cost: ~$0.02 / image (gpt-image-1, quality=low, 1536x1024).
 *
 * NOTE: requires working WP auth — run in GitHub Actions (local basic-auth 401s).
 *
 * Usage:
 *   node scripts/backfill-images.js --dry-run
 *   node scripts/backfill-images.js --limit 20
 */

"use strict";

const { loadEnv } = require("./lib/env");
const { fetchWithRetry } = require("./lib/http");

let notify = { notifyPipeline: async () => {}, notifyAlert: async () => {} };
try {
  notify = require("./notify");
} catch (_) {}

const env = loadEnv();

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Math.max(1, parseInt(argv[limitIdx + 1], 10) || 10) : 10;

const WP_HOST = "https://aipickd.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const auth = Buffer.from(`${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function validateEnv() {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENAI_API_KEY", "WP_USERNAME", "WP_ADMIN_PASSWORD"].filter(
    (k) => !env[k]
  );
  if (missing.length) {
    console.error(`Missing env var(s): ${missing.join(", ")}`);
    process.exit(2);
  }
}

async function supa(method, endpoint, body) {
  const res = await fetchWithRetry(
    `${env.SUPABASE_URL}/rest/v1/${endpoint}`,
    {
      method,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    { timeout: 30000, retries: 3 }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Supa ${endpoint}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function wpJson(method, endpoint, body) {
  const res = await fetchWithRetry(
    `${WP_HOST}/wp-json/wp/v2/${endpoint}`,
    {
      method,
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", "User-Agent": UA },
      body: body ? JSON.stringify(body) : undefined,
    },
    { timeout: 60000, retries: 3 }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`WP ${method} ${endpoint}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// gpt-image-1 → PNG buffer (returns null on failure)
async function generateImage(title, articleType, primaryKeyword) {
  const typeStyles = {
    comparison: "split-panel composition showing two contrasting tech concepts side by side",
    review: "product spotlight editorial — single tool in hero position, feature highlights",
    "how-to": "step-by-step process visualization, clean numbered flow diagram",
    list: "grid mosaic of diverse tech icons representing multiple AI tools",
    listicle: "grid mosaic of diverse tech icons representing multiple AI tools",
    guide: "roadmap or journey visualization, progressive steps leading to a goal",
  };
  const styleHint = typeStyles[articleType] || "editorial tech illustration";
  const kwHint = primaryKeyword ? ` (topic: ${primaryKeyword})` : "";
  const prompt = `${styleHint}${kwHint}. Modern tech editorial style, abstract geometric shapes, deep navy and electric blue palette with emerald green accents, 16:9 landscape. Clean flat design, high contrast. Absolutely NO text, NO logos, NO UI elements, NO faces, NO brand names.`;

  const res = await fetchWithRetry(
    "https://api.openai.com/v1/images/generations",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1", prompt, n: 1, size: "1536x1024", quality: "low" }),
    },
    { timeout: 100000, retries: 1 }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`gpt-image-1: ${JSON.stringify(data).slice(0, 200)}`);
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("gpt-image-1: no b64_json");
  return Buffer.from(b64, "base64");
}

async function uploadToWP(buffer, slug, postId) {
  const res = await fetchWithRetry(
    `${WP_HOST}/wp-json/wp/v2/media`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${slug}.png"`,
        "User-Agent": UA,
      },
      body: buffer,
    },
    { timeout: 90000, retries: 2 }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`WP media upload: ${res.status} ${JSON.stringify(data).slice(0, 150)}`);
  await wpJson("POST", `posts/${postId}`, { featured_media: data.id });
  return data.source_url;
}

(async () => {
  validateEnv();
  console.log(`\n== backfill-images ${DRY_RUN ? "[DRY RUN]" : ""} — limit ${LIMIT} ==\n`);

  const articles = await supa(
    "GET",
    "articles?select=id,title,slug,wp_post_id,article_type,primary_keyword&wp_post_id=not.is.null&status=eq.published&featured_image_url=is.null&order=published_at.desc" +
      `&limit=${LIMIT}`
  );
  console.log(`Found ${articles.length} article(s) with no featured image.\n`);

  let done = 0,
    failed = 0;

  for (const [i, a] of articles.entries()) {
    const prefix = `  [${i + 1}/${articles.length}]`;
    if (DRY_RUN) {
      console.log(`${prefix} [dry] would generate image for #${a.wp_post_id} ${a.title.slice(0, 50)}`);
      done++;
      continue;
    }
    try {
      console.log(`${prefix} generating #${a.wp_post_id} ${a.title.slice(0, 50)}...`);
      const buffer = await generateImage(a.title, a.article_type, a.primary_keyword);
      const url = await uploadToWP(buffer, a.slug, a.wp_post_id);
      await supa("PATCH", `articles?id=eq.${a.id}`, { featured_image_url: url });
      console.log(`${prefix} ✓ ${url}`);
      done++;
      await sleep(1500); // gentle on Hostinger + OpenAI
    } catch (e) {
      failed++;
      console.log(`${prefix} ✗ ${e.message.slice(0, 120)}`);
    }
  }

  console.log(`\n✅ Done: ${done} ${DRY_RUN ? "would be generated" : "images added"}, ${failed} failed.`);
  if (!DRY_RUN && done > 0) {
    await notify
      .notifyPipeline(`**Featured images:** generated ${done} via gpt-image-1${failed ? ` (${failed} failed)` : ""}.`, {})
      .catch(() => {});
  }
  if (failed > 0) process.exitCode = 1;
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
