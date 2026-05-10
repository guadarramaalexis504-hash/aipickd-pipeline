/**
 * Render a markdown dashboard with current pipeline stats.
 *
 * Compiles data from:
 *   - articles table (count, totals, recent)
 *   - keywords table (queue depth)
 *   - failed_keywords table (DLQ count)
 *   - SLO metrics (computed via lib/slo if GITHUB_TOKEN available)
 *
 * The output is a single markdown string suitable for committing as
 * `docs/dashboard.md` from a daily cron workflow.
 */

const { supa } = require("./clients");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Compose the dashboard markdown.
 *
 * @param {{ asOf?: Date }} [opts]
 * @returns {Promise<string>}
 */
async function render({ asOf = new Date() } = {}) {
  const stamp = asOf.toISOString();
  const day = stamp.slice(0, 10);
  const monthStart = day.slice(0, 7) + "-01";
  const since30 = new Date(asOf.getTime() - 30 * MS_PER_DAY).toISOString();

  const [articles, todayArticles, monthArticles, queueRows, dlqRows] = await Promise.all([
    supa("GET", "articles?select=id&limit=1", undefined, { prefer: "count=exact" }).catch(() => []),
    supa(
      "GET",
      `articles?published_at=gte.${day}T00:00:00Z&select=id,word_count,generation_cost_usd`
    ).catch(() => []),
    supa(
      "GET",
      `articles?published_at=gte.${monthStart}T00:00:00Z&select=word_count,generation_cost_usd`
    ).catch(() => []),
    supa("GET", "keywords?status=eq.queued&select=id", undefined, {
      prefer: "count=exact",
    }).catch(() => []),
    supa(
      "GET",
      `failed_keywords?triaged=is.false&archived_at=gte.${since30}&select=id,keyword`
    ).catch(() => []),
  ]);

  const totalArticles = arrayCount(articles);
  const todayCount = arrayCount(todayArticles);
  const monthCount = arrayCount(monthArticles);
  const queueDepth = arrayCount(queueRows);
  const dlqCount = arrayCount(dlqRows);

  const monthCost = sumNumeric(monthArticles, "generation_cost_usd");
  const monthAvgWords =
    monthCount > 0 ? Math.round(sumNumeric(monthArticles, "word_count") / monthCount) : 0;

  const lines = [
    "# AIPickd Dashboard",
    "",
    `_Last updated: ${stamp}_`,
    "",
    "## Articles",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Total articles | ${totalArticles} |`,
    `| Published today (${day}) | ${todayCount} |`,
    `| Published this month | ${monthCount} |`,
    `| Avg word count (this month) | ${monthAvgWords} |`,
    "",
    "## Spend",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Spent this month | $${monthCost.toFixed(4)} |`,
    `| Cost per article (this month) | $${monthCount > 0 ? (monthCost / monthCount).toFixed(4) : "0.0000"} |`,
    "",
    "## Queue health",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Keywords queued | ${queueDepth} |`,
    `| DLQ untriaged (last 30d) | ${dlqCount} |`,
    "",
  ];

  if (dlqCount > 0) {
    lines.push("### Untriaged DLQ samples", "");
    const samples = (Array.isArray(dlqRows) ? dlqRows : []).slice(0, 5);
    for (const row of samples) {
      lines.push(`- \`${row.keyword}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function arrayCount(x) {
  return Array.isArray(x) ? x.length : 0;
}

function sumNumeric(rows, key) {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const r of rows) {
    const v = typeof r?.[key] === "number" ? r[key] : Number(r?.[key]);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

module.exports = { render };
