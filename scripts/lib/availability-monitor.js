const { spawn } = require("node:child_process");
const dns = require("node:dns");

const METRICS_MARKER = "__AIPICKD_CURL_METRICS__";

const DEFAULT_CHECKS = [
  { name: "Homepage", url: "https://aipickd.com/", core: true, kind: "html" },
  { name: "About", url: "https://aipickd.com/about/", core: true, kind: "html" },
  {
    name: "Sample article",
    url: "https://aipickd.com/jasper-vs-copy-vs-writesonic/",
    core: true,
    kind: "html",
  },
  { name: "Sitemap", url: "https://aipickd.com/wp-sitemap.xml", core: true, kind: "xml" },
  {
    name: "WP REST",
    url: "https://aipickd.com/wp-json/wp/v2/posts?per_page=1",
    core: false,
    kind: "json",
  },
];

const DEFAULT_USER_AGENTS = [
  {
    name: "chrome",
    value:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  {
    name: "aipickd-monitor",
    value: "AIPickd-monitor/1.0",
  },
];

const PLAYWRIGHT_USER_AGENT = "AIPickd Health Monitor (Playwright) - admin health check";

const IMPORTANT_HEADERS = ["server", "x-litespeed-cache", "cache-control", "cf-ray"];

function getCurlBin() {
  if (process.env.CURL_BIN) return process.env.CURL_BIN;
  return process.platform === "win32" ? "curl.exe" : "curl";
}

function nullDevice() {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

function ipVersion(ip) {
  if (!ip) return "unknown";
  if (ip.includes(":")) return "IPv6";
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return "IPv4";
  return "unknown";
}

function toMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000);
}

function firstErrorLine(stderr) {
  return (
    String(stderr || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0] || ""
  );
}

function parseHeaderBlocks(stdout) {
  const withoutMetrics = String(stdout || "")
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(METRICS_MARKER))
    .join("\n");

  return withoutMetrics
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter((block) => /^HTTP\//i.test(block));
}

function parseImportantHeaders(stdout) {
  const blocks = parseHeaderBlocks(stdout);
  const finalBlock = blocks[blocks.length - 1] || "";
  const headers = {};

  for (const line of finalBlock.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (IMPORTANT_HEADERS.includes(name)) headers[name] = value;
  }

  return headers;
}

function parseMetrics(stdout) {
  const line = String(stdout || "")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(METRICS_MARKER));
  if (!line) return {};

  try {
    return JSON.parse(line.slice(METRICS_MARKER.length));
  } catch {
    return {};
  }
}

function parseCurlDiagnostic({
  stdout,
  stderr,
  exitCode,
  check,
  userAgent,
  attempt,
  resolver = "system",
}) {
  const metrics = parseMetrics(stdout);
  const statusCode = Number(metrics.http_code) || 0;
  const headers = parseImportantHeaders(stdout);
  const ip = metrics.remote_ip || "";
  const error = firstErrorLine(stderr);
  const ok = exitCode === 0 && statusCode >= 200 && statusCode < 400;

  return {
    name: check.name,
    url: check.url,
    userAgentName: userAgent.name,
    attempt,
    resolver,
    ok,
    statusCode,
    error,
    finalUrl: metrics.url_effective || check.url,
    redirects: Number(metrics.num_redirects) || 0,
    ip,
    ipVersion: ipVersion(ip),
    timings: {
      dnsMs: toMs(metrics.time_namelookup),
      connectMs: toMs(metrics.time_connect),
      tlsMs: toMs(metrics.time_appconnect),
      ttfbMs: toMs(metrics.time_starttransfer),
      totalMs: toMs(metrics.time_total),
    },
    headers,
  };
}

function msText(value) {
  return value === null || value === undefined ? "n/a" : `${value}ms`;
}

function fieldText(value) {
  return value === null || value === undefined || value === "" ? "n/a" : String(value);
}

