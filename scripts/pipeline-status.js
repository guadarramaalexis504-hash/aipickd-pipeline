#!/usr/bin/env node
/**
 * AIPickd — Pipeline health snapshot
 *
 * Prints a compact table of the current state of the pipeline. Use:
 *   - Locally:           node scripts/pipeline-status.js
 *   - To post to Discord: node scripts/pipeline-status.js --notify
 *
 * Output (one shot, no streaming):
 *   - Drafts pending publish (count + ages)
 *   - qa_failed (count + last 24h)
 *   - in_progress keywords (orphans?)
 *   - Last published article (timestamp + title)
 *   - Keywords by status (queued / in_progress / published)
 *   - Hours since last successful publish
 *   - Today's cost (sum of generation_cost_usd for today)
 *
 * Pure read-only — never mutates Supabase. Safe to run frequently.
 */

const { loadEnv } = require("./lib/env");
const { notifyPipeline } = require("./notify.js");

const env = loadEnv();
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

const HEADERS = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
};

const args = process.argv.slice(2);
const NOTIFY = args.includes("--notify");
const JSON_OUT = args.includes("--json");

async function supaGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Supabase GET ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function hoursSince(iso) {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}
function fmtHours(h) {
  if (h == null) return "—";
  if (h < 1) return `${(h * 60).toFixed(0)}m`;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const since24h = new Date(Date.now() - 24 * 3600000).toISOString();

  // Run all queries in parallel for speed
  const [
    drafts,
    qaFailed,
    qaFailed24h,
    keywords,
    lastPublished,
    today24hPublished,
    todayCost,
  ] = await Promise.all([
    supaGet("articles?status=eq.draft&wp_post_id=is.null&order=created_at.asc&select=id,title,created_at"),
    supaGet("articles?status=eq.qa_failed&select=id"),
    supaGet(`articles?status=eq.qa_failed&created_at=gte.${since24h}&select=id`),
    supaGet("keywords?select=status"),
    supaGet("articles?status=eq.published&order=published_at.desc&limit=1&select=title,published_at,wp_url"),
    supaGet(`articles?status=eq.published&published_at=gte.${since24h}&select=id`),
    supaGet(`articles?created_at=gte.${today}&select=generation_cost_usd`),
  ]);

  const kwCounts = keywords.reduce((acc, k) => {
    acc[k.status] = (acc[k.status] || 0) + 1;
    return acc;
  }, {});

  const last = lastPublished[0] || null;
  const hSinceLastPub = last ? hoursSince(last.published_at) : null;
  const costToday = (todayCost || []).reduce((s, a) => s + (parseFloat(a.generation_cost_usd) || 0), 0);
  const stuckDrafts = drafts.filter((d) => hoursSince(d.created_at) > 24).length;

  const lines = [];
  lines.push(`AIPickd Pipeline — Snapshot @ ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`);
  lines.push("─".repeat(64));
  lines.push(`Drafts pending publish     ${drafts.length}${stuckDrafts > 0 ? ` (${stuckDrafts} stuck >24h)` : ""}`);
  lines.push(`qa_failed total            ${qaFailed.length}`);
  lines.push(`qa_failed (last 24h)       ${qaFailed24h.length}`);
  lines.push(`Keywords queued            ${kwCounts.queued || 0}`);
  lines.push(`Keywords in_progress       ${kwCounts.in_progress || 0}${kwCounts.in_progress ? " ⚠️  (orphans?)" : ""}`);
  lines.push(`Keywords published         ${kwCounts.published || 0}`);
  lines.push(`Published (last 24h)       ${today24hPublished.length}`);
  lines.push(`Last published             ${last ? fmtHours(hSinceLastPub) + " ago — " + (last.title?.slice(0, 50) || "—") : "—"}`);
  lines.push(`Cost today                 $${costToday.toFixed(4)}`);

  const flags = [];
  if (drafts.length > 5) flags.push(`📌 ${drafts.length} drafts pending — publish path may be broken`);
  if (stuckDrafts > 0) flags.push(`🗄️  ${stuckDrafts} drafts stuck >24h — auto-archive in next publish run`);
  if (hSinceLastPub != null && hSinceLastPub > 12) flags.push(`⏰ ${fmtHours(hSinceLastPub)} since last publish — check cron`);
  if ((kwCounts.queued || 0) < 30) flags.push(`📋 keyword queue low (${kwCounts.queued || 0}) — refill soon`);
  if ((kwCounts.in_progress || 0) > 0) flags.push(`🔓 ${kwCounts.in_progress} keyword(s) orphan — next run will unstick`);
  if (qaFailed24h.length > 5) flags.push(`🚫 ${qaFailed24h.length} qa_failed in 24h — prompt may need a fix`);

  if (flags.length > 0) {
    lines.push("");
    lines.push("Flags:");
    flags.forEach((f) => lines.push("  " + f));
  } else {
    lines.push("");
    lines.push("All systems nominal ✅");
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      drafts_pending: drafts.length,
      drafts_stuck_24h: stuckDrafts,
      qa_failed_total: qaFailed.length,
      qa_failed_24h: qaFailed24h.length,
      keywords: kwCounts,
      published_24h: today24hPublished.length,
      hours_since_last_publish: hSinceLastPub,
      cost_today_usd: Number(costToday.toFixed(4)),
      flags,
    }, null, 2));
  } else {
    console.log(lines.join("\n"));
  }

  if (NOTIFY) {
    const status = flags.length === 0 ? "✅ Healthy" : `⚠️ ${flags.length} flag(s)`;
    const body = "```\n" + lines.join("\n") + "\n```";
    await notifyPipeline(`📊 **Pipeline Status — ${status}**\n${body}`, {
      articlesGenerated: 0,
      keywordsRemaining: kwCounts.queued || 0,
    }).catch((e) => console.error("notify failed:", e.message));
  }
})().catch((e) => {
  console.error("❌ FATAL:", e.message);
  process.exit(1);
});
