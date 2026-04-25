#!/usr/bin/env node
/**
 * AIPickd — Google rankings tracker (Playwright)
 *
 * Searches each of your target keywords in Google and finds where
 * aipickd.com ranks. Stores results in Supabase over time so you can
 * see your ranking trajectory week-over-week.
 *
 * Usage:
 *   node scripts/check-rankings.js             # top 10 priority keywords
 *   node scripts/check-rankings.js --all       # all published keywords
 *   node scripts/check-rankings.js --kw "best AI writing tools 2026"  # specific kw
 *
 * Schedule: run weekly (Mondays) to track progress.
 *
 * NOTE: Google may throttle/captcha after many searches. We add delays
 * between searches. If Google shows captcha, script exits gracefully.
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
const args = process.argv.slice(2);
const ALL = args.includes("--all");
const SPECIFIC_KW = args[args.indexOf("--kw") + 1];

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
  if (!res.ok) throw new Error(`Supa: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

(async () => {
  let playwright;
  try { playwright = require("playwright"); }
  catch { console.error("❌ Playwright not installed."); process.exit(1); }

  // Get keywords to check
  let keywords;
  if (SPECIFIC_KW) {
    keywords = [{ keyword: SPECIFIC_KW, id: null }];
  } else if (ALL) {
    keywords = await supa("GET", "keywords?status=eq.published&select=id,keyword&order=priority.desc");
  } else {
    keywords = await supa("GET", "keywords?status=eq.published&select=id,keyword&order=priority.desc&limit=10");
  }

  console.log(`Checking rankings for ${keywords.length} keywords...\n`);

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  const results = [];

  for (const [i, kw] of keywords.entries()) {
    const q = encodeURIComponent(kw.keyword);
    const url = `https://www.google.com/search?q=${q}&num=50&hl=en&gl=us`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Detect captcha
      const content = await page.content();
      if (content.includes("unusual traffic") || content.includes("captcha")) {
        console.log(`   [${i + 1}/${keywords.length}] 🚧 Google captcha — stopping`);
        break;
      }

      // Find aipickd.com in results
      const aipickdResults = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll("a[href*='aipickd.com']"));
        return links.map((a) => a.href).filter((h) => !h.includes("google.com"));
      });

      // Approximate position: count how many <h3> appear before the first aipickd.com link
      let position = null;
      let aipickdUrl = null;
      if (aipickdResults.length > 0) {
        aipickdUrl = aipickdResults[0];
        position = await page.evaluate((targetHref) => {
          const allResults = Array.from(document.querySelectorAll("h3"));
          for (let i = 0; i < allResults.length; i++) {
            const link = allResults[i].closest("a") || allResults[i].parentElement?.querySelector("a");
            if (link && link.href === targetHref) return i + 1;
          }
          return null;
        }, aipickdUrl);
      }

      const result = {
        keyword: kw.keyword,
        position,
        url: aipickdUrl,
      };
      results.push(result);

      const emoji = position === null ? "—" : position <= 3 ? "🥇" : position <= 10 ? "🔝" : position <= 20 ? "📄" : "📋";
      const posStr = position === null ? "NOT IN TOP 50" : `#${position}`;
      console.log(`   [${(i + 1).toString().padStart(2, "0")}/${keywords.length}] ${emoji} "${kw.keyword.slice(0, 45)}" → ${posStr}`);

      // Delay between searches to avoid getting blocked
      await page.waitForTimeout(3000 + Math.random() * 2000);
    } catch (e) {
      console.log(`   [${i + 1}/${keywords.length}] ❌ ${kw.keyword}: ${e.message.slice(0, 80)}`);
      results.push({ keyword: kw.keyword, position: null, url: null, error: e.message });
    }
  }

  await browser.close();

  // Summary
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  📊 RANKINGS SUMMARY`);
  console.log(`═══════════════════════════════════════════════════════`);
  const ranked = results.filter((r) => r.position !== null);
  const top3 = results.filter((r) => r.position !== null && r.position <= 3).length;
  const top10 = results.filter((r) => r.position !== null && r.position <= 10).length;
  const top20 = results.filter((r) => r.position !== null && r.position <= 20).length;
  console.log(`   Keywords checked:  ${results.length}`);
  console.log(`   Ranked in top 50:  ${ranked.length}`);
  console.log(`   🥇 Top 3:          ${top3}`);
  console.log(`   🔝 Top 10:         ${top10}`);
  console.log(`   📄 Top 20:         ${top20}`);
  console.log(`═══════════════════════════════════════════════════════`);

  // Save to Supabase system_config for history
  const snapshot = {
    date: new Date().toISOString().slice(0, 10),
    total_checked: results.length,
    top_3: top3,
    top_10: top10,
    top_20: top20,
    ranked: ranked.length,
    results,
  };

  try {
    await supa("POST", "system_config", {
      key: `rankings_${snapshot.date}`,
      value: snapshot,
      description: `Google rankings snapshot ${snapshot.date}`,
    });
    console.log(`\n📝 Snapshot saved: rankings_${snapshot.date}`);
  } catch (e) {
    // Might conflict if already exists today — that's OK
    console.log(`\n(Snapshot save skipped — ${e.message.slice(0, 50)})`);
  }

  if (ranked.length === 0) {
    console.log(`\n💡 No rankings yet — normal for a new site. Check back in 30 days.`);
    console.log(`   Meanwhile: Google Search Console shows even early impressions (before top 50 rankings).`);
  }
})().catch((e) => { console.error("❌ FATAL:", e.message); process.exit(1); });
