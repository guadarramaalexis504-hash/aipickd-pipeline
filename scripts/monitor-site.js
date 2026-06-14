#!/usr/bin/env node
/**
 * AIPickd — Site health monitor (lightweight HTTP)
 *
 * Determines whether aipickd.com is UP via a cheap HTTP fetch — NOT a full
 * browser navigation. This is deliberate: aipickd.com runs on Hostinger shared
 * hosting whose first request after idle cold-starts (measured 2026-06-14:
 * homepage 200 in 12.35s cold, 0.5s warm). A full Playwright `page.goto` of a
 * cold WordPress page — with every render-blocking subresource — routinely blew
 * past the old 30s timeout *while the site was perfectly healthy*, which is what
 * spammed #alertas with "site down" false alarms. A plain `fetch` of the HTML is
 * the true up/down signal and absorbs the cold-start comfortably.
 *
 * Reliability design (kills the false alarms):
 *   - warm-up Hostinger before checking (absorbs the cold-start)
 *   - generous 45s per-attempt timeout (cold-start ~12s, sometimes higher)
 *   - 3 strikes per URL with a re-warm between strikes — only a *sustained*
 *     failure trips an issue, never a single transient cold-start
 *   - "slow" is a WARNING (logged), not an issue (never alerts)
 *
 * Sends alert via Discord (#alertas) only when a real problem is detected.
 *
 * Schedule: GitHub Actions, hourly (.github/workflows/monitor.yml).
 *
 * Usage:
 *   node scripts/monitor-site.js            # full check
 *   node scripts/monitor-site.js --alert    # only alert on errors (silent if OK)
 */

const { notifyUptimeDown, notifyUptimeRestored, notifyAlert } = require("./notify.js");
const { loadEnv } = require("./lib/env");
const { warmUp } = require("./lib/warmup");
const { fetchWithRetry } = require("./lib/http");

const env = loadEnv();

const ALERT_ONLY = process.argv.includes("--alert");

// Tuned for Hostinger shared hosting cold-starts.
const CHECK_TIMEOUT_MS = 45_000; // per attempt — cold-start measured ~12s, leave generous headroom
const SLOW_MS = 15_000; // above this is "slow" (informational), still UP
const MAX_STRIKES = 3; // a single cold-start must never alert; only sustained failure does

const urlsToCheck = [
  { name: "Homepage", url: "https://aipickd.com/" },
  { name: "About", url: "https://aipickd.com/about/" },
  { name: "Sample article", url: "https://aipickd.com/jasper-vs-copy-vs-writesonic/" },
  { name: "Sitemap", url: "https://aipickd.com/wp-sitemap.xml" },
];

// One lightweight HTTP attempt → result object. Throws on network error / timeout.
async function checkOnce(check) {
  const t0 = Date.now();
  const isXml = check.url.endsWith(".xml");
  const res = await fetchWithRetry(
    check.url,
    { headers: { "User-Agent": "AIPickd Health Monitor/2.0 (admin health check)" } },
    { timeout: CHECK_TIMEOUT_MS, retries: 0 } // strikes + warm-up are handled below
  );
  const body = await res.text().catch(() => "");
  const loadMs = Date.now() - t0;
  const minOk = isXml ? 100 : 1000; // a real WP page is many KB; a real sitemap is >100 bytes
  return {
    name: check.name,
    url: check.url,
    status: res.status,
    loadMs,
    isXml,
    bodyLength: body.length,
    ok: res.status >= 200 && res.status < 400 && body.length > minOk,
  };
}

