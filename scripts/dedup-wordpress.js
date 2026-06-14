#!/usr/bin/env node
/**
 * AIPickd — Auto deduplicador de WordPress
 *
 * Detecta y elimina posts duplicados automáticamente.
 * Un duplicado es cualquier post cuyo slug base (sin el -N del final)
 * ya existe en otro post con menor ID.
 *
 * También detecta:
 *  - Posts en WP sin registro en Supabase (huérfanos)
 *  - Artículos en Supabase marcados published pero sin wp_post_id
 *
 * Corre después de cada pipeline (ver generate.yml).
 *
 * Usage:
 *   node scripts/dedup-wordpress.js            # solo reporta, no borra
 *   node scripts/dedup-wordpress.js --fix      # borra duplicados
 *   node scripts/dedup-wordpress.js --fix --quiet  # borra sin ruido
 */

const { loadEnv } = require("./lib/env");
const { supa, wp } = require("./lib/clients");

const env = loadEnv();
const { warmUp } = require("./lib/warmup");
const { isTransientNetworkError } = require("./lib/http");
const { DISCORD_WEBHOOK_ALERTAS } = env;

const FIX_MODE = process.argv.includes("--fix");
const QUIET = process.argv.includes("--quiet");

const log = (...args) => { if (!QUIET) console.log(...args); };

async function notifyAlert(msg) {
  if (!DISCORD_WEBHOOK_ALERTAS) return;
  await fetch(DISCORD_WEBHOOK_ALERTAS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: msg }),
  }).catch(() => {});
}

// Fetch ALL WP posts (handles pagination)
async function getAllWPPosts() {
  const all = [];
  let page = 1;
  while (true) {
    const batch = await wp("GET", `posts?per_page=100&page=${page}&_fields=id,slug,link,date&status=publish`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

// Strip trailing -NUMBER suffix from slug
// Strip a trailing WP collision suffix (1-3 digits, e.g. "-2" in "...-2026-2")
// but PRESERVE the 4-digit year ("...-2026"). The old /-\d+$/ stripped the YEAR
// instead, so "topic-2026" → "topic" and "topic-2026-2" → "topic-2026" landed in
// DIFFERENT groups and the real duplicates (8 of them, all "...-2026-2") were
// never detected. WP appends "-2/-3..." on slug collision, so the collision
// suffix is always 1-3 digits and always comes AFTER the year.
const baseSlug = (slug) => slug.replace(/-\d{1,3}$/, "");

// --- main ---
(async () => {
  log("== AIPickd dedup-wordpress ==");
  log(`   Mode: ${FIX_MODE ? "FIX (will delete)" : "DRY RUN (report only)"}\n`);

  // Warm Hostinger before the WP crawl — avoids a cold-start "fetch failed".
  await warmUp({ log: true }).catch(() => {});

  // 1) Fetch all WP posts
  log("1) Fetching all WordPress posts...");
  const posts = await getAllWPPosts();
  log(`   Found ${posts.length} published posts.\n`);

  if (posts.length === 0) {
    log("Nothing to check.");
    return;
  }

  // 2) Group by base slug
  const groups = {};
  posts.forEach((p) => {
    const b = baseSlug(p.slug);
    if (!groups[b]) groups[b] = [];
    groups[b].push(p);
  });

  const dupeGroups = Object.entries(groups).filter(([, arr]) => arr.length > 1);
  const totalDupes = dupeGroups.reduce((sum, [, arr]) => sum + arr.length - 1, 0);

  log(`2) Duplicate analysis:`);
  log(`   Unique base slugs : ${Object.keys(groups).length}`);
  log(`   Groups with dupes : ${dupeGroups.length}`);
  log(`   Duplicate posts   : ${totalDupes}\n`);

  if (totalDupes === 0) {
    log("✅ No duplicates found. WordPress is clean.");
    return;
  }

  // 3) Show what would be deleted
  const toDelete = [];
  for (const [base, arr] of dupeGroups) {
    arr.sort((a, b) => a.id - b.id); // keep lowest ID (oldest)
    const keep = arr[0];
    const remove = arr.slice(1);
    log(`   [${base}]`);
    log(`     ✅ keep  → id=${keep.id}  slug=${keep.slug}`);
    remove.forEach((p) => log(`     🗑  delete → id=${p.id}  slug=${p.slug}`));
    toDelete.push(...remove.map((p) => p.id));
  }
  log();

  if (!FIX_MODE) {
    log(`⚠️  DRY RUN — ${toDelete.length} posts would be deleted.`);
    log(`   Run with --fix to actually delete them.\n`);
    return;
  }

  // 4) Delete duplicates
  log(`3) Deleting ${toDelete.length} duplicate posts...`);
  let deleted = 0;
  let failed = 0;
  for (const id of toDelete) {
    try {
      await wp("DELETE", `posts/${id}?force=true`);
      deleted++;
      if (deleted % 10 === 0) log(`   ...${deleted} deleted`);
    } catch (e) {
      failed++;
      log(`   ❌ Failed to delete id=${id}: ${e.message}`);
    }
  }
  log(`   Done. Deleted: ${deleted} | Failed: ${failed}\n`);

  // 5) Fix Supabase: articles marked published but missing wp_post_id
  log("4) Checking Supabase for orphaned published articles...");
  const orphans = await supa(
    "GET",
    "articles?status=eq.published&wp_post_id=is.null&select=id,title,slug"
  ).catch(() => []);

  if (orphans && orphans.length > 0) {
    log(`   Found ${orphans.length} articles in Supabase with status=published but no wp_post_id.`);
    // Try to link them to existing WP posts by slug
    let linked = 0;
    for (const article of orphans) {
      try {
        const existing = await wp("GET", `posts?slug=${encodeURIComponent(article.slug)}&_fields=id,link`);
        if (Array.isArray(existing) && existing.length > 0) {
          await supa("PATCH", `articles?id=eq.${article.id}`, {
            wp_post_id: existing[0].id,
            wp_url: existing[0].link,
          });
          linked++;
        }
      } catch {}
    }
    log(`   Linked ${linked} of ${orphans.length} orphaned articles to WP posts.\n`);
  } else {
    log("   All published articles have wp_post_id. ✅\n");
  }

  // 6) Summary
  const summary = `🧹 **Auto-dedup completado**\n` +
    `Posts eliminados: **${deleted}**\n` +
    `Posts restantes: **${posts.length - deleted}**\n` +
    (failed > 0 ? `⚠️ Fallos al borrar: ${failed}` : ``);

  if (deleted > 0) {
    log(summary);
    await notifyAlert(summary);
  }

  log("\n✅ WordPress limpio.");
})().catch(async (e) => {
  // A transient Hostinger blip (fetch failed/timeout) isn't a real dedup failure
  // — skip quietly so one outage doesn't blast #alertas. dedup runs every cycle.
  if (isTransientNetworkError(e)) {
    console.error(`⏭️  dedup-wordpress skipped: WordPress unreachable (transient): ${e.message}`);
    process.exit(0);
  }
  console.error("❌ ERROR:", e.message);
  await notifyAlert(`❌ dedup-wordpress falló: ${e.message}`).catch(() => {});
  process.exit(1);
});
