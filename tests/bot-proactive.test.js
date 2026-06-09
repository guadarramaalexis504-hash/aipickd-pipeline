const { test } = require("node:test");
const assert = require("node:assert/strict");

const { runChecks, _resetDedupForTesting } = require("../discord-bot/proactive");

// Each test gets a clean dedup state — the module keeps a module-level
// Map that would otherwise carry across tests and suppress alerts.
const { beforeEach } = require("node:test");
beforeEach(() => _resetDedupForTesting());

// Build a set of fake supabase helpers that return canned data.
// Each test resets them so we don't carry state.
function mkHelpers({ cost = {}, health = {}, stats = {} } = {}) {
  return {
    getStats: async () => ({ keywords_in_queue: 100, ...stats }),
    getPipelineHealth: async () => ({
      hours_since_last_pub: "1.0",
      qa_failed_count: 0,
      drafts_ready_to_publish: 0,
      last_published_title: "Foo",
      status: "✅ OK",
      ...health,
    }),
    getMonthlyCost: async () => ({
      spent_usd: "5.00",
      budget_usd: "50.00",
      pct_used: "10.0%",
      projected_month_usd: "15.00",
      ...cost,
    }),
  };
}

test("healthy pipeline → zero alerts", async () => {
  const alerts = await runChecks(mkHelpers());
  assert.equal(alerts.length, 0);
});

test("cost 70% triggers info alert", async () => {
  const alerts = await runChecks(
    mkHelpers({ cost: { pct_used: "70.0%", spent_usd: "35.00", projected_month_usd: "50.00" } })
  );
  const costAlert = alerts.find((a) => a.text.includes("Cost MTD"));
  assert.ok(costAlert, "should warn at 65%+");
  assert.equal(costAlert.severity, "info");
});

test("cost 90% triggers warning", async () => {
  const alerts = await runChecks(
    mkHelpers({ cost: { pct_used: "90.0%", spent_usd: "45.00", projected_month_usd: "55.00" } })
  );
  const costAlert = alerts.find((a) => a.text.includes("Monthly cost"));
  assert.ok(costAlert, "should warn at 85%+");
  assert.equal(costAlert.severity, "warning");
});

test("cost 96% triggers critical", async () => {
  const alerts = await runChecks(
    mkHelpers({ cost: { pct_used: "96.0%", spent_usd: "48.00", projected_month_usd: "60.00" } })
  );
  const critical = alerts.find((a) => a.severity === "critical");
  assert.ok(critical, "should be critical at 95%+");
  assert.ok(critical.text.includes("budget at"));
});

test("pipeline idle >8h triggers alert", async () => {
  const alerts = await runChecks(mkHelpers({ health: { hours_since_last_pub: "12.5" } }));
  const idle = alerts.find((a) => a.text.includes("No publish"));
  assert.ok(idle, "should alert on prolonged idle");
});

test("idle alert suppressed when pipeline paused", async () => {
  const alerts = await runChecks(
    mkHelpers({
      health: { hours_since_last_pub: "20", status: "⚠️ POSIBLEMENTE ATASCADO PAUSADO" },
    })
  );
  // Status mentions PAUSADO — we shouldn't alert about idle
  const idle = alerts.find((a) => a.text.includes("No publish"));
  assert.equal(idle, undefined);
});

test("qa_failed >= 10 triggers warning", async () => {
  const alerts = await runChecks(
    mkHelpers({
      health: { qa_failed_count: 12, qa_failed_articles: ["a", "b", "c"] },
    })
  );
  const qa = alerts.find((a) => a.text.includes("qa_failed"));
  assert.ok(qa);
});

test("draft backlog >= 5 triggers info", async () => {
  const alerts = await runChecks(mkHelpers({ health: { drafts_ready_to_publish: 7 } }));
  const drafts = alerts.find((a) => a.text.includes("drafts pendientes"));
  assert.ok(drafts);
});

test("keyword queue <20 triggers info", async () => {
  const alerts = await runChecks(mkHelpers({ stats: { keywords_in_queue: 5 } }));
  const kw = alerts.find((a) => a.text.includes("Keyword queue"));
  assert.ok(kw);
});

test("multiple conditions stack into multiple alerts", async () => {
  // Use unique cost % so we don't dedup against earlier tests
  const alerts = await runChecks(
    mkHelpers({
      cost: { pct_used: "67.5%", spent_usd: "33.75" },
      health: { hours_since_last_pub: "15", drafts_ready_to_publish: 8 },
      stats: { keywords_in_queue: 8 },
    })
  );
  assert.ok(alerts.length >= 2, `expected 2+ alerts, got ${alerts.length}`);
});
