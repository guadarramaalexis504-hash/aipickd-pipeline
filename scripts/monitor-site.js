#!/usr/bin/env node
/**
 * AIPickd site availability monitor.
 *
 * The monitor keeps Playwright rendering checks, but curl is the diagnostic
 * source of truth for outages because it exposes DNS/connect/TLS/TTFB/IP data.
 *
 * Usage:
 *   node scripts/monitor-site.js
 *   node scripts/monitor-site.js --alert
 */

const { notifyAlert, notifyUptimeDown, notifyUptimeRestored } = require("./notify.js");
const {
  DEFAULT_CHECKS,
  DEFAULT_USER_AGENTS,
  PLAYWRIGHT_USER_AGENT,
  buildAlertMessage,
  classifyIncident,
  diagnoseDnsForChecks,
  formatDiagnosticLine,
  formatProbeConsole,
  runProbeMatrix,
  summarizeUrlResults,
} = require("./lib/availability-monitor");
const { loadEnv } = require("./lib/env");
const { warmUp } = require("./lib/warmup");

const env = loadEnv();
const ALERT_ONLY = process.argv.includes("--alert");

async function checkWithPlaywright(checks) {
  let playwright;
  try {
    playwright = require("playwright");
  } catch (error) {
    return {
      ok: false,
      issues: [`Playwright unavailable: ${error.message}`],
      consoleErrors: [],
      results: [],
    };
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: PLAYWRIGHT_USER_AGENT });
  const page = await context.newPage();
  const issues = [];
  const consoleErrors = [];
  const results = [];

  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  try {
    for (const check of checks.filter((item) => item.kind !== "json")) {
      const start = Date.now();
      try {
        let status;
        let contentLength;
        let title = "";

        if (check.kind === "xml") {
          const response = await page.request.get(check.url, { timeout: 30000 });
          status = response.status();
          contentLength = (await response.text()).length;
        } else {
          const response = await page.goto(check.url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
          status = response?.status() || 0;
          title = await page.title().catch(() => "");
          contentLength = await page.evaluate(() => document.body?.innerHTML?.length || 0);
        }

        const loadMs = Date.now() - start;
        const minOk = check.kind === "xml" ? 100 : 1000;
        const ok = status >= 200 && status < 400 && contentLength > minOk;
        const result = {
          name: check.name,
          url: check.url,
          status,
          loadMs,
          bodyLength: contentLength,
          title: title.slice(0, 60),
          ok,
        };
        results.push(result);
        if (!ok) issues.push(`${check.name}: HTTP ${status} content=${contentLength} bytes`);
      } catch (error) {
        const message = error.message.split("\n")[0].slice(0, 160);
        issues.push(`${check.name}: ${message}`);
        results.push({
          name: check.name,
          url: check.url,
          status: 0,
          loadMs: Date.now() - start,
          bodyLength: 0,
          ok: false,
          error: message,
        });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return {
    ok: issues.length === 0,
    issues,
    consoleErrors,
    results,
  };
}

async function readPublishedArticleCount() {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      ok: true,
      skipped: true,
      message: "Supabase article count skipped: env not configured",
    };
  }

  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/articles?status=eq.published&select=id`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "count=exact",
      },
      signal: AbortSignal.timeout(15000),
    }
  );
  const range = response.headers.get("content-range") || "";
  const total = Number(range.split("/")[1]) || 0;
  if (total < 10) return { ok: false, message: `Low published count: ${total}`, total };
  return { ok: true, total };
}

function firstFailedDiagnostic(urlSummaries) {
  for (const summary of urlSummaries) {
    const result = (summary.finalResults || []).find((item) => !item.ok);
    if (result) return result;
  }
  return null;
}

function logProbeDetails(urlSummaries) {
  for (const summary of urlSummaries) {
    console.log(`  ${formatProbeConsole(summary)}`);
    for (const result of summary.finalResults || []) {
      console.log(`    ${formatDiagnosticLine(result)}`);
    }
  }
}

(async () => {
  const start = Date.now();

  console.log("AIPickd availability monitor");
  console.log(`Checks: ${DEFAULT_CHECKS.map((check) => check.name).join(", ")}`);
  console.log(`User-Agents: ${DEFAULT_USER_AGENTS.map((ua) => ua.name).join(", ")}`);

  await warmUp({ log: true }).catch(() => {});

  const dnsDiagnostics = await diagnoseDnsForChecks(DEFAULT_CHECKS).catch((error) => [
    {
      hostname: "aipickd.com",
      system: { resolver: "system", ok: false, error: error.message },
      cloudflare: { resolver: "1.1.1.1", ok: false, error: "not checked" },
    },
  ]);

  const probeResults = await runProbeMatrix({
    checks: DEFAULT_CHECKS,
    userAgents: DEFAULT_USER_AGENTS,
    maxAttempts: 2,
    backoffMs: [2000],
    onRetry: async () => {
      await warmUp({ attempts: 2 }).catch(() => {});
    },
    log: (message) => console.log(message),
  });
  const urlSummaries = summarizeUrlResults({ checks: DEFAULT_CHECKS, probeResults });

  console.log("\nHTTP diagnostics:");
  logProbeDetails(urlSummaries);

  console.log("\nPlaywright render check:");
  const playwrightResult = await checkWithPlaywright(DEFAULT_CHECKS);
  for (const result of playwrightResult.results) {
    const marker = result.ok ? "OK" : "FAIL";
    console.log(
      `  ${marker} ${result.name} code=${result.status} total=${result.loadMs}ms body=${result.bodyLength}`
    );
  }
  if (playwrightResult.issues.length > 0) {
    playwrightResult.issues.forEach((issue) => console.log(`  issue: ${issue}`));
  }
  if (playwrightResult.consoleErrors.length > 0) {
    console.log("  console errors:");
    playwrightResult.consoleErrors
      .slice(0, 5)
      .forEach((error) => console.log(`    - ${error.slice(0, 120)}`));
  }

  const contentIssues = [];
  try {
    const articleCount = await readPublishedArticleCount();
    if (articleCount.skipped) {
      console.log(`\nContent check: ${articleCount.message}`);
    } else {
      console.log(`\nContent check: published articles=${articleCount.total}`);
      if (!articleCount.ok) contentIssues.push(articleCount.message);
    }
  } catch (error) {
    contentIssues.push(`Cannot read article count: ${error.message.slice(0, 100)}`);
    console.log(`\nContent check issue: ${contentIssues[contentIssues.length - 1]}`);
  }

  const classification = classifyIncident({
    urlSummaries,
    dnsDiagnostics,
    playwrightResult,
  });
  const totalMs = Date.now() - start;

  console.log(`\nTotal check time: ${totalMs}ms`);
  console.log(`Severity: ${classification.severity}`);
  classification.diagnoses.forEach((diagnosis) => console.log(`  - ${diagnosis.text}`));

  const hasAvailabilityIssue = classification.severity !== "ok";
  const hasContentIssue = contentIssues.length > 0;

  if (hasAvailabilityIssue || hasContentIssue) {
    const severity = classification.severity === "ok" ? "warning" : classification.severity;
    let alertMessage = buildAlertMessage({
      classification:
        classification.severity === "ok"
          ? {
              ...classification,
              severity,
              diagnoses: [
                ...classification.diagnoses,
                { code: "content_issue", text: "Content count check reported an issue." },
              ],
            }
          : classification,
      urlSummaries,
      dnsDiagnostics,
      playwrightResult,
      totalMs,
    });
    if (contentIssues.length > 0) {
      alertMessage += `\n\nContent issues:\n${contentIssues.map((issue) => `- ${issue}`).join("\n")}`;
    }

    if (severity === "critical") {
      const firstFailed = firstFailedDiagnostic(urlSummaries);
      await notifyUptimeDown(
        firstFailed?.statusCode || null,
        firstFailed?.timings?.totalMs || null
      ).catch(() => {});
    }
    const result = await notifyAlert(alertMessage, severity).catch(() => ({ ok: false }));
    console.log(`\nAlert sent to #alertas (${severity}): ${result.ok ? "yes" : "no"}`);
    process.exit(1);
  }

  console.log("\nAll availability checks passed.");
  if (!ALERT_ONLY) {
    const avgMs = Math.round(
      urlSummaries
        .flatMap((summary) => summary.finalResults || [])
        .reduce((sum, result) => sum + (result.timings?.totalMs || 0), 0) /
        Math.max(1, urlSummaries.flatMap((summary) => summary.finalResults || []).length)
    );
    await notifyUptimeRestored(avgMs).catch(() => {});
  }
})().catch((error) => {
  console.error("FATAL:", error.message);
  process.exit(1);
});
