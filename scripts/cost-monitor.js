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
const { loadEnv } = require("./lib/env");
const { fetchWithRetry } = require("./lib/http");

const env = loadEnv();

const DAILY_BUDGET = parseFloat(env.DAILY_BUDGET || "3");
const MONTHLY_BUDGET = parseFloat(env.MONTHLY_BUDGET || "50");
const ENFORCE = process.argv.includes("--enforce");
const JSON_OUT = process.argv.includes("--json");

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("❌ SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
    process.exit(2);
  }

  const r = await fetchWithRetry(
    `${env.SUPABASE_URL}/rest/v1/articles?select=published_at,generation_cost_usd&generation_cost_usd=not.is.null&order=published_at.desc`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
    { timeout: 15000, retries: 3 }
  );
  if (!r.ok) {
    console.error(`❌ Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    process.exit(2);
  }
  const articles = await r.json();

  let todayCost = 0;
  let monthCost = 0;
  let allTimeCost = 0;
  let todayCount = 0;
  let monthCount = 0;
  let invalidCostRows = 0;

  for (const a of articles) {
    const raw = a.generation_cost_usd;
    const c = typeof raw === "number" ? raw : parseFloat(raw);
    if (!Number.isFinite(c)) {
      invalidCostRows++;
      continue;
    }
    allTimeCost += c;
    if (!a.published_at) continue;
    const date = a.published_at.slice(0, 10);
    if (date === today) {
      todayCost += c;
      todayCount++;
    }
    if (date >= monthStart) {
      monthCost += c;
      monthCount++;
    }
  }

  if (invalidCostRows > 0) {
    process.stderr.write(
      `⚠️  ${invalidCostRows} article(s) had invalid generation_cost_usd — excluded from totals\n`
    );
  }

  const todayPct = (todayCost / DAILY_BUDGET) * 100;
  const monthPct = (monthCost / MONTHLY_BUDGET) * 100;

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          date: today,
          today: { cost: +todayCost.toFixed(4), count: todayCount, budget: DAILY_BUDGET, pct: +todayPct.toFixed(1) },
          month: { cost: +monthCost.toFixed(4), count: monthCount, budget: MONTHLY_BUDGET, pct: +monthPct.toFixed(1) },
          all_time: { cost: +allTimeCost.toFixed(4), count: articles.length - invalidCostRows },
          invalid_cost_rows: invalidCostRows,
          over_budget: todayCost >= DAILY_BUDGET || monthCost >= MONTHLY_BUDGET,
        },
        null,
        2
      )
    );
  } else {
    console.log("\n💰 AIPickd Cost Monitor\n");
    console.log(`  Today (${today}):`);
    console.log(`    Spent:  $${todayCost.toFixed(4)} of $${DAILY_BUDGET}  (${todayPct.toFixed(1)}%)  [${todayCount} articles]`);
    console.log(`    Status: ${todayCost >= DAILY_BUDGET ? "🔴 OVER BUDGET" : todayPct > 80 ? "🟡 WARNING" : "✅ OK"}`);
    console.log(`\n  This month:`);
    console.log(`    Spent:  $${monthCost.toFixed(4)} of $${MONTHLY_BUDGET}  (${monthPct.toFixed(1)}%)  [${monthCount} articles]`);
    console.log(`    Status: ${monthCost >= MONTHLY_BUDGET ? "🔴 OVER BUDGET" : monthPct > 80 ? "🟡 WARNING" : "✅ OK"}`);
    const validCount = articles.length - invalidCostRows;
    console.log(`\n  All-time: $${allTimeCost.toFixed(4)} across ${validCount} articles  (avg $${(allTimeCost / Math.max(validCount, 1)).toFixed(4)})\n`);
  }

  try {
    const { notifyBudgetAlert } = require("./notify.js");
    if (monthPct >= 70) {
      await notifyBudgetAlert(monthPct, monthCost, MONTHLY_BUDGET, "monthly");
    }
    if (todayPct >= 80) {
      await notifyBudgetAlert(todayPct, todayCost, DAILY_BUDGET, "daily");
    }
  } catch (e) {
    if (process.env.NOTIFY_DEBUG) console.log("[cost-monitor] alert error:", e.message);
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
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(2);
});
