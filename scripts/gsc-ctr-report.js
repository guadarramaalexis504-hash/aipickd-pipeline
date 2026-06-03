#!/usr/bin/env node
/**
 * AIPickd - Google Search Console CTR opportunity report
 *
 * Pulls Search Console data, matches each page to its article, stores article
 * summary metrics in articles.gsc_*, stores detail rows by page/query/device/
 * date, and surfaces the biggest CTR opportunities.
 *
 * Required env (see docs/GSC-SETUP.md):
 *   GOOGLE_SEARCH_CONSOLE_SITE      e.g. "https://aipickd.com/" or "sc-domain:aipickd.com"
 *   GOOGLE_SERVICE_ACCOUNT_JSON     full service-account JSON string, OR
 *   GOOGLE_APPLICATION_CREDENTIALS  path to that JSON file
 *
 * Usage:
 *   node scripts/gsc-ctr-report.js
 *   node scripts/gsc-ctr-report.js --days 90
 *   node scripts/gsc-ctr-report.js --dry-run
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const { loadEnv } = require("./lib/env");
const { fetchWithRetry } = require("./lib/http");

let notify = { notifyPipeline: async () => {}, notifyAlert: async () => {} };
try { notify = require("./notify"); } catch (_) {}

const env = loadEnv();
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const daysIdx = argv.indexOf("--days");
const DAYS = daysIdx >= 0 ? Math.max(1, parseInt(argv[daysIdx + 1], 10) || 28) : 28;

const MIN_IMPRESSIONS = 20;
const LOW_CTR = 0.015;
const PAGE_DIMENSIONS = ["page"];
const DETAIL_DIMENSIONS = ["page", "query", "device", "date"];
const SEARCH_TYPE = "web";
const ROW_LIMIT = Math.max(1, parseInt(env.GSC_ROW_LIMIT || process.env.GSC_ROW_LIMIT || "25000", 10) || 25000);

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function loadServiceAccount() {
  let raw = env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    const path = env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (path && fs.existsSync(path)) raw = fs.readFileSync(path, "utf8");
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const signature = b64url(signer.sign(sa.private_key));
  const jwt = `${header}.${claim}.${signature}`;

  const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  }, { timeout: 20000, retries: 2, allowedHosts: ["oauth2.googleapis.com"] });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Token exchange failed: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.access_token;
}

async function querySearchConsole(token, site, startDate, endDate, dimensions = PAGE_DIMENSIONS) {
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ startDate, endDate, dimensions, rowLimit: ROW_LIMIT }),
  }, { timeout: 30000, retries: 2, allowedHosts: ["searchconsole.googleapis.com"] });
  const data = await res.json();
  if (!res.ok) throw new Error(`GSC query failed: ${JSON.stringify(data).slice(0, 250)}`);
  return data.rows || [];
}

async function supa(method, endpoint, body, opts = {}) {
  const res = await fetchWithRetry(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: opts.prefer || "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  }, { timeout: opts.timeout || 30000, retries: opts.retries ?? 3 });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supa ${endpoint}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const normUrl = (u) => (u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/^www\./, "");
const isoDate = (d) => d.toISOString().slice(0, 10);

function buildArticleUrlMap(articles) {
  const byUrl = new Map();
  for (const a of articles || []) {
    if (a.wp_url) byUrl.set(normUrl(a.wp_url), a);
    if (a.slug) byUrl.set(normUrl(`https://aipickd.com/${a.slug}`), a);
  }
  return byUrl;
}

function rowMetric(row) {
  return {
    impressions: Math.round(row.impressions || 0),
    clicks: Math.round(row.clicks || 0),
    ctr: Number((row.ctr || 0).toFixed(4)),
    position: Number((row.position || 0).toFixed(2)),
  };
}

function toArticleMetricUpdates(pageRows, byUrl, updatedAt) {
  const updates = [];
  for (const r of pageRows || []) {
    const pageUrl = r.keys && r.keys[0];
    const article = byUrl.get(normUrl(pageUrl));
    if (!article) continue;
    updates.push({
      article,
      pageUrl,
      ...rowMetric(r),
      gsc_updated_at: updatedAt,
    });
  }
  return updates;
}

function toGscDetailRows(rows, byUrl, opts) {
  return (rows || []).map((r) => {
    const keys = r.keys || [];
    const pageUrl = keys[0] || "";
    const normalizedPageUrl = normUrl(pageUrl);
    const article = byUrl.get(normalizedPageUrl);
    return {
      import_run_id: opts.importRunId,
      article_id: article ? article.id : null,
      page_url: pageUrl,
      normalized_page_url: normalizedPageUrl,
      query: keys[1] || "",
      device: keys[2] || "",
      row_date: keys[3] || null,
      search_type: SEARCH_TYPE,
      start_date: opts.startDate,
      end_date: opts.endDate,
      imported_at: opts.importedAt,
      ...rowMetric(r),
    };
  });
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function insertDetailRows(rows) {
  for (const batch of chunk(rows, 100)) {
    await supa("POST", "gsc_query_metrics", batch, { prefer: "return=minimal" });
  }
}

async function main() {
  const sa = loadServiceAccount();
  const site = env.GOOGLE_SEARCH_CONSOLE_SITE || process.env.GOOGLE_SEARCH_CONSOLE_SITE;

  if (!sa || !site) {
    console.log("\nGSC report skipped - Google credentials not configured yet.");
    console.log("   Missing:" + (!sa ? " GOOGLE_SERVICE_ACCOUNT_JSON" : "") + (!site ? " GOOGLE_SEARCH_CONSOLE_SITE" : ""));
    console.log("   Setup guide: docs/GSC-SETUP.md\n");
    return;
  }

  console.log(`\nGSC CTR report - last ${DAYS} days${DRY_RUN ? " [DRY RUN]" : ""}\n`);

  const token = await getAccessToken(sa);
  const end = new Date(Date.now() - 2 * 86400000);
  const start = new Date(end.getTime() - (DAYS - 1) * 86400000);
  const startDate = isoDate(start);
  const endDate = isoDate(end);
  const importedAt = new Date().toISOString();

  const rows = await querySearchConsole(token, site, startDate, endDate, PAGE_DIMENSIONS);
  const detailRowsRaw = await querySearchConsole(token, site, startDate, endDate, DETAIL_DIMENSIONS);
  console.log(`   Pulled ${rows.length} page rows and ${detailRowsRaw.length} query/device rows from Search Console.`);

  const articles = await supa("GET", "articles?select=id,title,wp_url,slug&wp_url=not.is.null&status=eq.published");
  const byUrl = buildArticleUrlMap(articles);
  const importRunId = crypto.randomUUID();
  const detailRows = toGscDetailRows(detailRowsRaw, byUrl, {
    importRunId,
    startDate,
    endDate,
    importedAt,
  });
  const matchedDetail = detailRows.filter((r) => r.article_id).length;

  const updates = toArticleMetricUpdates(rows, byUrl, importedAt);
  const opportunities = [];
  for (const update of updates) {
    const { article, pageUrl, impressions, clicks, ctr, position } = update;

    if (!DRY_RUN) {
      await supa("PATCH", `articles?id=eq.${article.id}`, {
        gsc_impressions: impressions,
        gsc_clicks: clicks,
        gsc_ctr: ctr,
        gsc_position: position,
        gsc_updated_at: update.gsc_updated_at,
      }).catch((e) => console.warn(`   patch ${article.id} failed: ${e.message.slice(0, 80)}`));
    }

    if (impressions >= MIN_IMPRESSIONS && ctr < LOW_CTR) {
      opportunities.push({ title: article.title, url: pageUrl, impressions, clicks, ctr, position });
    }
  }

  if (!DRY_RUN) {
    await supa("POST", "gsc_import_runs", {
      id: importRunId,
      property_url: site,
      start_date: startDate,
      end_date: endDate,
      dimensions: DETAIL_DIMENSIONS,
      search_type: SEARCH_TYPE,
      rows_fetched: detailRows.length,
      rows_matched: matchedDetail,
      rows_unmatched: detailRows.length - matchedDetail,
      notes: `Imported by gsc-ctr-report.js (${DAYS}d window).`,
    }, { prefer: "return=minimal" });
    await insertDetailRows(detailRows);
  }

  opportunities.sort((x, y) => y.impressions - x.impressions);

  const unmatched = detailRows.length - matchedDetail;
  console.log(`   Matched ${updates.length}/${rows.length} page rows to articles.`);
  console.log(`   ${DRY_RUN ? "Would store" : "Stored"} ${detailRows.length} detail rows (${matchedDetail} matched, ${unmatched} unmatched).`);
  if (unmatched > 0) {
    const examples = detailRows.filter((r) => !r.article_id).slice(0, 5).map((r) => r.page_url).join(", ");
    if (examples) console.log(`   Unmatched examples: ${examples}`);
  }

  console.log("\nTOP CTR OPPORTUNITIES (high impressions, low CTR - fix titles/meta here first):\n");
  const top = opportunities.slice(0, 15);
  if (top.length === 0) {
    console.log("   (none yet - either low traffic so far, or CTR already healthy)");
  } else {
    for (const o of top) {
      console.log(`   ${String(o.impressions).padStart(5)} impr - ${(o.ctr * 100).toFixed(1)}% CTR - pos ${o.position.toFixed(1)} - ${o.title.slice(0, 50)}`);
    }
  }

  if (!DRY_RUN && top.length > 0) {
    const lines = top.slice(0, 8)
      .map((o) => `- ${o.impressions} impr - ${(o.ctr * 100).toFixed(1)}% CTR - ${o.title.slice(0, 45)}`)
      .join("\n");
    await notify.notifyPipeline(
      `**GSC CTR report (${DAYS}d):** ${updates.length} pages tracked, ${detailRows.length} query/device rows, ${opportunities.length} CTR opportunities.\nFix titles/meta on these first:\n${lines}`,
      {}
    ).catch(() => {});
  }

  console.log(`\nDone. ${opportunities.length} opportunities flagged${DRY_RUN ? " (dry run - not stored)" : " (stored in articles.gsc_* and gsc_query_metrics)"}.\n`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("GSC report error:", e.message);
    process.exit(1);
  });
}

module.exports = {
  buildArticleUrlMap,
  chunk,
  normUrl,
  rowMetric,
  toArticleMetricUpdates,
  toGscDetailRows,
};
