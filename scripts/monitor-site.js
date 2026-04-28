#!/usr/bin/env node
/**
 * AIPickd — Site health monitor (Playwright)
 *
 * Runs a full browser check on aipickd.com and reports:
 *   - Is site up?
 *   - Load time (Core Web Vitals)
 *   - Any console errors?
 *   - Are key pages rendering properly?
 *
 * Sends alert via Discord/Telegram if problems detected.
 *
 * Schedule:
 *   Use Windows Task Scheduler to run every hour:
 *     node scripts/monitor-site.js
 *
 * Usage:
 *   node scripts/monitor-site.js            # full check
 *   node scripts/monitor-site.js --alert    # only alert on errors (silent if OK)
 */

const fs = require("fs");
const path = require("path");
const { notify, notifyUptimeDown, notifyUptimeRestored, notifyAlert } = require("./notify.js");

const envPath = path.join(__dirname, "..", ".env");
const env = {};
fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
  const m = line.match(/^([A-Z_]+)="?([^"\n]*)"?$/);
  if (m) env[m[1]] = m[2];
});

const ALERT_ONLY = process.argv.includes("--alert");

(async () => {
  let playwright;
  try {
    playwright = require("playwright");
  } catch {
    console.error("❌ Playwright not installed. Run: npm install playwright && npx playwright install chromium");
    process.exit(1);
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "AIPickd Health Monitor (Playwright) - admin health check",
  });
  const page = await context.newPage();

  const issues = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const start = Date.now();
  const urlsToCheck = [
    { name: "Homepage", url: "https://aipickd.com/" },
    { name: "About", url: "https://aipickd.com/about/" },
    { name: "Sample article", url: "https://aipickd.com/jasper-vs-copy-vs-writesonic/" },
    { name: "Sitemap", url: "https://aipickd.com/wp-sitemap.xml" },
  ];

  const results = [];

  for (const check of urlsToCheck) {
    try {
      const t0 = Date.now();
      const isXml = check.url.endsWith(".xml");
      let status, contentLength, title;
      if (isXml) {
        // Use raw HTTP request — page.goto on XML returns body length 0 in headless
        const r = await page.request.get(check.url, { timeout: 30000 });
        status = r.status();
        const txt = await r.text();
        contentLength = txt.length;
        title = "";
      } else {
        const response = await page.goto(check.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        status = response.status();
        title = await page.title().catch(() => "");
        contentLength = await page.evaluate(() => document.body?.innerHTML?.length || 0);
      }
      const loadMs = Date.now() - t0;
      const minOk = isXml ? 100 : 1000;

      const result = {
        name: check.name,
        url: check.url,
        status,
        loadMs,
        title: title.slice(0, 60),
        bodyLength: contentLength,
        ok: status >= 200 && status < 400 && contentLength > minOk,
      };
      results.push(result);

      if (!result.ok) {
        issues.push(`${check.name}: HTTP ${status} (content ${contentLength} bytes)`);
      } else if (!isXml && loadMs > 5000) {
        issues.push(`${check.name}: slow (${loadMs}ms) - consider Cloudflare`);
      }

      console.log(`  ${result.ok ? "✅" : "❌"} ${check.name.padEnd(20)} ${status} ${loadMs}ms ${(contentLength/1024).toFixed(0)}KB`);
    } catch (e) {
      issues.push(`${check.name}: ${e.message.slice(0, 100)}`);
      console.log(`  ❌ ${check.name}: ${e.message.slice(0, 80)}`);
    }
  }

  // Post count check via Supabase (more reliable than WP REST which needs auth)
  try {
    const supaRes = await fetch(`${env.SUPABASE_URL}/rest/v1/articles?status=eq.published&select=id`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Prefer: "count=exact" },
    });
    const range = supaRes.headers.get("content-range") || "";
    const total = range.split("/")[1];
    console.log(`  📝 Published articles (Supabase): ${total}`);
    if (parseInt(total) < 10) issues.push(`Low published count: ${total}`);
  } catch (e) {
    issues.push(`Cannot read article count: ${e.message.slice(0, 60)}`);
  }

  await browser.close();

  const totalMs = Date.now() - start;
  console.log(`\n⏱️  Total check time: ${totalMs}ms`);

  if (consoleErrors.length > 0) {
    console.log(`\n⚠️  Console errors detected:`);
    consoleErrors.slice(0, 5).forEach((e) => console.log(`    - ${e.slice(0, 120)}`));
  }

  if (issues.length > 0) {
    console.log(`\n🚨 ${issues.length} ISSUE(S) DETECTED:`);
    issues.forEach((i) => console.log(`    - ${i}`));

    // Alert via notifications — route to #alertas channel
    const isSiteDown = issues.some(i => i.includes("HTTP 5") || i.includes("ERR_") || i.includes("timeout"));
    if (isSiteDown) {
      const firstResult = results.find(r => !r.ok);
      const statusCode = firstResult?.status || null;
      const responseMs = firstResult?.loadMs || null;
      await notifyUptimeDown(statusCode, responseMs).catch(() => {});
    }
    const alertMsg = `**${issues.length} problema(s) detectado(s) en aipickd.com**\n\n${issues.map(i => `• ${i}`).join("\n")}\n\n🔗 https://aipickd.com/`;
    const r = await notifyAlert(alertMsg, isSiteDown ? "critical" : "high").catch(() => ({ ok: false }));
    console.log(`\n📨 Alert sent to #alertas: ${r.ok ? "✅" : "❌"}`);

    process.exit(1);
  } else {
    console.log(`\n✅ All checks passed. Site is healthy.`);
    if (!ALERT_ONLY) {
      // Optional "all good" ping to #alertas
      const avgMs = Math.round(totalMs / results.length);
      await notifyUptimeRestored(avgMs).catch(() => {});
    }
  }
})().catch((e) => { console.error("❌ FATAL:", e.message); process.exit(1); });
