#!/usr/bin/env node
/**
 * Flip an affiliate from pending → active and update its base_url with the real tracking ID.
 *
 * Usage:
 *   node scripts/approve-affiliate.js <brand> <real_url>
 *
 * Examples:
 *   node scripts/approve-affiliate.js Jasper "https://jasper.ai/?fp_ref=aipickd-alexis"
 *   node scripts/approve-affiliate.js "Copy.ai" "https://copy.ai/?via=aipickd"
 *   node scripts/approve-affiliate.js Amazon "https://amazon.com/?tag=aipickd-20"
 *
 * After running, existing articles that mentioned the brand WON'T have links
 * (they were generated when affiliates were 'pending'). Future articles will.
 *
 * To backfill existing articles with new links, run:
 *   node scripts/regenerate-affiliate-links.js
 *   (not yet written — ask Claude to build it when you need it)
 */

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env;

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
  if (!res.ok) throw new Error(`Supabase: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  const [brand, url] = process.argv.slice(2);

  if (!brand || !url) {
    console.log("Usage: node scripts/approve-affiliate.js <brand> <real_url>");
    console.log("");
    console.log("Current affiliates:");
    const all = await supa("GET", "affiliates?select=brand,status,base_url&order=brand.asc");
    for (const a of all) {
      const marker = a.status === "active" ? "✅" : "⏳";
      console.log(`  ${marker} ${a.brand.padEnd(20)} ${a.status.padEnd(10)} ${a.base_url}`);
    }
    return;
  }

  // Find by brand (case-insensitive)
  const matches = await supa("GET", `affiliates?brand=ilike.${encodeURIComponent(brand)}`);
  if (!matches || matches.length === 0) {
    console.error(`❌ No affiliate found with brand "${brand}".`);
    console.log("Run without args to see all brands.");
    process.exit(1);
  }
  const aff = matches[0];

  console.log(`Found: ${aff.brand} (status=${aff.status})`);
  console.log(`  Old URL: ${aff.base_url}`);
  console.log(`  New URL: ${url}`);

  const updated = await supa("PATCH", `affiliates?id=eq.${aff.id}`, {
    base_url: url,
    status: "active",
  });

  console.log(`\n✅ Approved! ${aff.brand} is now ACTIVE.`);
  console.log(`   Future generated articles will link to: ${url}`);
  console.log(`   Don't forget to add ?utm_source=aipickd&utm_medium=affiliate flags — the pipeline appends them automatically.`);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