function formatDiagnosticLine(result) {
  const headerText = IMPORTANT_HEADERS.map((name) => {
    const value = result.headers?.[name];
    return value ? `${name}=${value}` : null;
  })
    .filter(Boolean)
    .join(" ");

  return [
    `${result.name}:`,
    `ua=${fieldText(result.userAgentName)}`,
    `code=${fieldText(result.statusCode || result.error || "n/a")}`,
    `dns=${msText(result.timings?.dnsMs)}`,
    `connect=${msText(result.timings?.connectMs)}`,
    `tls=${msText(result.timings?.tlsMs)}`,
    `ttfb=${msText(result.timings?.ttfbMs)}`,
    `total=${msText(result.timings?.totalMs)}`,
    `ip=${fieldText(result.ip)}`,
    `family=${fieldText(result.ipVersion)}`,
    `resolver=${fieldText(result.resolver)}`,
    `final=${fieldText(result.finalUrl)}`,
    headerText,
  ]
    .filter(Boolean)
    .join(" ");
}

function addDiagnosis(diagnoses, code, text) {
  if (!diagnoses.some((d) => d.code === code)) diagnoses.push({ code, text });
}

function hasCloudflareSignal(summary) {
  return (summary.finalResults || []).some((result) => {
    const hasCfRay = Boolean(result.headers?.["cf-ray"]);
    return hasCfRay && (!result.ok || result.statusCode === 403 || result.statusCode === 429);
  });
}

function classifyIncident({ urlSummaries = [], dnsDiagnostics = [], playwrightResult = null }) {
  const diagnoses = [];
  const finalFailed = urlSummaries.filter((summary) => !summary.finalOk);
  const transientRecovered = urlSummaries.filter(
    (summary) => summary.finalOk && summary.hadTransientFailure
  );
  const coreSummaries = urlSummaries.filter((summary) => summary.core);
  const allCoreFailed =
    coreSummaries.length >= 4 && coreSummaries.every((summary) => !summary.finalOk);
  const consecutiveFailure = finalFailed.some((summary) => (summary.consecutiveFailures || 0) >= 2);
  const dnsLocalRunner = dnsDiagnostics.some(
    (entry) => entry.system?.ok === false && entry.cloudflare?.ok === true
  );
  const curlAllOk = urlSummaries.length > 0 && urlSummaries.every((summary) => summary.finalOk);
  const playwrightOnlyFailure = playwrightResult?.ok === false && curlAllOk;
  const cloudflareSignal = urlSummaries.some(hasCloudflareSignal);
  const wpRestFailed = finalFailed.some((summary) => /wp rest/i.test(summary.name));

  let severity = "ok";
  if (allCoreFailed || finalFailed.length >= 2 || consecutiveFailure) {
    severity = "critical";
  } else if (
    finalFailed.length === 1 ||
    transientRecovered.length > 0 ||
    dnsLocalRunner ||
    playwrightOnlyFailure
  ) {
    severity = "warning";
  }

  if (dnsLocalRunner) {
    addDiagnosis(
      diagnoses,
      "dns_local_runner",
      "DNS falla con el resolver local/runner, pero 1.1.1.1 resuelve: probable DNS local o del runner."
    );
  }
  if (allCoreFailed) {
    addDiagnosis(
      diagnoses,
      "hosting_or_network",
      "Homepage, about, sample article y sitemap fallan juntos: probable hosting, red o ruta hacia Hostinger."
    );
  }
  if (playwrightOnlyFailure) {
    addDiagnosis(
      diagnoses,
      "monitor_bot_firewall",
      "Curl responde, pero Playwright falla: probable monitor, bot protection, firewall o bloqueo por runtime."
    );
  }
  if (cloudflareSignal) {
    addDiagnosis(
      diagnoses,
      "cloudflare_waf",
      "Headers Cloudflare presentes en una falla: revisar WAF, Bot Fight Mode o rate limiting."
    );
  }
  if (wpRestFailed) {
    addDiagnosis(
      diagnoses,
      "wordpress_php",
      "WP REST falla: probable WordPress, PHP, plugins o base de datos."
    );
  }
  if (consecutiveFailure) {
    addDiagnosis(
      diagnoses,
      "url_consecutive_failures",
      "Una o mas URLs fallaron en reintentos consecutivos."
    );
  }
  if (finalFailed.length >= 2 && !allCoreFailed) {
    addDiagnosis(
      diagnoses,
      "multi_url_failure",
      "Varias URLs fallan en la misma corrida: probable problema compartido de hosting, cache o red."
    );
  }
  if (transientRecovered.length > 0) {
    addDiagnosis(
      diagnoses,
      "transient_recovered",
      "Hubo una falla inicial que se recupero con backoff: probable cold-start, cache o red transitoria."
    );
  }
  if (diagnoses.length === 0) {
    addDiagnosis(diagnoses, "healthy", "Sin fallas activas detectadas.");
  }

  return {
    severity,
    diagnoses,
    failedUrls: finalFailed.map((summary) => summary.name),
    transientUrls: transientRecovered.map((summary) => summary.name),
  };
}

