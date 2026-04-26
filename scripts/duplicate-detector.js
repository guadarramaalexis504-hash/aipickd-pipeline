#!/usr/bin/env node
/**
 * AIPickd — Duplicate content detector
 *
 * Finds:
 *   1. Exact duplicate titles
 *   2. Near-duplicate titles (fuzzy match >85% similarity)
 *   3. Near-duplicate slugs
 *   4. Articles covering the same brand/topic combo
 *
 * Important for SEO — Google penalizes thin/duplicate content under
 * the "Helpful Content" update.
 *
 * Usage: node scripts/duplicate-detector.js
 *        node scripts/duplicate-detector.js --json
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

// Levenshtein distance for similarity
function dist(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = [];
  for (let i = 0; i <= b.length; i++) m[i] = [i];
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) m[i][j] = m[i - 1][j - 1];
      else m[i][j] = Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
    }
  }
  return m[b.length][a.length];
}
const sim = (a, b) => 1 - dist(a, b) / Math.max(a.length, b.length);

const JSON_OUT = process.argv.includes("--json");

(async () => {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/articles?status=eq.published&select=id,title,slug,wp_post_id,word_count`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const articles = await r.json();
  const dupes = [];

  // Exact title duplicates
  const titleMap = {};
  articles.forEach((a) => {
    const norm = a.title.toLowerCase().trim();
    titleMap[norm] = titleMap[norm] || [];
    titleMap[norm].push(a);
  });
  Object.values(titleMap).filter((g) => g.length > 1).forEach((group) => {
    dupes.push({ type: "exact-title", articles: group });
  });

  // Near-duplicate titles
  const titles = articles.map((a) => a.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim());
  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      if (titles[i] === titles[j]) continue; // already caught
      const s = sim(titles[i], titles[j]);
      if (s > 0.85) {
        dupes.push({ type: "near-title", similarity: +s.toFixed(3), articles: [articles[i], articles[j]] });
      }
    }
  }

  // Near-duplicate slugs (e.g. "jasper-vs-copyai" and "jasper-vs-copy-ai")
  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      const s = sim(articles[i].slug, articles[j].slug);
      if (s > 0.85 && articles[i].slug !== articles[j].slug) {
        dupes.push({ type: "near-slug", similarity: +s.toFixed(3), articles: [articles[i], articles[j]] });
      }
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ total: articles.length, duplicates: dupes }, null, 2));
    return;
  }

  console.log(`\n🔁 Duplicate Detector — ${articles.length} articles scanned\n`);
  if (dupes.length === 0) {
    console.log("✅ No duplicates detected.\n");
    return;
  }
  console.log(`Found ${dupes.length} potential duplicate group(s):\n`);
  dupes.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d.type}${d.similarity ? ` (sim=${d.similarity})` : ""}`);
    d.articles.forEach((a) => {
      console.log(`     WP#${a.wp_post_id} — ${a.title.slice(0, 60)}`);
    });
    console.log();
  });
  console.log(`Recommendation: review and either merge content or 301 redirect the weaker URL.\n`);
})().catch((e) => { console.error("❌", e); process.exit(1); });