(async () => {
  const issues = []; // real problems → alert
  const warnings = []; // informational (slow) → log only, never alerts
  const results = [];

  // Warm up Hostinger before checking — absorbs the cold-start that would
  // otherwise show up as a false "site down" on the very first request.
  await warmUp({ log: true, attempts: 4 }).catch(() => {});

  // 3-STRIKES: a single cold-start timeout on shared hosting is NOT an outage.
  // Only record an issue if a URL fails MAX_STRIKES times, with a re-warm in
  // between. This is what kills the "site down" false alarms.
  for (const check of urlsToCheck) {
    let result = null;
    let errMsg = null;
    for (let strike = 1; strike <= MAX_STRIKES; strike++) {
      try {
        result = await checkOnce(check);
        if (result.ok) break; // success — no further strikes needed
        errMsg = `HTTP ${result.status} (content ${result.bodyLength} bytes)`;
      } catch (e) {
        result = null;
        errMsg = (e.message || String(e)).split("\n")[0].slice(0, 100);
      }
      if (strike < MAX_STRIKES) {
        await warmUp({ attempts: 2 }).catch(() => {}); // re-wake before retry
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    if (result && result.ok) {
      results.push(result);
      if (!result.isXml && result.loadMs > SLOW_MS) {
        warnings.push(`${check.name}: slow (${result.loadMs}ms) — cold-start or consider Cloudflare`);
      }
      console.log(
        `  ✅ ${check.name.padEnd(20)} ${result.status} ${result.loadMs}ms ${(result.bodyLength / 1024).toFixed(0)}KB`
      );
    } else {
      if (result) results.push(result);
      issues.push(`${check.name}: ${errMsg} (failed ${MAX_STRIKES}×)`);
      console.log(`  ❌ ${check.name}: ${errMsg} (failed ${MAX_STRIKES}×)`);
    }
  }

  // Post count check via Supabase (more reliable than WP REST which needs auth)
  try {
    const supaRes = await fetch(`${env.SUPABASE_URL}/rest/v1/articles?status=eq.published&select=id`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "count=exact",
      },
    });
    const range = supaRes.headers.get("content-range") || "";
    const total = range.split("/")[1];
    console.log(`  📝 Published articles (Supabase): ${total}`);
    if (parseInt(total) < 10) issues.push(`Low published count: ${total}`);
  } catch (e) {
    // A Supabase blip is NOT a site outage — log it as a warning, don't alert.
    warnings.push(`Cannot read article count: ${e.message.slice(0, 60)}`);
  }

  if (warnings.length > 0) {
    console.log(`\nℹ️  ${warnings.length} warning(s) (informational, no alert):`);
    warnings.forEach((w) => console.log(`    - ${w}`));
  }

  if (issues.length > 0) {
    console.log(`\n🚨 ${issues.length} ISSUE(S) DETECTED:`);
    issues.forEach((i) => console.log(`    - ${i}`));

    // Route to #alertas. "Site down" = a connectivity/availability failure.
    const isSiteDown = issues.some((i) => /HTTP 5|ERR_|timeout|failed \d+×/i.test(i));
    if (isSiteDown) {
      const firstResult = results.find((r) => !r.ok);
      const statusCode = firstResult?.status || null;
      const responseMs = firstResult?.loadMs || null;
      await notifyUptimeDown(statusCode, responseMs).catch(() => {});
    }
    const alertMsg = `**${issues.length} problema(s) detectado(s) en aipickd.com**\n\n${issues
      .map((i) => `• ${i}`)
      .join("\n")}\n\n🔗 https://aipickd.com/`;
    const r = await notifyAlert(alertMsg, isSiteDown ? "critical" : "high").catch(() => ({ ok: false }));
    console.log(`\n📨 Alert sent to #alertas: ${r.ok ? "✅" : "❌"}`);

    process.exit(1);
  } else {
    console.log(`\n✅ All checks passed. Site is healthy.`);
    if (!ALERT_ONLY) {
      // Optional "all good" ping to #alertas
      const totalMs = results.reduce((s, r) => s + (r.loadMs || 0), 0);
      const avgMs = Math.round(totalMs / Math.max(1, results.length));
      await notifyUptimeRestored(avgMs).catch(() => {});
    }
  }
})().catch((e) => {
  console.error("❌ FATAL:", e.message);
  process.exit(1);
});
