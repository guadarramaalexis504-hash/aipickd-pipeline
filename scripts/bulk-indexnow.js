#!/usr/bin/env node
/**
 * AIPickd — Bulk IndexNow ping for all published articles.
 * Tells Bing/Yandex about all our URLs in one batch.
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
// Start with process.env so GitHub Actions secrets work without a .env file
const env = { ...process.env };
try {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2]; // local .env overrides when present
  });
} catch {}

(async () => {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/articles?status=eq.published&select=wp_url,slug&wp_url=not.is.null`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const articles = await r.json();
  const urlList = articles
    .map((a) => a.wp_url || `https://aipickd.com/${a.slug}/`)
    .filter((u) => u && u.startsWith("https://aipickd.com"));

  console.log(`Pinging ${urlList.length} URLs to IndexNow...`);

  // IndexNow batch endpoint accepts up to 10,000 URLs
  const payload = {
    host: "aipickd.com",
    key: "aipickd-indexnow",
    keyLocation: "https://aipickd.com/aipickd-indexnow.txt",
    urlList,
  };

  // Bing IndexNow (handles Yandex via Bing too)
  try {
    const res = await fetch("https://www.bing.com/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    console.log(`  Bing IndexNow: ${res.status} ${res.statusText}`);
  } catch (e) {
    console.log(`  Bing failed: ${e.message}`);
  }

  // Yandex IndexNow as backup
  try {
    const res = await fetch("https://yandex.com/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    console.log(`  Yandex IndexNow: ${res.status} ${res.statusText}`);
  } catch (e) {
    console.log(`  Yandex failed: ${e.message}`);
  }

  // Also one-by-one Bing pings (some search engines prefer GET)
  console.log("\nIndividual GET pings (fallback):");
  let ok = 0;
  for (const url of urlList.slice(0, 20)) {
    try {
      const res = await fetch(
        `https://www.bing.com/indexnow?url=${encodeURIComponent(url)}&key=aipickd-indexnow`
      );
      if (res.ok) ok++;
    } catch {}
  }
  console.log(`  ${ok}/20 fallback pings OK`);

  console.log(`\n✅ Submitted ${urlList.length} URLs.`);
  console.log(`Note: Google deprecated IndexNow ping. For Google indexing, use Search Console.`);
})().catch((e) => { console.error("❌", e); process.exit(1); });
