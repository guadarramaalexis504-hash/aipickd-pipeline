#!/usr/bin/env node
/**
 * AIPickd — Apply selective noindex via REST to pages we don't want crawled.
 *
 * Pages like /wp-admin, /wp-login.php, etc are WP core and can't be modified
 * via REST. But we CAN noindex our custom pages that shouldn't appear in
 * Google (e.g. test pages, draft URLs that leaked).
 *
 * Usage:
 *   node scripts/wp-block-search-indexers-of-bad-pages.js
 *   node scripts/wp-block-search-indexers-of-bad-pages.js --apply
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const APPLY = process.argv.includes("--apply");
const auth = Buffer.from(`${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`).toString("base64");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

(async () => {
  console.log(`\n🔍 Auditing public pages for SEO/security ${APPLY ? "(LIVE)" : "(DRY)"}\n`);

  // Pull all pages
  const r = await fetch("https://aipickd.com/wp-json/wp/v2/pages?per_page=100&_fields=id,title,slug,link,status", {
    headers: { Authorization: `Basic ${auth}`, "User-Agent": UA },
  });
  if (!r.ok) {
    console.error("Failed to list pages:", r.status);
    process.exit(1);
  }
  const pages = await r.json();
  console.log(`Found ${pages.length} pages on aipickd.com:\n`);
  pages.forEach((p) => {
    const flag = p.slug.match(/test|draft|tmp|wp-config|admin/i) ? " ⚠️" : "";
    console.log(`  [${p.status}] /${p.slug}${flag}  →  ${p.title.rendered}`);
  });

  // Look for suspicious pages
  const suspicious = pages.filter((p) =>
    p.slug.match(/(test|draft|tmp|backup|copy)/i) ||
    p.title.rendered.match(/(test|draft|tmp)/i) && p.status === "publish"
  );
  if (suspicious.length > 0) {
    console.log(`\n⚠️  ${suspicious.length} suspicious pages found:`);
    suspicious.forEach((p) => console.log(`   /${p.slug} — "${p.title.rendered}"`));
    console.log("\n   Consider deleting via WP Admin if not needed.");
  } else {
    console.log("\n✅ No suspicious test/draft pages found");
  }

  console.log();
})().catch((e) => { console.error("❌", e); process.exit(1); });
