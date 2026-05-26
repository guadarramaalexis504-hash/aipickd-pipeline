#!/usr/bin/env node
/**
 * AIPickd — Core Web Vitals tracker via Google CrUX API
 *
 * CrUX = Chrome User Experience Report. The same field data Google uses
 * for Page Experience ranking signals. Free API (just needs an API key
 * from Cloud Console). No quota issues at our volume.
 *
 * What we track (75th percentile, "75% of real users see X or better"):
 *   * LCP — Largest Contentful Paint    (pass <= 2500ms)
 *   * INP — Interaction to Next Paint   (pass <= 200ms)  ← replaced FID in 2024
 *   * CLS — Cumulative Layout Shift     (pass <= 0.10)
 *   * FCP, TTFB — informational, not ranking factors
 *
 * URL-level data requires ~28 days of traffic in Chrome — new articles
 * return "no data" for their first month. We log that as has_data=false
 * and skip the regression check for those rows.
 *
 * Usage:
 *   node scripts/check-cwv.js               # dry-run, top 20 articles
 *   node scripts/check-cwv.js --go          # write to DB + Discord alert on regressions
 *   node scripts/check-cwv.js --limit 50    # probe more URLs
 *   node scripts/check-cwv.js --url X       # probe one specific URL
 */

const { loadEnv } = require("./lib/env");
const { notifyAlert, notifyPipeline } = require("./notify.js");

const env = loadEnv();
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  CRUX_API_KEY,
} = env;

const args = process.argv.slice(2);
const DO_WRITE = args.includes("--go");
const LIMIT = parseInt(args[args.indexOf("--limit") + 1]) || 20;
const SINGLE_URL = args.includes("--url") ? args[args.indexOf("--url") + 1] : null;

if (!CRUX_API_KEY) {
  console.error("❌ Missing CRUX_API_KEY — set in Railway / GitHub Secrets");
  console.error("   Free at: https://console.cloud.google.com → APIs → Chrome UX Report API");
  process.exit(2);
}

const SUPA_HEADERS = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

// Pass thresholds per Google's Web Vitals rubric.
const THRESHOLDS = {
  lcp_p75_ms: { good: 2500, poor: 4000 },
  inp_p75_ms: { good: 200, poor: 500 },
  cls_p75:    { good: 0.10, poor: 0.25 },
};

