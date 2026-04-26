#!/usr/bin/env node
/**
 * AIPickd — Cost monitoring + budget enforcement
 *
 * Tracks OpenAI spending per article in Supabase (column: generation_cost_usd)
 * and enforces a daily/monthly budget cap.
 *
 * Daily budget: $3   (default — set via env DAILY_BUDGET)
 * Monthly cap:  $50  (default — set via env MONTHLY_BUDGET)
 *
 * Exits non-zero if budget would be exceeded — pipeline workflow checks
 * this BEFORE generating to prevent runaway spend.
 *
 * Usage:
 *   node scripts/cost-monitor.js                  # check + report
 *   node scripts/cost-monitor.js --enforce        # exit 1 if over budget
 *   node scripts/cost-monitor.js --json           # machine output
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
    if (m) env[m[1]] = m[2];
  });
}

const DAILY_BUDGET = parseFloat(env.DAILY_BUDGET || process.env.DAILY_BUDGET || "3");
const MONTHLY_BUDGET = parseFloat(env.MONTHLY_BUDGET || process.env.MONTHLY_BUDGET || "50");
const ENFORCE = process.argv.includes("--enforce");
const JSON_OUT = process.argv.includes("--json");

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";

  // Pull articles with cost field
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/articles?select=published_at,generation_cost_usd&generation_cost_usd=not.is.null&order=published_at.desc`,
    { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const articles = await r.json();

  let todayCost = 0, monthCost = 0, allTimeCost = 0, todayCount = 0, monthCount = 0;
  for (const a of articles) {
    const c = parseFloat(a.generation_cost_usd) || 0;
    allTimeCost += c;
    if (!a.published_at) continue;
    const date = a.published_at.slice(0, 10);
    if (date === today) { todayCost += c; todayCount++; }
    if (date >= monthStart) { monthCost += c; monthCount++; }
  }

  const todayPct = (todayCost / DAILY_BUDGET) * 100;
  const monthPct = (monthCost / MONTHLY_BUDGET) * 100;

  if (JSON_OUT) {
    console.log(JSON.stringify({
      date: today,
      today: { cost: +todayCost.toFixed(4), count: todayCount, budget: DAILY_BUDGET, pct: +todayPct.toFixed(1) },
      month: { cost: +monthCost.toFixed(4), count: monthCount, budget: MONTHLY_BUDGET, pct: +monthPct.toFixed(1) },
      all_time: { cost: +allTimeCost.toFixed(4), count: articles.length },
      over_budget: todayCost >= DAILY_BUDGET || monthCost >= MONTHLY_BUDGET,
    }, null, 2));
  } else {
    console.log("\n💰 AIPickd Cost Monitor\n");
    console.log(`  Today (${today}):`);
    console.log(`    Spent:  $${todayCost.toFixed(4)} of $${DAILY_BUDGET}  (${todayPct.toFixed(1)}%)  [${todayCount} articles]`);
    console.log(`    Status: ${todayCost >= DAILY_BUDGET ? "🔴 OVER BUDGET" : todayPct > 80 ? "🟡 WARNING" : "✅ OK"}`);
    console.log(`\n  This month:`);
    console.log(`    Spent:  $${monthCost.toFixed(4)} of $${MONTHLY_BUDGET}  (${monthPct.toFixed(1)}%)  [${monthCount} articles]`);
    console.log(`    Status: ${monthCost >= MONTHLY_BUDGET ? "🔴 OVER BUDGET" : monthPct > 80 ? "🟡 WARNING" : "✅ OK"}`);
    console.log(`\n  All-time: $${allTimeCost.toFixed(4)} across ${articles.length} articles  (avg $${(allTimeCost / Math.max(articles.length, 1)).toFixed(4)})\n`);
  }

  if (ENFORCE) {
    if (todayCost >= DAILY_BUDGET) {
      console.error(`\n❌ DAILY BUDGET EXCEEDED ($${todayCost.toFixed(2)} ≥ $${DAILY_BUDGET}). Pipeline halted.\n`);
      process.exit(1);
    }
    if (monthCost >= MONTHLY_BUDGET) {
      console.error(`\n❌ MONTHLY BUDGET EXCEEDED ($${monthCost.toFixed(2)} ≥ $${MONTHLY_BUDGET}). Pipeline halted.\n`);
      process.exit(1);
    }
  }
})().catch((e) => { console.error("❌", e.message); process.exit(2); });
