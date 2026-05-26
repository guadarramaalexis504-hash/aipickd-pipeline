#!/usr/bin/env node
/**
 * AIPickd — Discord pinned dashboard updater
 *
 * Maintains a single Discord message in #pipeline-status (or whatever
 * channel DISCORD_DASHBOARD_WEBHOOK_URL points to) that gets EDITED
 * every run instead of posted fresh. The result: one always-current
 * status snapshot at the top of the channel, no scroll archaeology.
 *
 * On first run we create the message and store its ID. Subsequent
 * runs PATCH the same message. Discord webhooks support edit via
 * PATCH /webhooks/{id}/{token}/messages/{message_id}, so no bot token
 * is needed — the existing DISCORD_WEBHOOK_PIPELINE secret works.
 *
 * State persistence: we store the message_id in pipeline_config table
 * (column dashboard_message_id) so it survives across runs and
 * Railway redeploys.
 *
 * Usage:
 *   node scripts/update-dashboard.js          # create or edit existing
 *   node scripts/update-dashboard.js --reset  # forget message_id, post fresh
 *
 * Env vars required:
 *   DISCORD_WEBHOOK_PIPELINE  (or DISCORD_DASHBOARD_WEBHOOK_URL override)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const { loadEnv } = require("./lib/env");

const env = loadEnv();
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  DISCORD_WEBHOOK_PIPELINE,
  DISCORD_DASHBOARD_WEBHOOK_URL,
} = env;

const args = process.argv.slice(2);
const RESET = args.includes("--reset");

const WEBHOOK = DISCORD_DASHBOARD_WEBHOOK_URL || DISCORD_WEBHOOK_PIPELINE;
if (!WEBHOOK) {
  console.error("❌ Missing DISCORD_WEBHOOK_PIPELINE (or DISCORD_DASHBOARD_WEBHOOK_URL)");
  process.exit(2);
}

const SUPA_HEADERS = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

const CONFIG_ROW_ID = "00000000-0000-0000-0000-000000000001";

async function supaGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: SUPA_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Supabase GET: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function supaPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...SUPA_HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Supabase PATCH: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

function progressBar(pct, blocks = 10) {
  const filled = Math.max(0, Math.min(blocks, Math.round((pct / 100) * blocks)));
  return "█".repeat(filled) + "░".repeat(blocks - filled);
}

function fmtHours(h) {
  if (h == null || isNaN(h)) return "—";
  if (h < 1) return `${(h * 60).toFixed(0)}m`;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/**
 * Gather all the data the dashboard needs in parallel — single point
 * of truth so the snapshot is internally consistent.
 */
async function gatherStats() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const since24h = new Date(now - 24 * 3600 * 1000).toISOString();
  const since7d  = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [
    drafts,
    qaFailed24h,
    keywords,
    lastPub,
    pub24h,
    pub7d,
    monthArticles,
    pauseRow,
    lastRunFromGsc,
  ] = await Promise.all([
    supaGet("articles?status=eq.draft&wp_post_id=is.null&select=id,created_at"),
    supaGet(`articles?status=eq.qa_failed&created_at=gte.${since24h}&select=id`),
    supaGet("keywords?select=status"),
    supaGet("articles?status=eq.published&order=published_at.desc&limit=1&select=title,published_at,wp_url"),
    supaGet(`articles?status=eq.published&published_at=gte.${since24h}&select=id,generation_cost_usd`),
    supaGet(`articles?status=eq.published&published_at=gte.${since7d}&select=id`),
    supaGet(`articles?status=eq.published&published_at=gte.${monthStart}&select=generation_cost_usd`),
    supaGet(`pipeline_config?id=eq.${CONFIG_ROW_ID}&select=paused,paused_reason,dashboard_message_id`).catch(() => [{}]),
    Promise.resolve(null), // placeholder for future GSC integration
  ]);

  const kwCounts = keywords.reduce((acc, k) => {
    acc[k.status] = (acc[k.status] || 0) + 1;
    return acc;
  }, {});

  const last = lastPub[0] || null;
  const hSinceLast = last?.published_at
    ? (Date.now() - new Date(last.published_at).getTime()) / 3600000
    : null;

  const stuckDrafts = drafts.filter(
    (d) => (Date.now() - new Date(d.created_at).getTime()) / 3600000 > 24
  ).length;

  const cost24h  = pub24h.reduce((s, a) => s + parseFloat(a.generation_cost_usd || 0), 0);
  const costMTD  = monthArticles.reduce((s, a) => s + parseFloat(a.generation_cost_usd || 0), 0);
  const budget   = 50; // matches MONTHLY_BUDGET cap in cost-monitor.js

  return {
    now,
    today,
    paused: pauseRow[0]?.paused === true,
    paused_reason: pauseRow[0]?.paused_reason || null,
    dashboard_message_id: pauseRow[0]?.dashboard_message_id || null,
    drafts_pending: drafts.length,
    drafts_stuck: stuckDrafts,
    qa_failed_24h: qaFailed24h.length,
    keywords_queued: kwCounts.queued || 0,
    keywords_in_progress: kwCounts.in_progress || 0,
    last_published_title: last?.title || null,
    last_published_url: last?.wp_url || null,
    hours_since_last: hSinceLast,
    pub_24h: pub24h.length,
    pub_7d: pub7d.length,
    cost_24h: cost24h,
    cost_mtd: costMTD,
    budget,
    budget_pct: (costMTD / budget) * 100,
  };
}