async function supaGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: SUPA_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Supabase GET: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function supaInsert(path, rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`Supabase INSERT: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

/**
 * Query the CrUX API for one URL. Returns a flat object matching our
 * schema (lcp_p75_ms, cls_p75, *_good_pct, etc) or { has_data: false }
 * if CrUX has no data for that URL yet.
 */
async function fetchCrux(url, formFactor = "PHONE") {
  const res = await fetch(
    `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${CRUX_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        formFactor,
        metrics: [
          "largest_contentful_paint",
          "interaction_to_next_paint",
          "cumulative_layout_shift",
          "first_contentful_paint",
          "experimental_time_to_first_byte",
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    }
  );

  if (res.status === 404) return { url, form_factor: formFactor, has_data: false };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`CrUX ${res.status} for ${url}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const m = data.record?.metrics || {};

  // Extract p75 percentile and good/ni/poor distribution
  const p75 = (key) => m[key]?.percentiles?.p75 ?? null;
  const dist = (key) => {
    const histogram = m[key]?.histogram || [];
    return {
      good: histogram[0]?.density != null ? +(histogram[0].density * 100).toFixed(2) : null,
      ni:   histogram[1]?.density != null ? +(histogram[1].density * 100).toFixed(2) : null,
      poor: histogram[2]?.density != null ? +(histogram[2].density * 100).toFixed(2) : null,
    };
  };

  const lcp = dist("largest_contentful_paint");
  const inp = dist("interaction_to_next_paint");
  const cls = dist("cumulative_layout_shift");

  return {
    url,
    form_factor: formFactor,
    has_data: true,
    lcp_p75_ms:  p75("largest_contentful_paint"),
    inp_p75_ms:  p75("interaction_to_next_paint"),
    cls_p75:     p75("cumulative_layout_shift"),
    fcp_p75_ms:  p75("first_contentful_paint"),
    ttfb_p75_ms: p75("experimental_time_to_first_byte"),
    lcp_good_pct: lcp.good, lcp_ni_pct: lcp.ni, lcp_poor_pct: lcp.poor,
    inp_good_pct: inp.good, inp_ni_pct: inp.ni, inp_poor_pct: inp.poor,
    cls_good_pct: cls.good, cls_ni_pct: cls.ni, cls_poor_pct: cls.poor,
  };
}

function evaluateRow(row) {
  if (!row.has_data) return { status: "no-data" };
  const failures = [];
  if (row.lcp_p75_ms != null && row.lcp_p75_ms > THRESHOLDS.lcp_p75_ms.good) {
    failures.push(`LCP ${row.lcp_p75_ms}ms (target ≤2500)`);
  }
  if (row.inp_p75_ms != null && row.inp_p75_ms > THRESHOLDS.inp_p75_ms.good) {
    failures.push(`INP ${row.inp_p75_ms}ms (target ≤200)`);
  }
  if (row.cls_p75 != null && row.cls_p75 > THRESHOLDS.cls_p75.good) {
    failures.push(`CLS ${row.cls_p75} (target ≤0.10)`);
  }
  return { status: failures.length > 0 ? "fail" : "pass", failures };
}

async function pickUrls(limit) {
  if (SINGLE_URL) return [SINGLE_URL];
  // Top published articles by publication date (most-trafficked likely
  // candidates for having enough CrUX data).
  const articles = await supaGet(
    `articles?status=eq.published&order=published_at.desc&limit=${limit}&select=wp_url`
  );
  const urls = articles.map((a) => a.wp_url).filter((u) => u && u.startsWith("http"));
  // Always include the homepage
  if (!urls.includes("https://aipickd.com/")) urls.unshift("https://aipickd.com/");
  return urls.slice(0, limit);
}

(async () => {
  console.log(`\n📊 Core Web Vitals Probe (CrUX)\n`);
  console.log(`Mode: ${DO_WRITE ? "LIVE WRITE" : "DRY RUN"}`);

  const urls = await pickUrls(LIMIT);
  console.log(`Probing ${urls.length} URL(s)...\n`);

  const rows = [];
  let noDataCount = 0;
  let failCount = 0;
  const regressions = [];

  for (const [i, url] of urls.entries()) {
    process.stdout.write(`  [${i + 1}/${urls.length}] ${url.slice(0, 70)} `);
    try {
      const row = await fetchCrux(url, "PHONE");
      rows.push(row);
      const ev = evaluateRow(row);
      if (ev.status === "no-data") {
        noDataCount++;
        console.log(`⏳ no data (URL too new for CrUX)`);
      } else if (ev.status === "fail") {
        failCount++;
        console.log(`🔴 fail: ${ev.failures.join(", ")}`);
        regressions.push({ url, failures: ev.failures });
      } else {
        console.log(`✅ pass`);
      }
      // Polite throttle
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      console.log(`⚠️  error: ${e.message.slice(0, 80)}`);
    }
  }

  console.log(`\n📋 Summary:`);
  console.log(`  URLs probed:   ${urls.length}`);
  console.log(`  Passing:       ${urls.length - failCount - noDataCount}`);
  console.log(`  Failing CWV:   ${failCount}`);
  console.log(`  No data yet:   ${noDataCount}`);

  if (DO_WRITE && rows.length > 0) {
    await supaInsert("cwv_history", rows);
    console.log(`\n💾 Inserted ${rows.length} rows into cwv_history`);

    if (regressions.length > 0) {
      const lines = regressions.slice(0, 10).map((r) => `• ${r.url.slice(0, 80)} — ${r.failures.join(", ")}`);
      await notifyAlert(
        `📉 **Core Web Vitals — ${regressions.length} URL(s) failing**\n\n` +
        lines.join("\n") +
        (regressions.length > 10 ? `\n+ ${regressions.length - 10} more` : "") +
        `\n\nThresholds: LCP ≤ 2500ms, INP ≤ 200ms, CLS ≤ 0.10. Google uses these as ranking signals.`,
        "warning"
      ).catch(() => {});
    } else if (failCount === 0 && rows.length > 0) {
      await notifyPipeline(
        `📊 **CWV Probe — All ${urls.length - noDataCount} URLs passing**\n` +
        `(${noDataCount} URLs too new for CrUX data yet — that's normal for the first 28 days.)`
      ).catch(() => {});
    }
  } else if (!DO_WRITE) {
    console.log(`\n💡 Dry run — pass --go to write results to DB and notify Discord on regressions.`);
  }
})().catch((e) => {
  console.error(`❌ FATAL: ${e.message}`);
  notifyAlert(`check-cwv.js failed: ${e.message.slice(0, 200)}`, "warning").catch(() => {});
  process.exit(1);
});
