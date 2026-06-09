const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_USER_AGENTS,
  classifyIncident,
  formatDiagnosticLine,
  parseCurlDiagnostic,
} = require("../scripts/lib/availability-monitor");

test("default probes include Chrome and AIPickd monitor user agents", () => {
  const names = DEFAULT_USER_AGENTS.map((ua) => ua.name);

  assert.ok(names.includes("chrome"));
  assert.ok(names.includes("aipickd-monitor"));
});

test("parseCurlDiagnostic captures timings, IP family, final URL, and important headers", () => {
  const stdout = [
    "HTTP/1.1 301 Moved Permanently",
    "server: LiteSpeed",
    "location: https://aipickd.com/wp-sitemap.xml",
    "",
    "HTTP/2 200",
    "server: LiteSpeed",
    "x-litespeed-cache: hit",
    "cache-control: public,max-age=604800",
    "cf-ray: abc123-LAX",
    "",
    '__AIPICKD_CURL_METRICS__{"http_code":200,"time_namelookup":0.022,"time_connect":0.12,"time_appconnect":0.25,"time_starttransfer":0.36,"time_total":0.64,"remote_ip":"2a02:4780:2b:2019:0:fe9:e413:2","url_effective":"https://aipickd.com/wp-sitemap.xml","num_redirects":1}',
  ].join("\n");

  const result = parseCurlDiagnostic({
    stdout,
    stderr: "",
    exitCode: 0,
    check: { name: "Sitemap", url: "https://aipickd.com/sitemap.xml" },
    userAgent: { name: "chrome" },
    attempt: 1,
    resolver: "system",
  });

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.timings.dnsMs, 22);
  assert.equal(result.timings.connectMs, 120);
  assert.equal(result.timings.tlsMs, 250);
  assert.equal(result.timings.ttfbMs, 360);
  assert.equal(result.timings.totalMs, 640);
  assert.equal(result.ip, "2a02:4780:2b:2019:0:fe9:e413:2");
  assert.equal(result.ipVersion, "IPv6");
  assert.equal(result.finalUrl, "https://aipickd.com/wp-sitemap.xml");
  assert.deepEqual(result.headers, {
    "cache-control": "public,max-age=604800",
    "cf-ray": "abc123-LAX",
    server: "LiteSpeed",
    "x-litespeed-cache": "hit",
  });
});

test("formatDiagnosticLine includes the fields needed in incident alerts", () => {
  const line = formatDiagnosticLine({
    name: "Homepage",
    userAgentName: "aipickd-monitor",
    statusCode: 200,
    finalUrl: "https://aipickd.com/",
    ip: "82.29.157.177",
    ipVersion: "IPv4",
    resolver: "system",
    timings: { dnsMs: 21, connectMs: 119, tlsMs: 242, ttfbMs: 431, totalMs: 557 },
    headers: {
      server: "LiteSpeed",
      "x-litespeed-cache": "hit",
      "cache-control": "public,max-age=604800",
    },
  });

  assert.match(line, /Homepage/);
  assert.match(line, /ua=aipickd-monitor/);
  assert.match(line, /code=200/);
  assert.match(line, /dns=21ms/);
  assert.match(line, /connect=119ms/);
  assert.match(line, /tls=242ms/);
  assert.match(line, /ttfb=431ms/);
  assert.match(line, /total=557ms/);
  assert.match(line, /ip=82\.29\.157\.177/);
  assert.match(line, /family=IPv4/);
  assert.match(line, /resolver=system/);
  assert.match(line, /server=LiteSpeed/);
  assert.match(line, /x-litespeed-cache=hit/);
});

test("classifyIncident returns warning for a single first-attempt failure that recovers", () => {
  const classification = classifyIncident({
    urlSummaries: [
      {
        name: "Homepage",
        core: true,
        finalOk: true,
        hadTransientFailure: true,
        consecutiveFailures: 0,
      },
      {
        name: "About",
        core: true,
        finalOk: true,
        hadTransientFailure: false,
        consecutiveFailures: 0,
      },
    ],
    dnsDiagnostics: [],
    playwrightResult: { ok: true },
  });

  assert.equal(classification.severity, "warning");
  assert.ok(classification.diagnoses.some((d) => d.code === "transient_recovered"));
});

test("classifyIncident returns critical when a URL fails consecutive attempts", () => {
  const classification = classifyIncident({
    urlSummaries: [
      {
        name: "Homepage",
        core: true,
        finalOk: false,
        hadTransientFailure: false,
        consecutiveFailures: 2,
      },
      {
        name: "About",
        core: true,
        finalOk: true,
        hadTransientFailure: false,
        consecutiveFailures: 0,
      },
    ],
    dnsDiagnostics: [],
    playwrightResult: { ok: true },
  });

  assert.equal(classification.severity, "critical");
  assert.ok(classification.diagnoses.some((d) => d.code === "url_consecutive_failures"));
});

test("classifyIncident marks all core URL failures as probable hosting or network", () => {
  const classification = classifyIncident({
    urlSummaries: [
      { name: "Homepage", core: true, finalOk: false, consecutiveFailures: 2 },
      { name: "About", core: true, finalOk: false, consecutiveFailures: 2 },
      { name: "Sample article", core: true, finalOk: false, consecutiveFailures: 2 },
      { name: "Sitemap", core: true, finalOk: false, consecutiveFailures: 2 },
      { name: "WP REST", core: false, finalOk: false, consecutiveFailures: 2 },
    ],
    dnsDiagnostics: [],
    playwrightResult: { ok: true },
  });

  assert.equal(classification.severity, "critical");
  assert.ok(classification.diagnoses.some((d) => d.code === "hosting_or_network"));
});

test("classifyIncident marks Playwright-only failures as monitor, bot, or firewall", () => {
  const classification = classifyIncident({
    urlSummaries: [
      {
        name: "Homepage",
        core: true,
        finalOk: true,
        hadTransientFailure: false,
        consecutiveFailures: 0,
      },
      {
        name: "About",
        core: true,
        finalOk: true,
        hadTransientFailure: false,
        consecutiveFailures: 0,
      },
    ],
    dnsDiagnostics: [],
    playwrightResult: { ok: false, issues: ["Homepage: timeout"] },
  });

  assert.equal(classification.severity, "warning");
  assert.ok(classification.diagnoses.some((d) => d.code === "monitor_bot_firewall"));
});

test("classifyIncident marks system DNS failure with Cloudflare success as local runner DNS", () => {
  const classification = classifyIncident({
    urlSummaries: [
      {
        name: "Homepage",
        core: true,
        finalOk: true,
        hadTransientFailure: false,
        consecutiveFailures: 0,
      },
    ],
    dnsDiagnostics: [
      {
        hostname: "aipickd.com",
        system: { ok: false, resolver: "system", error: "ETIMEOUT" },
        cloudflare: { ok: true, resolver: "1.1.1.1", records: ["82.29.157.177"] },
      },
    ],
    playwrightResult: { ok: true },
  });

  assert.equal(classification.severity, "warning");
  assert.ok(classification.diagnoses.some((d) => d.code === "dns_local_runner"));
});
