#!/usr/bin/env node
/**
 * AIPickd — Append a "Related articles" block to published posts.
 *
 * Adds 4 topically-related internal links at the end of each article. Boosts
 * impressions (more pages linked/crawled), topical authority, and dwell time
 * (lower bounce → better rankings). Idempotent: re-running refreshes the block
 * (via HTML markers) instead of appending a duplicate, so it's safe on a cron.
 * Localized: ES articles get "Artículos relacionados".
 *
 * Usage:
 *   node scripts/add-related-articles.js                 # dry run (no writes)
 *   node scripts/add-related-articles.js --go            # apply to all posts
 *   node scripts/add-related-articles.js --go --only ID  # apply to one post
 *   node scripts/add-related-articles.js --n 5           # 5 related links
 */

const { loadEnv } = require("./lib/env");
const {
  pickRelatedArticles,
  buildRelatedBlock,
  injectRelatedBlock,
} = require("./lib/related-articles");

const env = loadEnv();
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WP_USERNAME, WP_ADMIN_PASSWORD } = env;

const args = process.argv.slice(2);
const DRY = !args.includes("--go");
const ONLY_ID = args.indexOf("--only") >= 0 ? args[args.indexOf("--only") + 1] : null;
const N = parseInt(args[args.indexOf("--n") + 1], 10) || 4;
const HAS_WP_AUTH = Boolean(WP_USERNAME && WP_ADMIN_PASSWORD);
const auth = HAS_WP_AUTH ? Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64") : null;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}
if (!DRY && !HAS_WP_AUTH) {
  console.error("❌ Missing WP_USERNAME / WP_ADMIN_PASSWORD (required for --go)");
  process.exit(2);
}

async function supa(method, endpoint, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function wp(method, endpoint, body) {
  const r = await fetch(`https://aipickd.com/wp-json/wp/v2/${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
      "User-Agent": "Mozilla/5.0 AIPickd-related/1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`WP ${method} ${endpoint}: ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

(async () => {
  console.log(`\n═══ AIPickd Related Articles ${DRY ? "(DRY RUN)" : "(LIVE)"} ═══\n`);

  const all = await supa(
    "GET",
    "articles?status=eq.published&select=id,title,slug,language,wp_url,wp_post_id,niche_id,primary_keyword,published_at&order=published_at.desc"
  );
  console.log(`Loaded ${all.length} published articles.`);

  const targets = ONLY_ID ? all.filter((a) => a.id === ONLY_ID) : all;
  if (ONLY_ID && targets.length === 0) {
    console.log(`No published article with id=${ONLY_ID}.`);
    return;
  }

  let updated = 0;
  let skipped = 0;
  for (const article of targets) {
    if (!article.wp_post_id) {
      skipped++;
      continue;
    }
    const related = pickRelatedArticles(article, all, N);
    if (related.length === 0) {
      skipped++;
      continue;
    }
    const block = buildRelatedBlock(related, article.language);

    if (DRY) {
      console.log(`\n• ${article.title.slice(0, 60)} (${article.language || "en"})`);
      related.forEach((r) => console.log(`    → ${r.title.slice(0, 60)}`));
      updated++;
      continue;
    }

    try {
      const post = await wp("GET", `posts/${article.wp_post_id}?context=edit`);
      const html = post.content?.raw || post.content?.rendered || "";
      const { html: next, changed } = injectRelatedBlock(html, block);
      if (!changed) {
        skipped++;
        continue;
      }
      await wp("POST", `posts/${article.wp_post_id}`, { content: next });
      updated++;
      console.log(`  ✓ #${article.wp_post_id} ${article.title.slice(0, 55)} (+${related.length} related)`);
    } catch (e) {
      skipped++;
      console.log(`  ⚠️  #${article.wp_post_id} ${e.message.slice(0, 90)}`);
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  ${DRY ? "DRY RUN — " : ""}updated: ${updated} · skipped: ${skipped}`);
  console.log(`═══════════════════════════════════════════════════════`);
  if (DRY) console.log(`\nRun with --go to apply.`);
})().catch((e) => {
  console.error("❌", e.message || e);
  process.exit(1);
});
