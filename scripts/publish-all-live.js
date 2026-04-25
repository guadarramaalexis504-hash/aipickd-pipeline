#!/usr/bin/env node
/**
 * Flip all WP draft posts to PUBLISHED (live).
 * Run this when you're ready to go live with the content.
 *
 * Usage:
 *   node scripts/publish-all-live.js              # preview (dry run)
 *   node scripts/publish-all-live.js --go         # actually publish
 *   node scripts/publish-all-live.js --go --drip  # schedule them to publish every 6h (drip mode)
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const { WP_USERNAME, WP_ADMIN_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env;
const auth = Buffer.from(`${WP_USERNAME}:${WP_ADMIN_PASSWORD}`).toString("base64");
const args = process.argv.slice(2);
const DRY = !args.includes("--go");
const DRIP = args.includes("--drip");

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

async function supa(method, endpoint, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supa: ${res.status}`);
  return await res.json();
}

(async () => {
  console.log(`== publish-all-live ${DRY ? "(DRY RUN)" : "(LIVE)"} ${DRIP ? "[DRIP MODE]" : ""} ==\n`);

  const drafts = await wp("GET", "posts?status=draft&per_page=100&_fields=id,title,slug");
  console.log(`Found ${drafts.length} draft posts.\n`);

  if (drafts.length === 0) {
    console.log("Nothing to publish.");
    return;
  }

  // Drip mode: schedule each post 6 hours apart starting now
  const intervalMs = DRIP ? 6 * 60 * 60 * 1000 : 0;
  let scheduled = 0;

  for (const [i, post] of drafts.entries()) {
    const targetDate = DRIP
      ? new Date(Date.now() + i * intervalMs).toISOString()
      : null;

    const action = DRIP
      ? `schedule for ${targetDate?.slice(0, 16)}`
      : "publish NOW";

    console.log(`  ${DRY ? "[dry]" : "✓"} ${action}: #${post.id} ${post.title.rendered.slice(0, 60)}`);

    if (!DRY) {
      const body = DRIP
        ? { status: "future", date: targetDate }
        : { status: "publish" };
      await wp("POST", `posts/${post.id}`, body);
      // Update Supabase too
      await supa("PATCH", `articles?wp_post_id=eq.${post.id}`, {
        status: "published",
        published_at: DRIP ? targetDate : new Date().toISOString(),
      });
      scheduled++;
    }
  }

  if (DRY) {
    console.log(`\n✅ DRY RUN complete. ${drafts.length} posts would be ${DRIP ? "scheduled" : "published"}.`);
    console.log(`   Run with --go to actually ${DRIP ? "schedule" : "publish"}.`);
  } else {
    console.log(`\n✅ ${DRIP ? "Scheduled" : "Published"} ${scheduled} posts.`);
    if (DRIP) {
      console.log(`   Each 6h apart. First: NOW, Last: ${new Date(Date.now() + (drafts.length - 1) * intervalMs).toLocaleString()}`);
    }
  }
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
