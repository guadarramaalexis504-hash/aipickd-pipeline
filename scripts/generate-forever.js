#!/usr/bin/env node
/**
 * AIPickd — Generate articles forever (until killed or queue empty).
 *
 * Runs the multi-pass long generator in a loop with sane delays and stops
 * gracefully if:
 *   - keyword queue exhausted
 *   - too many consecutive failures
 *   - --max-articles N reached
 *   - --max-cost $X reached
 *
 * Usage:
 *   node scripts/generate-forever.js                    # run until queue empty
 *   node scripts/generate-forever.js --max-articles 20  # cap at 20
 *   node scripts/generate-forever.js --max-cost 5       # stop after $5 spent
 *   node scripts/generate-forever.js --delay 60         # 60s between articles
 *
 * Recommended: keep terminal open, runs in foreground, easy to ctrl+C.
 * Or run with `node scripts/generate-forever.js > logs/forever.log 2>&1 &`
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const args = process.argv.slice(2);
const idx = (n) => args.indexOf(n);
const arg = (n, dflt) => (idx(n) >= 0 ? args[idx(n) + 1] : dflt);
const MAX_ARTICLES = parseInt(arg("--max-articles", "999"));
const MAX_COST = parseFloat(arg("--max-cost", "20"));
const DELAY_SEC = parseInt(arg("--delay", "30"));

let articlesGenerated = 0;
let totalCost = 0;
let consecutiveFailures = 0;

async function checkQueue() {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/keywords?status=eq.queued&assigned_article_id=is.null&select=id&limit=1`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const arr = await r.json();
  return Array.isArray(arr) && arr.length > 0;
}

async function getQueueCount() {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/keywords?status=eq.queued&assigned_article_id=is.null&select=id`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "count=exact",
      },
    }
  );
  const range = r.headers.get("content-range") || "";
  return parseInt(range.split("/")[1] || "0");
}

function runOne() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "generate-long-article.js"), "--gen", "1"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let output = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      output += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("close", (code) => resolve({ code, output }));
  });
}

(async () => {
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  AIPickd — Generate-Forever Loop");
  console.log(`  Max articles: ${MAX_ARTICLES}, Max cost: $${MAX_COST}, Delay: ${DELAY_SEC}s`);
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════\n");

  const startQueue = await getQueueCount();
  console.log(`📊 Queue size at start: ${startQueue} keywords\n`);

  while (
    articlesGenerated < MAX_ARTICLES &&
    totalCost < MAX_COST &&
    consecutiveFailures < 5
  ) {
    const has = await checkQueue();
    if (!has) {
      console.log("\n🏁 Queue empty. Stopping.");
      break;
    }

    console.log(`\n──── Article ${articlesGenerated + 1}/${MAX_ARTICLES} (spent $${totalCost.toFixed(4)}) ────`);
    const t0 = Date.now();
    const { code, output } = await runOne();
    const dt = Math.round((Date.now() - t0) / 1000);

    if (code === 0) {
      consecutiveFailures = 0;
      articlesGenerated++;
      // Parse cost from log: "Cost: $0.0555"
      const m = output.match(/Cost: \$(\d+\.\d+)/);
      if (m) totalCost += parseFloat(m[1]);
      console.log(`✅ Article #${articlesGenerated} done in ${dt}s. Total cost: $${totalCost.toFixed(4)}`);
    } else {
      consecutiveFailures++;
      console.log(`❌ Failed (code ${code}). Consecutive failures: ${consecutiveFailures}/5`);
    }

    if (articlesGenerated >= MAX_ARTICLES) break;
    if (totalCost >= MAX_COST) {
      console.log(`\n💰 Budget cap reached: $${totalCost.toFixed(4)} ≥ $${MAX_COST}`);
      break;
    }

    console.log(`⏳ Waiting ${DELAY_SEC}s before next article...`);
    await new Promise((r) => setTimeout(r, DELAY_SEC * 1000));
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`  ✅ DONE`);
  console.log(`     Articles generated: ${articlesGenerated}`);
  console.log(`     Total cost:         $${totalCost.toFixed(4)}`);
  console.log(`     Finished:           ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════");
})().catch((e) => { console.error("❌ FATAL:", e); process.exit(1); });
