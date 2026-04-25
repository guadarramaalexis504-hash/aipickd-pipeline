#!/usr/bin/env node
/**
 * AIPickd — List weak articles (under threshold word count).
 * Quick view to identify regen candidates.
 *
 * Usage:
 *   node scripts/list-weak-articles.js              # under 1500 words
 *   node scripts/list-weak-articles.js --threshold 1800
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const args = process.argv.slice(2);
const tIdx = args.indexOf("--threshold");
const THRESHOLD = tIdx >= 0 ? parseInt(args[tIdx + 1]) : 1500;

(async () => {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/articles?status=eq.published&order=word_count.asc&select=id,title,word_count,wp_post_id,slug`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const arr = await r.json();
  if (!Array.isArray(arr)) {
    console.error("Unexpected response:", arr);
    process.exit(1);
  }
  const weak = arr.filter((a) => a.word_count < THRESHOLD);
  console.log(`\nWeak articles (<${THRESHOLD} words): ${weak.length}/${arr.length}\n`);
  weak.forEach((a) => {
    console.log(
      `  ${String(a.word_count).padStart(4)}w | wp#${String(a.wp_post_id).padStart(3)} | ${a.title.slice(0, 60)}`
    );
  });
  console.log(`\nTo regen one: node scripts/generate-long-article.js --gen 1 --topic "<title>"`);
})();