function trailingFailureCount(attempts) {
  let count = 0;
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i].ok) break;
    count++;
  }
  return count;
}

function summarizeUrlResults({ checks = DEFAULT_CHECKS, probeResults = [] }) {
  return checks.map((check) => {
    const pairs = probeResults.filter((result) => result.check.name === check.name);
    const finalResults = pairs.map((pair) => pair.final);
    const finalOk = finalResults.length > 0 && finalResults.every((result) => result.ok);
    const hadTransientFailure = pairs.some(
      (pair) => pair.final.ok && pair.attempts.some((attempt) => !attempt.ok)
    );
    const firstAttemptFailed = pairs.some((pair) => pair.attempts[0] && !pair.attempts[0].ok);
    const consecutiveFailures = pairs.reduce(
      (max, pair) => Math.max(max, trailingFailureCount(pair.attempts)),
      0
    );

    return {
      name: check.name,
      url: check.url,
      core: Boolean(check.core),
      finalOk,
      hadTransientFailure,
      firstAttemptFailed,
      consecutiveFailures,
      finalResults,
      pairs,
    };
  });
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killed = false;
    const child = spawn(command, args, { windowsHide: true });

    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${error.message}`, exitCode: 127 });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: killed ? `${stderr}\nprocess timeout after ${timeoutMs}ms` : stderr,
        exitCode: killed ? 124 : code,
      });
    });
  });
}

async function runCurlDiagnostic({
  check,
  userAgent,
  attempt = 1,
  timeoutSeconds = 30,
  resolver = "system",
  curlBin = getCurlBin(),
}) {
  const metrics = [
    `${METRICS_MARKER}{`,
    '"http_code":"%{http_code}",',
    '"time_namelookup":"%{time_namelookup}",',
    '"time_connect":"%{time_connect}",',
    '"time_appconnect":"%{time_appconnect}",',
    '"time_starttransfer":"%{time_starttransfer}",',
    '"time_total":"%{time_total}",',
    '"remote_ip":"%{remote_ip}",',
    '"url_effective":"%{url_effective}",',
    '"num_redirects":"%{num_redirects}"',
    "}",
  ].join("");

  const args = [
    "-sS",
    "-L",
    "-D",
    "-",
    "-o",
    nullDevice(),
    "--max-time",
    String(timeoutSeconds),
    "-A",
    userAgent.value,
    "-w",
    `\n${metrics}\n`,
    check.url,
  ];
  const output = await runProcess(curlBin, args, timeoutSeconds * 1000 + 5000);
  return parseCurlDiagnostic({
    stdout: output.stdout,
    stderr: output.stderr,
    exitCode: output.exitCode,
    check,
    userAgent,
    attempt,
    resolver,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runProbeWithRetries({
  check,
  userAgent,
  maxAttempts = 2,
  backoffMs = [2000],
  onRetry,
  log,
}) {
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runCurlDiagnostic({ check, userAgent, attempt });
    attempts.push(result);
    if (result.ok) break;
    if (attempt < maxAttempts) {
      const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] || 0;
      if (log) log(`  retry ${check.name} ua=${userAgent.name} in ${delay}ms`);
      if (onRetry) await onRetry({ check, userAgent, attempt, delay });
      if (delay > 0) await sleep(delay);
    }
  }

  return {
    check,
    userAgent,
    attempts,
    final: attempts[attempts.length - 1],
  };
}

async function runProbeMatrix({
  checks = DEFAULT_CHECKS,
  userAgents = DEFAULT_USER_AGENTS,
  maxAttempts = 2,
  backoffMs = [2000],
  onRetry,
  log,
}) {
  const results = [];
  for (const check of checks) {
    for (const userAgent of userAgents) {
      const result = await runProbeWithRetries({
        check,
        userAgent,
        maxAttempts,
        backoffMs,
        onRetry,
        log,
      });
      results.push(result);
    }
  }
  return results;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    }),
  ]);
}

async function timeDns(label, fn) {
  const start = Date.now();
  try {
    const records = await withTimeout(fn(), 3000);
    return { resolver: label, ok: true, durationMs: Date.now() - start, records };
  } catch (error) {
    return {
      resolver: label,
      ok: false,
      durationMs: Date.now() - start,
      error: error.message,
    };
  }
}

async function diagnoseHostname(hostname) {
  const system = await timeDns("system", async () => {
    const records = await dns.promises.lookup(hostname, { all: true });
    return records.map((record) => record.address);
  });

  const resolver = new dns.promises.Resolver();
  resolver.setServers(["1.1.1.1"]);
  const cloudflare = await timeDns("1.1.1.1", async () => {
    const [v4, v6] = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    return [
      ...(v4.status === "fulfilled" ? v4.value : []),
      ...(v6.status === "fulfilled" ? v6.value : []),
    ];
  });

  return { hostname, system, cloudflare };
}

async function diagnoseDnsForChecks(checks = DEFAULT_CHECKS) {
  const hostnames = [...new Set(checks.map((check) => new URL(check.url).hostname))];
  const results = [];
  for (const hostname of hostnames) {
    results.push(await diagnoseHostname(hostname));
  }
  return results;
}

function formatDnsDiagnostic(entry) {
  const system = entry.system?.ok
    ? `${entry.system.resolver}=ok ${entry.system.durationMs}ms`
    : `${entry.system?.resolver || "system"}=fail ${entry.system?.durationMs || "n/a"}ms ${entry.system?.error || ""}`.trim();
  const cloudflare = entry.cloudflare?.ok
    ? `${entry.cloudflare.resolver}=ok ${entry.cloudflare.durationMs}ms`
    : `${entry.cloudflare?.resolver || "1.1.1.1"}=fail ${entry.cloudflare?.durationMs || "n/a"}ms ${
        entry.cloudflare?.error || ""
      }`.trim();
  return `${entry.hostname}: ${system}; ${cloudflare}`;
}

function buildAlertMessage({
  classification,
  urlSummaries,
  dnsDiagnostics,
  playwrightResult,
  totalMs,
}) {
  const lines = [
    `AIPickd availability monitor - ${classification.severity.toUpperCase()}`,
    `Total check time: ${totalMs}ms`,
    "",
    "Probable diagnosis:",
    ...classification.diagnoses.map((diagnosis) => `- ${diagnosis.text}`),
    "",
    "URL diagnostics:",
  ];

  for (const summary of urlSummaries) {
    const marker = summary.finalOk ? "OK" : "FAIL";
    const transient = summary.hadTransientFailure ? " transient-first-failure" : "";
    lines.push(`- ${summary.name}: ${marker}${transient}`);
    for (const result of summary.finalResults || []) {
      lines.push(`  ${formatDiagnosticLine(result)}`);
    }
  }

  if (dnsDiagnostics.length > 0) {
    lines.push("", "DNS diagnostics:");
    dnsDiagnostics.forEach((entry) => lines.push(`- ${formatDnsDiagnostic(entry)}`));
  }

  if (playwrightResult) {
    lines.push("", "Playwright:");
    lines.push(
      `- ok=${playwrightResult.ok} issues=${(playwrightResult.issues || []).join("; ") || "none"}`
    );
  }

  const message = lines.join("\n");
  return message.length > 3900 ? `${message.slice(0, 3860)}\n...truncated` : message;
}

function formatProbeConsole(summary) {
  const status = summary.finalOk ? "OK" : "FAIL";
  const attempts = summary.pairs
    .map((pair) => `${pair.userAgent.name}:${pair.attempts.length}x`)
    .join(" ");
  return `${status} ${summary.name} ${attempts}`;
}

module.exports = {
  DEFAULT_CHECKS,
  DEFAULT_USER_AGENTS,
  IMPORTANT_HEADERS,
  METRICS_MARKER,
  PLAYWRIGHT_USER_AGENT,
  buildAlertMessage,
  classifyIncident,
  diagnoseDnsForChecks,
  formatDiagnosticLine,
  formatDnsDiagnostic,
  formatProbeConsole,
  getCurlBin,
  ipVersion,
  parseCurlDiagnostic,
  runProbeMatrix,
  summarizeUrlResults,
};
