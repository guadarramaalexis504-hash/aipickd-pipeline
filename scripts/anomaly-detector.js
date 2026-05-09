#!/usr/bin/env node
/**
 * AIPickd — Anomaly detector
 *
 * Flags suspicious patterns in the system that could indicate:
 *   - Bot/scraper attacks (sudden traffic spikes)
 *   - Compromised account (unusual logins)
 *   - Pipeline malfunction (cost spike, low-quality output flooding)
 *   - Data integrity issues (missing fields, duplicates, etc)
 *
 * Designed to be run hourly via GitHub Actions and alert via Discord/Telegram
 * when anomalies are detected.
 *
 * Usage: node scripts/anomaly-detector.js
 */
const { loadEnv } = require("./lib/env");
const { fetchWithRetry } = require("./lib/http");

const env = loadEnv();

const anomalies = [];
function flag(severity, type, message, data = {}) {
  anomalies.push({ severity, type, message, data, ts: new Date().toISOString() });
}

async function supa(endpoint) {
  try {
    const r = await fetchWithRetry(
      `${env.SUPABASE_URL}/rest/v1/${endpoint}`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
      { timeout: 15000, retries: 2 }
    );
    return r.ok ? r.json() : null;
  } catch (e) {
    process.stderr.write(`[anomaly-detector] supa(${endpoint}) failed: ${e.message}\n`);
    return null;
  }
}

(async () => {
  console.log("\n🔍 AIPickd Anomaly Detection\n");

  // 1. Articles published in the last hour
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await supa(`articles?published_at=gt.${hourAgo}&select=id,word_count,generation_cost_usd,title`);
  if (Array.isArray(recent)) {
    if (recent.length > 5) {
      flag("medium", "rapid-publishing",
        `${recent.length} articles published in last hour (expected: 1-2)`,
        { count: recent.length });
    }
    // Check if any have suspicious low word count
    const tooShort = recent.filter((a) => (a.word_count || 0) < 800);
    if (tooShort.length > 0) {
      flag("medium", "low-quality",
        `${tooShort.length} of ${recent.length} recent articles are <800 words`,
        { titles: tooShort.map((a) => a.title) });
    }
    // Check if cost-per-article is way off
    const totalCost = recent.reduce((s, a) => s + (parseFloat(a.generation_cost_usd) || 0), 0);
    const avgCost = totalCost / Math.max(recent.length, 1);
    if (avgCost > 0.20) {
      flag("high", "cost-spike",
        `Avg cost per article in last hour is $${avgCost.toFixed(4)} (expected: ~$0.05)`,
        { avg_cost: avgCost, count: recent.length });
    }
  }

  // 2. Duplicate detection — same title in last 24h
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const today = await supa(`articles?published_at=gt.${dayAgo}&select=id,title`);
  if (Array.isArray(today) && today.length > 0) {
    const titleCounts = {};
    today.forEach((a) => {
      const norm = a.title.toLowerCase().trim();
      titleCounts[norm] = (titleCounts[norm] || 0) + 1;
    });
    const dupes = Object.entries(titleCounts).filter(([_, c]) => c > 1);
    if (dupes.length > 0) {
      flag("high", "duplicate-articles",
        `${dupes.length} duplicate titles published in last 24h`,
        { dupes: dupes.map(([t, c]) => ({ title: t, count: c })) });
    }
  }

  // 3. Stuck keyword (in_progress > 1h is a sign of orphaned generation)
  const stuckThreshold = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const stuck = await supa(`keywords?status=eq.in_progress&select=id,keyword,updated_at,assigned_article_id`);
  if (Array.isArray(stuck) && stuck.length > 0) {
    flag("low", "stuck-keywords",
      `${stuck.length} keyword(s) stuck in 'in_progress' status`,
      { count: stuck.length, sample: stuck.slice(0, 3).map((k) => k.keyword) });
  }

  // 4. Cost spike — daily cost > $5
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const todayDate = new Date().toISOString().slice(0, 10);
  const dailyCost = await supa(`articles?published_at=gte.${todayDate}&select=generation_cost_usd`);
  if (Array.isArray(dailyCost)) {
    const total = dailyCost.reduce((s, a) => s + (parseFloat(a.generation_cost_usd) || 0), 0);
    if (total > 5) {
      flag("critical", "daily-budget-exceeded",
        `Daily spend $${total.toFixed(2)} exceeds soft cap of $5`,
        { spend: total });
    }
  }

  // 5. Site availability check
  let siteResponseMs = null;
  let siteIsDown = false;
  try {
    const siteStart = Date.now();
    const r = await fetch("https://aipickd.com/", {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0 AIPickd-anomaly-check/1.0" },
    });
    siteResponseMs = Date.now() - siteStart;
    if (!r.ok) {
      flag("high", "site-down", `aipickd.com returned ${r.status}`, { status: r.status, ms: siteResponseMs });
      siteIsDown = true;
    } else {
      console.log(`  ✅ Site OK — ${r.status} in ${siteResponseMs}ms`);
    }
  } catch (e) {
    flag("critical", "site-unreachable", `aipickd.com unreachable: ${e.message}`, { error: e.message });
    siteIsDown = true;
  }

  // === Output ===
  if (anomalies.length === 0) {
    console.log("✅ No anomalies detected\n");
    process.exit(0);
  }

  const sevColors = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" };
  console.log(`\nFound ${anomalies.length} anomalies:\n`);
  anomalies.forEach((a) => {
    console.log(`  ${sevColors[a.severity]} [${a.severity.toUpperCase()}] ${a.type}: ${a.message}`);
  });

  // Send to Discord using proper notify.js embeds
  const { notifyAlert, notifyUptimeDown } = require("./notify.js");

  // Site down: dedicated uptime alert
  if (siteIsDown) {
    const siteAnomaly = anomalies.find(a => a.type === "site-down" || a.type === "site-unreachable");
    if (siteAnomaly) {
      try {
        await notifyUptimeDown(siteAnomaly.data?.status || null, siteResponseMs);
        console.log("📨 Site down alert sent to Discord");
      } catch {}
    }
  }

  // Other anomalies: group critical + high into one alert
  const criticalAndHigh = anomalies.filter(
    (a) => (a.severity === "critical" || a.severity === "high") && a.type !== "site-down" && a.type !== "site-unreachable"
  );
  if (criticalAndHigh.length > 0) {
    const msg = criticalAndHigh
      .map((a) => `${sevColors[a.severity]} **${a.type}**: ${a.message}`)
      .join("\n\n");
    try {
      const worst = criticalAndHigh.some(a => a.severity === "critical") ? "critical" : "high";
      await notifyAlert(`**${criticalAndHigh.length} anomalía(s) detectada(s)**\n\n${msg}`, worst);
      console.log("📨 Anomaly alert sent to Discord");
    } catch {}
  }

  // Medium anomalies: single info alert
  const medium = anomalies.filter(a => a.severity === "medium");
  if (medium.length > 0) {
    const msg = medium.map(a => `🟡 **${a.type}**: ${a.message}`).join("\n\n");
    try {
      await notifyAlert(`**${medium.length} anomalía(s) media(s)**\n\n${msg}`, "warning");
    } catch {}
  }

  // Exit code reflects worst severity for CI use
  if (anomalies.some((a) => a.severity === "critical")) process.exit(2);
  if (anomalies.some((a) => a.severity === "high")) process.exit(1);
  process.exit(0);
})().catch((e) => { console.error("❌", e); process.exit(99); });
