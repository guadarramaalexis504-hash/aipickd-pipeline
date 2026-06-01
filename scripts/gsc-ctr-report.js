#!/usr/bin/env node
/**
 * AIPickd — Google Search Console CTR opportunity report
 *
 * Pulls the last 28 days of Search Console data, matches each page to its
 * article, stores the metrics (gsc_impressions/clicks/ctr/position), and
 * surfaces the BIGGEST CTR opportunities: pages with many impressions but a
 * low click-through rate. Those are exactly where a better title/meta turns
 * existing visibility into clicks — the core "impressions but no clicks" fix.
 *
 * Auth: a Google service account with read access to the Search Console
 * property. No heavy SDK — signs an RS256 JWT with the built-in crypto module.
 *
 * Required env (see docs/GSC-SETUP.md):
 *   GOOGLE_SEARCH_CONSOLE_SITE   e.g. "https://aipickd.com/" or "sc-domain:aipickd.com"
 *   GOOGLE_SERVICE_ACCOUNT_JSON  the full service-account JSON (string), OR
 *   GOOGLE_APPLICATION_CREDENTIALS  a path to that JSON file
 *
 * Gracefully no-ops (exit 0) with setup instructions if creds are missing, so
 * it's safe to wire into a cron before you've finished the Google setup.
 *
 * Usage:
 *   node scripts/gsc-ctr-report.js                 # last 28 days
 *   node scripts/gsc-ctr-report.js --days 90
 *   node scripts/gsc-ctr-report.js --dry-run       # don't write metrics to Supabase
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

// CTR opportunity thresholds
const MIN_IMPRESSIONS = 20;   // ignore noise
const LOW_CTR = 0.015;        // < 1.5% with real impressions = opportunity

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
  try { return JSON.parse(raw); } catch (e) { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON"); }
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
  if (!res.ok || !data.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(data).slice(0, 200)}`);
  return data.access_token;
}

async function querySearchConsole(token, site, startDate, endDate) {
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ startDate, endDate, dimensions: ["page"], rowLimit: 5000 }),
  }, { timeout: 30000, retries: 2, allowedHosts: ["searchconsole.googleapis.com"] });
  const data = await res.json();
  if (!res.ok) throw new Error(`GSC query failed: ${JSON.stringify(data).slice(0, 250)}`);
  return data.rows || [];
}

async function supa(method, endpoint, body) {
  const res = await fetchWithRetry(`${env.SUPABASE_URL}/rest/v1/${endpoint}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  }, { timeout: 30000, retries: 3 });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supa ${endpoint}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const normUrl = (u) => (u || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/^www\./, "");
const isoDate = (d) => d.toISOString().slice(0, 10);

(async () => {
  const sa = loadServiceAccount();
  const site = env.GOOGLE_SEARCH_CONSOLE_SITE || process.env.GOOGLE_SEARCH_CONSOLE_SITE;

  if (!sa || !site) {
    console.log("\n⏭️  GSC report skipped — Google credentials not configured yet.");
    console.log("   Missing:" + (!sa ? " GOOGLE_SERVICE_ACCOUNT_JSON" : "") + (!site ? " GOOGLE_SEARCH_CONSOLE_SITE" : ""));
    console.log("   Setup guide: docs/GSC-SETUP.md  (≈10 min, then this runs automatically)\n");
    return; // exit 0 — safe no-op
  }

  console.log(`\n📊 GSC CTR report — last ${DAYS} days${DRY_RUN ? " [DRY RUN]" : ""}\n`);

  const token = await getAccessToken(sa);
  const end = new Date(Date.now() - 2 * 86400000);   // GSC data lags ~2 days
  const start = new Date(end.getTime() - DAYS * 86400000);
  const rows = await querySearchConsole(token, site, isoDate(start), isoDate(end));
  console.log(`   Pulled ${rows.length} page rows from Search Console.`);

  // Map article URLs → ids
  const articles = await supa("GET", "articles?select=id,title,wp_url,slug&wp_url=not.is.null&status=eq.published");
  const byUrl = new Map();
  for (const a of articles) {
    byUrl.set(normUrl(a.wp_url), a);
    if (a.slug) byUrl.set(normUrl(`https://aipickd.com/${a.slug}`), a);
  }

  let matched = 0;
  const opportunities = [];
  for (const r of rows) {
    const pageUrl = r.keys && r.keys[0];
    const a = byUrl.get(normUrl(pageUrl));
    if (!a) continue;
    matched++;
    const impressions = Math.round(r.impressions || 0);
    const clicks = Math.round(r.clicks || 0);
    const ctr = r.ctr || 0;
    const position = r.position || 0;

    if (!DRY_RUN) {
      await supa("PATCH", `articles?id=eq.${a.id}`, {
        gsc_impressions: impressions,
        gsc_clicks: clicks,
        gsc_ctr: Number(ctr.toFixed(4)),
        gsc_position: Number(position.toFixed(2)),
        gsc_updated_at: new Date().toISOString(),
      }).catch((e) => console.warn(`   patch ${a.id} failed: ${e.message.slice(0, 80)}`));
    }

    // Opportunity: real visibility, weak CTR (and not already top-CTR)
    if (impressions >= MIN_IMPRESSIONS && ctr < LOW_CTR) {
      opportunities.push({ title: a.title, url: pageUrl, impressions, clicks, ctr, position });
    }
  }

  opportunities.sort((x, y) => y.impressions - x.impressions);

  console.log(`   Matched ${matched}/${rows.length} rows to articles.`);
  console.log(`\n🎯 TOP CTR OPPORTUNITIES (high impressions, low CTR — fix titles/meta here first):\n`);
  const top = opportunities.slice(0, 15);
  if (top.length === 0) {
    console.log("   (none yet — either low traffic so far, or CTR already healthy)");
  } else {
    for (const o of top) {
      console.log(`   ${String(o.impressions).padStart(5)} impr · ${(o.ctr * 100).toFixed(1)}% CTR · pos ${o.position.toFixed(1)} — ${o.title.slice(0, 50)}`);
    }
  }

  // Discord summary
  if (!DRY_RUN && top.length > 0) {
    const lines = top.slice(0, 8).map((o) => `• ${o.impressions} impr · ${(o.ctr * 100).toFixed(1)}% CTR — ${o.title.slice(0, 45)}`).join("\n");
    await notify.notifyPipeline(
      `**GSC CTR report (${DAYS}d):** ${matched} pages tracked, ${opportunities.length} CTR opportunities.\nFix titles/meta on these first:\n${lines}`,
      {}
    ).catch(() => {});
  }

  console.log(`\n✅ Done. ${opportunities.length} opportunities flagged${DRY_RUN ? " (dry run — not stored)" : " (stored in articles.gsc_*)"}.\n`);
})().catch((e) => {
  console.error("❌ GSC report error:", e.message);
  process.exit(1);
});
