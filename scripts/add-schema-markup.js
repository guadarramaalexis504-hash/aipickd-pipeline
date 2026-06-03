#!/usr/bin/env node
/**
 * AIPickd — Add / upgrade Schema.org structured data (JSON-LD) on articles
 *
 * Injects the shared lib/schema.js JSON-LD (Article/Review, BreadcrumbList,
 * ItemList, HowTo with real steps, FAQPage) into each published post so Google
 * can show rich results (review stars, clean breadcrumb path, dates) → CTR.
 *
 * Modes:
 *   (default)   Skip posts that ALREADY contain JSON-LD; only add to those without.
 *   --upgrade   Strip existing JSON-LD and re-inject fresh schema (use this after
 *               changing lib/schema.js — e.g. to add breadcrumbs to old posts).
 *
 * Flags:
 *   --upgrade        Replace existing schema instead of skipping
 *   --dry-run        Report what would change; write nothing
 *   --limit N        Process at most N articles (default: all)
 *
 * Breadcrumbs use each post's REAL WordPress category. Ratings on single-product
 * reviews are derived from quality_score (not hardcoded).
 *
 * NOTE: requires working WP auth (Application Password / Basic Auth). Local runs
 * with the plain admin password return 401 — run this in GitHub Actions, where
 * the WP_ADMIN_PASSWORD secret authenticates correctly.
 *
 * Usage:
 *   node scripts/add-schema-markup.js --dry-run
 *   node scripts/add-schema-markup.js --upgrade --limit 10
 *   node scripts/add-schema-markup.js --upgrade
 */

"use strict";

const { loadEnv } = require("./lib/env");
const { fetchWithRetry } = require("./lib/http");
const {
  buildSchemas,
  renderSchemaBlock,
  stripSchemaBlocks,
  hasSchema,
} = require("./lib/schema");

let notify = { notifyPipeline: async () => {}, notifyAlert: async () => {} };
try {
  notify = require("./notify");
} catch (_) {
  /* notify is optional */
}

const env = loadEnv();
const { warmUp } = require("./lib/warmup");

// ── CLI ───────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const UPGRADE = argv.includes("--upgrade");
const DRY_RUN = argv.includes("--dry-run");
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Math.max(1, parseInt(argv[limitIdx + 1], 10) || 0) : 0;

// ── Constants ─────────────────────────────────────────────────────
const WP_HOST = "https://aipickd.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const REQUEST_DELAY_MS = 1200; // Hostinger-friendly
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = Buffer.from(`${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`).toString("base64");

