/**
 * SLO (Service Level Objective) tracker.
 *
 * Computes pipeline reliability metrics over the last 30 days using
 * GitHub Actions API + Supabase. Targets:
 *   - generate.yml success rate ≥ 95%
 *   - mean time between successful runs ≤ 5h (target schedule = 4h)
 *   - DLQ growth rate ≤ 1 keyword/day
 *
 * The error budget for a 95% target on a 4h cadence is:
 *   30 days × 6 runs/day = 180 runs
 *   180 × 5% = 9 allowed failures/month
 *
 * Used by the weekly SLO report and the Discord notify.
 */

const { supa } = require("./clients");

const TARGET_SUCCESS_RATE = 0.95;
const TARGET_INTERVAL_HOURS = 5;
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Fetches workflow run conclusions from GitHub Actions API.
 * Requires GITHUB_TOKEN (auto-provided in workflows) and GITHUB_REPOSITORY.
 *
 * @param {{ workflow?: string, days?: number }} [opts]
 * @returns {Promise<Array<{ conclusion: string, created_at: string }>>}
 */
async function fetchRecentRuns({ workflow = "generate.yml", days = 30 } = {}) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    throw new Error("slo: GITHUB_TOKEN and GITHUB_REPOSITORY required");
  }
  const since = new Date(Date.now() - days * 24 * MS_PER_HOUR).toISOString();
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?status=completed&created=>=${since}&per_page=100`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`slo: GitHub API ${res.status}`);
  const data = await res.json();
  return (data.workflow_runs || []).map((r) => ({
    conclusion: r.conclusion,
    created_at: r.created_at,
  }));
}

/**
 * Compute SLO metrics from a list of runs.
 *
 * @param {Array<{ conclusion: string, created_at: string }>} runs
 * @returns {{
 *   total: number,
 *   succeeded: number,
 *   failed: number,
 *   successRate: number,
 *   meetsTarget: boolean,
 *   meanIntervalHours: number | null,
 *   errorBudgetUsedPct: number,
 * }}
 */
function computeMetrics(runs) {
  const total = runs.length;
  const succeeded = runs.filter((r) => r.conclusion === "success").length;
  const failed = runs.filter((r) => r.conclusion === "failure").length;
  const successRate = total === 0 ? 0 : succeeded / total;

  // Mean interval between successive runs (regardless of outcome).
  const sorted = [...runs].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  let meanIntervalHours = null;
  if (sorted.length >= 2) {
    const first = new Date(sorted[0].created_at).getTime();
    const last = new Date(sorted[sorted.length - 1].created_at).getTime();
    meanIntervalHours = (last - first) / MS_PER_HOUR / (sorted.length - 1);
  }

  // Error budget: % of allowed failures consumed
  const allowedFailures = total * (1 - TARGET_SUCCESS_RATE);
  const errorBudgetUsedPct =
    allowedFailures > 0 ? Math.min(100, (failed / allowedFailures) * 100) : 0;

  return {
    total,
    succeeded,
    failed,
    successRate: +successRate.toFixed(4),
    meetsTarget: successRate >= TARGET_SUCCESS_RATE,
    meanIntervalHours: meanIntervalHours == null ? null : +meanIntervalHours.toFixed(2),
    errorBudgetUsedPct: +errorBudgetUsedPct.toFixed(1),
  };
}

/**
 * DLQ growth: how many entries were archived in the last N days.
 *
 * @param {{ days?: number }} [opts]
 * @returns {Promise<{ count: number, perDay: number }>}
 */
async function dlqGrowth({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 24 * MS_PER_HOUR).toISOString();
  const rows = await supa(
    "GET",
    `failed_keywords?archived_at=gte.${encodeURIComponent(since)}&select=id`
  );
  const count = Array.isArray(rows) ? rows.length : 0;
  return { count, perDay: +(count / days).toFixed(2) };
}

/**
 * Renders a compact SLO summary as markdown — used in the Discord
 * weekly report and (optionally) in the dashboard.
 *
 * @param {ReturnType<typeof computeMetrics>} metrics
 * @param {{ count: number, perDay: number }} dlq
 */
function formatSummary(metrics, dlq) {
  const successPct = (metrics.successRate * 100).toFixed(1);
  const status = metrics.meetsTarget ? "✅" : "🔴";
  const lines = [
    `**SLO — last ${metrics.total} runs**`,
    `${status} Success rate: ${successPct}% (target ≥ ${TARGET_SUCCESS_RATE * 100}%)`,
    `⏱  Mean interval: ${metrics.meanIntervalHours ?? "n/a"}h (target ≤ ${TARGET_INTERVAL_HOURS}h)`,
    `📉 Error budget used: ${metrics.errorBudgetUsedPct}%`,
    `🪦 DLQ growth: ${dlq.count} archived (${dlq.perDay}/day)`,
  ];
  return lines.join("\n");
}

module.exports = {
  fetchRecentRuns,
  computeMetrics,
  dlqGrowth,
  formatSummary,
  TARGET_SUCCESS_RATE,
  TARGET_INTERVAL_HOURS,
};
