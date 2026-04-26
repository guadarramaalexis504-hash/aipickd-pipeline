#!/usr/bin/env node
/**
 * AIPickd — Supabase database backup
 *
 * Exports all critical tables to JSON files in ./backup/
 * Designed to run via GitHub Actions; the artifact is retained 30 days.
 *
 * Tables exported:
 *   - articles (the gold)
 *   - keywords
 *   - niches
 *   - affiliates
 *   - system_config
 *
 * Usage: node scripts/backup-supabase.js
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const TABLES = ["articles", "keywords", "niches", "affiliates", "system_config"];
const OUT_DIR = path.join(__dirname, "..", "backup");
fs.mkdirSync(OUT_DIR, { recursive: true });

async function dump(table) {
  let all = [];
  let offset = 0;
  const PAGE = 1000;
  for (;;) {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/${table}?select=*&limit=${PAGE}&offset=${offset}`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: "count=exact",
        },
      }
    );
    if (!r.ok) {
      console.error(`  ❌ ${table} page ${offset}: ${r.status}`);
      break;
    }
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    all = all.concat(rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

(async () => {
  console.log("\n💾 Backing up Supabase tables...\n");
  const summary = { date: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    process.stdout.write(`  ${t.padEnd(20)} `);
    const rows = await dump(t);
    const file = path.join(OUT_DIR, `${t}.json`);
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
    const sizeKb = Math.round(fs.statSync(file).size / 1024);
    console.log(`${rows.length.toString().padStart(5)} rows  (${sizeKb} KB)`);
    summary.tables[t] = { rows: rows.length, size_kb: sizeKb };
  }
  fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(summary, null, 2));
  console.log(`\n✅ Backup saved to ${OUT_DIR}\n`);
})().catch((e) => { console.error("❌ FATAL:", e); process.exit(1); });