function validateEnv() {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WP_USERNAME", "WP_ADMIN_PASSWORD"].filter(
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
  if (!res.ok) throw new Error(`Supa ${method} ${endpoint}: ${res.status} ${text.slice(0, 200)}`);
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
  validateEnv();
  console.log(
    `\n== add-schema-markup ${UPGRADE ? "(UPGRADE)" : "(add-only)"}${DRY_RUN ? " [DRY RUN]" : ""} ==\n`
  );

  // Warm Hostinger before hammering WP — a cold first request would otherwise
  // time out and cascade into the "all N updates failed. Check WP auth." alert
  // (which is really a timeout, not an auth problem).
  if (!DRY_RUN) await warmUp({ log: true }).catch(() => {});

  // Map WP category id → slug for breadcrumbs
  let catIdToSlug = {};
  try {
    const cats = await wp("GET", "categories?per_page=50&_fields=id,slug");
    for (const c of cats || []) catIdToSlug[c.id] = c.slug;
    console.log(`Loaded ${Object.keys(catIdToSlug).length} WP categories.\n`);
  } catch (e) {
    console.warn(`⚠️  Could not load categories (breadcrumbs will skip category level): ${e.message.slice(0, 120)}`);
  }

  // Order by schema_updated_at NULLS FIRST so the gradual cron step cycles
  // through every article (least-recently-stamped first) instead of re-doing
  // the newest N each run. Stamped after each write/skip below.
  let endpoint =
    "articles?select=id,title,slug,wp_post_id,article_type,meta_description,featured_image_url,content_markdown,quality_score,word_count,schema_updated_at&wp_post_id=not.is.null&status=eq.published&order=schema_updated_at.asc.nullsfirst,published_at.desc";
  if (LIMIT) endpoint += `&limit=${LIMIT}`;
  const articles = await supa("GET", endpoint);
  console.log(`Found ${articles.length} published article(s) with WP posts.\n`);

  let added = 0,
    upgraded = 0,
    skipped = 0,
    failed = 0;
  const samples = [];

  for (const [i, a] of articles.entries()) {
    const prefix = `  [${i + 1}/${articles.length}]`;
    try {
      const wpPost = await wp(
        "GET",
        `posts/${a.wp_post_id}?context=edit&_fields=id,link,date,modified,content,categories`
      );
      const raw = wpPost.content?.raw || "";
      const already = hasSchema(raw);

      if (already && !UPGRADE) {
        // Stamp so the NULLS-FIRST cycle moves past it next run (no WP write).
        if (!DRY_RUN) {
          await supa("PATCH", `articles?id=eq.${a.id}`, { schema_updated_at: new Date().toISOString() }).catch(() => {});
        }
        skipped++;
        continue;
      }

      const categorySlug = (wpPost.categories || []).map((id) => catIdToSlug[id]).find(Boolean) || null;
      const schemas = buildSchemas(a, {
        url: wpPost.link,
        imageUrl: a.featured_image_url || undefined,
        datePublished: wpPost.date || new Date().toISOString(),
        dateModified: wpPost.modified || wpPost.date || new Date().toISOString(),
        wordCount: a.word_count || 0,
        categorySlug,
      });

      const cleanBody = already ? stripSchemaBlocks(raw) : raw.trimEnd();
      const newContent = cleanBody + renderSchemaBlock(schemas);
      const types = schemas.map((s) => s["@type"]).join(", ");

      if (DRY_RUN) {
        console.log(`${prefix} [dry] #${a.wp_post_id} ${a.title.slice(0, 45)} → ${types} (cat: ${categorySlug || "none"})`);
      } else {
        await wp("POST", `posts/${a.wp_post_id}`, { content: newContent });
        await supa("PATCH", `articles?id=eq.${a.id}`, { schema_updated_at: new Date().toISOString() }).catch(() => {});
        console.log(`${prefix} ${already ? "↑" : "+"} #${a.wp_post_id} ${a.title.slice(0, 45)} → ${types}`);
      }

      if (already) upgraded++;
      else added++;
      if (samples.length < 3) samples.push(`${a.title.slice(0, 40)} → ${types}`);

      await sleep(REQUEST_DELAY_MS);
    } catch (e) {
      failed++;
      console.log(`${prefix} ✗ #${a.wp_post_id} ${e.message.slice(0, 120)}`);
    }
  }

  console.log(
    `\n✅ Done: ${added} added, ${upgraded} upgraded, ${skipped} skipped, ${failed} failed${DRY_RUN ? " (dry run — nothing written)" : ""}.`
  );

  // Discord summary (only on real runs that changed something)
  if (!DRY_RUN && (added + upgraded) > 0) {
    const sampleText = samples.map((s) => `• ${s}`).join("\n");
    await notify
      .notifyPipeline(
        `**Schema markup:** ${added} added, ${upgraded} upgraded${failed ? `, ${failed} failed` : ""}.\n${sampleText}`,
        {}
      )
      .catch(() => {});
  }
  if (!DRY_RUN && failed > 0 && added + upgraded === 0) {
    await notify.notifyAlert(`Schema markup: all ${failed} updates failed. Check WP auth.`, "warning").catch(() => {});
  }

  if (failed > 0) process.exitCode = 1;
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
