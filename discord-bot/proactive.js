/**
 * AIPickd Discord Bot — Proactive monitoring
 *
 * Before this module, the bot was purely reactive: it only spoke when
 * spoken to. That meant slowly-developing issues (cost creep, pipeline
 * idle for hours, queue draining) only surfaced when Alexis asked, by
 * which point the problem had been compounding.
 *
 * This adds a self-driven check loop. Every CHECK_INTERVAL_MS the bot
 * inspects a handful of metrics and posts a single concise heads-up
 * if any cross a threshold. Each alert type has its own dedup window
 * so we don't repeat the same warning every hour — once is enough
 * until the condition clears or escalates.
 *
 * The intent is feel-like-a-cofounder, not pager-storm: thresholds
 * are conservative and we err on the side of silence.
 */

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // every hour
const DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h between same alert

// Keyed by alert type → last-sent timestamp. In memory only; on Railway
// restart we start fresh which is fine — better to over-alert once on
// boot than miss a real problem.
const lastSent = new Map();

function shouldAlert(key) {
  const now = Date.now();
  const prev = lastSent.get(key);
  if (prev && now - prev < DEDUP_WINDOW_MS) return false;
  lastSent.set(key, now);
  return true;
}

/**
 * Run the full check sweep. Returns an array of alert strings to post.
 * Pure-ish: only reads from the supabase helpers passed in, doesn't
 * post to Discord itself — the caller decides where to send.
 */
async function runChecks({ getStats, getPipelineHealth, getMonthlyCost }) {
  const alerts = [];

  // 1. Monthly cost — heads-up at 65%, warning at 85%, critical at 95%
  try {
    const cost = await getMonthlyCost();
    const pct = parseFloat((cost.pct_used || "0").replace("%", ""));
    if (pct >= 95 && shouldAlert("cost-95")) {
      alerts.push({
        severity: "critical",
        text: `🚨 **Monthly budget at ${pct.toFixed(1)}%** — $${cost.spent_usd} / $${cost.budget_usd}.\nProjected EOM: $${cost.projected_month_usd}. Pipeline may auto-stop at 100%.`,
      });
    } else if (pct >= 85 && shouldAlert("cost-85")) {
      alerts.push({
        severity: "warning",
        text: `🟠 **Monthly cost at ${pct.toFixed(1)}%** — $${cost.spent_usd} / $${cost.budget_usd}.\nProjected EOM: $${cost.projected_month_usd}. Consider reducing gen volume.`,
      });
    } else if (pct >= 65 && shouldAlert("cost-65")) {
      alerts.push({
        severity: "info",
        text: `🟡 Cost MTD ${pct.toFixed(1)}% ($${cost.spent_usd} / $${cost.budget_usd}). On track but worth a glance — projected EOM $${cost.projected_month_usd}.`,
      });
    }
  } catch (e) {
    console.error("[proactive] cost check failed:", e.message);
  }

  // 2. Pipeline idle — alert if >8h since last publish (cron is every 4h,
  // so 8h means 2 cron runs failed silently). Skip if pipeline_paused.
  try {
    const health = await getPipelineHealth();
    const hoursSince = parseFloat(health.hours_since_last_pub);
    const isPaused = (health.status || "").includes("PAUSADO") || health.paused === true;
    if (!isPaused && hoursSince > 8 && shouldAlert("idle-8h")) {
      alerts.push({
        severity: "warning",
        text: `⏰ **No publish in ${hoursSince}h** — el cron es cada 4h. Last published: "${(health.last_published_title || "—").slice(0, 60)}".\nUse \`/runs\` para ver el último workflow run.`,
      });
    }
    // QA failed accumulation
    if (health.qa_failed_count >= 10 && shouldAlert("qa-fail-10")) {
      alerts.push({
        severity: "warning",
        text: `📉 **${health.qa_failed_count} articulos en qa_failed** — el prompt podría necesitar ajuste, o requeue manual.\nSlice: ${(health.qa_failed_articles || []).slice(0, 3).join(", ")}`,
      });
    }
    // Draft backlog
    if (health.drafts_ready_to_publish >= 5 && shouldAlert("draft-backlog")) {
      alerts.push({
        severity: "info",
        text: `📌 **${health.drafts_ready_to_publish} drafts pendientes de publicar** — el publish path puede estar atascado. Check con \`/audit\` o el siguiente cron debería procesarlos.`,
      });
    }
  } catch (e) {
    console.error("[proactive] health check failed:", e.message);
  }

  // 3. Keyword queue low (so we don't run dry)
  try {
    const stats = await getStats();
    if (stats.keywords_in_queue != null && stats.keywords_in_queue < 20 && shouldAlert("kw-low")) {
      alerts.push({
        severity: "info",
        text: `📋 **Keyword queue low: ${stats.keywords_in_queue}** — auto-keywords workflow corre weekly, pero podemos disparar manual si urge. Usa \`/dispatch_workflow auto-keywords.yml\` (desde @mención).`,
      });
    }
  } catch (e) {
    console.error("[proactive] stats check failed:", e.message);
  }

  return alerts;
}

/**
 * Start the periodic check loop. Caller provides the Supabase helpers
 * and a sendAlert callback that knows how to deliver each alert
 * (typically posting to a Discord channel or DM).
 */
function startProactive({ getStats, getPipelineHealth, getMonthlyCost, sendAlert, intervalMs }) {
  const interval = intervalMs || CHECK_INTERVAL_MS;

  const tick = async () => {
    try {
      const alerts = await runChecks({ getStats, getPipelineHealth, getMonthlyCost });
      for (const a of alerts) {
        try {
          await sendAlert(a);
        } catch (e) {
          console.error("[proactive] sendAlert failed:", e.message);
        }
      }
      if (alerts.length > 0) {
        console.log(`[proactive] sent ${alerts.length} alert(s)`);
      }
    } catch (e) {
      console.error("[proactive] tick failed:", e.message);
    }
  };

  // Run once on startup AFTER a short delay so we don't slam Discord
  // during boot, then on the interval.
  setTimeout(tick, 30_000);
  return setInterval(tick, interval);
}

/**
 * Test helper — clears the dedup map so each test starts from a clean
 * slate. Not used in prod code paths.
 */
function _resetDedupForTesting() {
  lastSent.clear();
}

module.exports = {
  startProactive,
  runChecks, // exported for testability
  CHECK_INTERVAL_MS,
  DEDUP_WINDOW_MS,
  _resetDedupForTesting,
};
