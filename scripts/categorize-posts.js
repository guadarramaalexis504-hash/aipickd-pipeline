#!/usr/bin/env node
/**
 * AIPickd — Categorize uncategorized WordPress posts
 *
 * ~56% of posts were left in "Uncategorized" (the categorize step was skipped
 * whenever image generation failed at publish time). Uncategorized posts get a
 * weak "Home > Title" breadcrumb and no topical clustering / sitelinks.
 *
 * This assigns the CORRECT category deterministically from each article's
 * niche_id in Supabase (the same mapping new articles use) — no guessing.
 *
 * Flags:
 *   --dry-run    Report what would change; write nothing
 *   --limit N    Process at most N posts
 *   --force      Re-assign even posts that already have a (non-Uncategorized) category
 *
 * NOTE: requires working WP auth — run in GitHub Actions (local basic-auth 401s).
 *
 * Usage:
 *   node scripts/categorize-posts.js --dry-run
 *   node scripts/categorize-posts.js
 */

"use strict";

const { loadEnv } = require("./lib/env");
const { fetchWithRetry } = require("./lib/http");
const { NICHE_TO_CATEGORY_SLUG } = require("./lib/schema");
const { warmUp } = require("./lib/warmup");

let notify = { notifyPipeline: async () => {}, notifyAlert: async () => {} };
try {
  notify = require("./notify");
} catch (_) {}

const env = loadEnv();

const argv = process.argv.slice(2);
const DRY_RUN = !(argv.includes("--go") || argv.includes("--fix") || argv.includes("--apply") || argv.includes("--confirm"));
const FORCE = argv.includes("--force");
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Math.max(1, parseInt(argv[limitIdx + 1], 10) || 0) : 0;

const WP_HOST = "https://aipickd.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQUEST_DELAY_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = Buffer.from(`${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`).toString("base64");

async function supa(method, endpoint) {
  const res = await fetchWithRetry(
    `${env.SUPABASE_URL}/rest/v1/${endpoint}`,
    {
      method,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
    },
    { timeout: 30000, retries: 3 }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Supa ${endpoint}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function wp(method, endpoint, body) {
  const res = await fetchWithRetry(
    `${WP_HOST}/wp-json/wp/v2/${endpoint}`,
    {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        "User-Agent": UA,
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    { timeout: 60000, retries: 3 }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`WP ${method} ${endpoint}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  console.log(`\n== categorize-posts ${DRY_RUN ? "[DRY RUN]" : ""}${FORCE ? " (force)" : ""} ==\n`);

  // Warm Hostinger before the category writes — this script had NO warm-up and
  // its writes were cold-starting/timing out in CI, which is why ~65 posts sat
  // in Uncategorized for days despite the gradual cron supposedly fixing them.
  if (!DRY_RUN) await warmUp({ log: true }).catch(() => {});

  // 1. WP categories: slug → id, and find the Uncategorized id
  const cats = await wp("GET", "categories?per_page=50&_fields=id,slug,name");
  const slugToId = {};
  let uncategorizedId = null;
  for (const c of cats || []) {
    slugToId[c.slug] = c.id;
    if (c.slug === "uncategorized") uncategorizedId = c.id;
  }
  console.log(`WP categories: ${Object.keys(slugToId).join(", ")}`);
  console.log(`Uncategorized id: ${uncategorizedId}\n`);

  // 2. Articles with their niche slug (embedded resource)
  let endpoint =
    "articles?select=id,title,wp_post_id,niches(slug)&wp_post_id=not.is.null&status=eq.published&order=published_at.desc";
  if (LIMIT) endpoint += `&limit=${LIMIT}`;
  const articles = await supa("GET", endpoint);
  console.log(`Found ${articles.length} published article(s).\n`);

  let assigned = 0,
    skipped = 0,
    failed = 0;
  const byCategory = {};

  for (const [i, a] of articles.entries()) {
    const prefix = `  [${i + 1}/${articles.length}]`;
    const nicheSlug = a.niches?.slug;
    const catSlug = NICHE_TO_CATEGORY_SLUG[nicheSlug];
    const targetCatId = catSlug ? slugToId[catSlug] : null;

    if (!targetCatId) {
      console.log(`${prefix} ? #${a.wp_post_id} no category mapping for niche "${nicheSlug}" — skip`);
      skipped++;
      continue;
    }

    try {
      const post = await wp("GET", `posts/${a.wp_post_id}?_fields=id,categories`);
      const current = post.categories || [];

      const alreadyCorrect = current.includes(targetCatId);
      const onlyUncategorized =
        current.length === 0 || (current.length === 1 && current[0] === uncategorizedId);

      // Skip if already in the right category and we're not forcing
      if (alreadyCorrect && !FORCE) {
        skipped++;
        continue;
      }
      // Without --force, only fix posts that are uncategorized/empty (don't
      // override deliberate manual categorization).
      if (!onlyUncategorized && !alreadyCorrect && !FORCE) {
        skipped++;
        continue;
      }

      byCategory[catSlug] = (byCategory[catSlug] || 0) + 1;

      if (DRY_RUN) {
        console.log(`${prefix} [dry] #${a.wp_post_id} → ${catSlug} (${a.title.slice(0, 45)})`);
      } else {
        await wp("POST", `posts/${a.wp_post_id}`, { categories: [targetCatId] });
        console.log(`${prefix} ✓ #${a.wp_post_id} → ${catSlug} (${a.title.slice(0, 45)})`);
        await sleep(REQUEST_DELAY_MS);
      }
      assigned++;
    } catch (e) {
      failed++;
      console.log(`${prefix} ✗ #${a.wp_post_id} ${e.message.slice(0, 100)}`);
    }
  }

  const summary = Object.entries(byCategory)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  console.log(
    `\n✅ Done: ${assigned} ${DRY_RUN ? "would be " : ""}assigned, ${skipped} skipped, ${failed} failed.`
  );
  if (summary) console.log(`   By category: ${summary}`);

  if (!DRY_RUN && assigned > 0) {
    await notify
      .notifyPipeline(`**Categorized ${assigned} posts** → ${summary}${failed ? ` (${failed} failed)` : ""}.`, {})
      .catch(() => {});
  }
  if (failed > 0) process.exitCode = 1;
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