function formatDashboard(s) {
  const healthEmoji = s.paused
    ? "⏸"
    : (s.hours_since_last != null && s.hours_since_last > 8) || s.drafts_stuck > 0
      ? "🟡"
      : "🟢";

  const healthLabel = s.paused
    ? `PAUSED${s.paused_reason ? ` — ${s.paused_reason.slice(0, 50)}` : ""}`
    : healthEmoji === "🟡"
      ? "Degraded"
      : "Healthy";

  const lastPubLine = s.last_published_url
    ? `[${(s.last_published_title || "—").slice(0, 60)}](${s.last_published_url})`
    : "—";

  const lines = [
    `🚦 **AIPickd Pipeline Status** — Updated ${s.now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `**Health:**      ${healthEmoji} ${healthLabel}`,
    `**Articles:**    ${s.pub_24h} (24h) · ${s.pub_7d} (7d)`,
    `**Drafts:**      ${s.drafts_pending} pending${s.drafts_stuck > 0 ? ` ⚠️ ${s.drafts_stuck} stuck >24h` : ""}`,
    `**QA failed:**   ${s.qa_failed_24h} (last 24h)`,
    `**Keywords:**    ${s.keywords_queued} queued${s.keywords_in_progress ? ` · ${s.keywords_in_progress} in progress` : ""}`,
    `**Last publish:** ${fmtHours(s.hours_since_last)} ago — ${lastPubLine}`,
    `**Cost MTD:**    $${s.cost_mtd.toFixed(2)} / $${s.budget} (${s.budget_pct.toFixed(1)}%)`,
    `\`${progressBar(s.budget_pct)}\``,
    `**Cost 24h:**    $${s.cost_24h.toFixed(3)}`,
    "",
    `_Auto-updated hourly · use /status from anywhere for an on-demand snapshot._`,
  ];
  return lines.join("\n");
}

async function postMessage(content) {
  // POST with ?wait=true so Discord returns the created message ID
  const r = await fetch(`${WEBHOOK}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Discord POST: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json(); // includes .id
}

async function editMessage(messageId, content) {
  const r = await fetch(`${WEBHOOK}/messages/${messageId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 404) return { notFound: true };
  if (!r.ok) throw new Error(`Discord PATCH: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

(async () => {
  console.log("📊 update-dashboard\n");

  const s = await gatherStats();
  const content = formatDashboard(s);
  console.log(content);
  console.log("");

  let messageId = RESET ? null : s.dashboard_message_id;

  if (messageId) {
    console.log(`🔄 Editing existing message ${messageId}...`);
    const r = await editMessage(messageId, content);
    if (r.notFound) {
      console.log(`   Message ${messageId} not found — recreating`);
      messageId = null;
    } else {
      console.log(`   ✅ Edited`);
    }
  }

  if (!messageId) {
    console.log(`✏️  Posting fresh dashboard message...`);
    const r = await postMessage(content);
    messageId = r.id;
    console.log(`   ✅ Posted as ${messageId}`);
    await supaPatch(`pipeline_config?id=eq.${CONFIG_ROW_ID}`, {
      dashboard_message_id: messageId,
    });
    console.log(`   💾 Saved message_id to pipeline_config`);
  }
})().catch((e) => {
  console.error(`❌ FATAL: ${e.message}`);
  process.exit(1);
});
