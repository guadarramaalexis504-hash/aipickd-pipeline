#!/usr/bin/env node
/**
 * Publish the 5 manually-written content-bank articles LIVE on WordPress.
 * These were reviewed by the user before uploading — higher quality baseline
 * than GPT-generated pieces. Publishing them live gives the site immediate
 * real content for visitors.
 *
 * The GPT-generated articles stay as drafts for user review (AUTO_PUBLISH=false).
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

// The 5 content-bank articles by slug (these are manually authored, not GPT)
const CONTENT_BANK_SLUGS = [
  "jasper-vs-copy-vs-writesonic",
  "best-ai-tools-small-business-owners-2026",
  "midjourney-vs-dalle-vs-stable-diffusion",
  "cursor-vs-github-copilot-2026",
  "supabase-vs-firebase-2026",
];

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
  if (!res.ok) throw new Error(`Supa: ${res.status} ${text}`);
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

(async () => {
  console.log("== publish-content-bank-live ==\n");

  const slugs = CONTENT_BANK_SLUGS.map((s) => `"${s}"`).join(",");
  const articles = await supa("GET", `articles?slug=in.(${slugs})&select=id,title,slug,wp_post_id`);

  console.log(`Found ${articles.length} content-bank articles in Supabase.\n`);

  for (const a of articles) {
    if (!a.wp_post_id) {
      console.log(`  ⊘ Skip (not in WP): ${a.title}`);
      continue;
    }
    try {
      const now = new Date().toISOString();
      await wp("POST", `posts/${a.wp_post_id}`, {
        status: "publish",
        date: now,
      });
      await supa("PATCH", `articles?id=eq.${a.id}`, {
        status: "published",
        published_at: now,
      });
      console.log(`  ✓ LIVE: ${a.title}`);
      console.log(`         https://aipickd.com/${a.slug}/`);
    } catch (e) {
      console.log(`  ✗ ${a.title}: ${e.message.slice(0, 100)}`);
    }
  }

  console.log(`\n✅ Done. Site now has live content.`);
  console.log(`   Visit: https://aipickd.com/`);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
