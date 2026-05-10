const { test } = require("node:test");
const assert = require("node:assert/strict");

const { computeMetrics, formatSummary } = require("../scripts/lib/slo");

const now = Date.now();
function runAt(hoursAgo, conclusion) {
  return {
    conclusion,
    created_at: new Date(now - hoursAgo * 60 * 60 * 1000).toISOString(),
  };
}

test("computeMetrics: empty runs", () => {
  const m = computeMetrics([]);
  assert.equal(m.total, 0);
  assert.equal(m.successRate, 0);
  assert.equal(m.meetsTarget, false);
  assert.equal(m.meanIntervalHours, null);
});

test("computeMetrics: all green meets target", () => {
  const runs = [runAt(0, "success"), runAt(4, "success"), runAt(8, "success")];
  const m = computeMetrics(runs);
  assert.equal(m.total, 3);
  assert.equal(m.succeeded, 3);
  assert.equal(m.failed, 0);
  assert.equal(m.successRate, 1);
  assert.equal(m.meetsTarget, true);
  assert.equal(m.meanIntervalHours, 4);
});

test("computeMetrics: 90% success misses 95% target", () => {
  const runs = [];
  for (let i = 0; i < 9; i++) runs.push(runAt(i * 4, "success"));
  runs.push(runAt(36, "failure"));
  const m = computeMetrics(runs);
  assert.equal(m.total, 10);
  assert.equal(m.successRate, 0.9);
  assert.equal(m.meetsTarget, false);
});

test("computeMetrics: error budget usage", () => {
  // 100 runs, 5% target failure budget = 5 allowed; 5 fails = 100% used
  const runs = [];
  for (let i = 0; i < 95; i++) runs.push(runAt(i, "success"));
  for (let i = 0; i < 5; i++) runs.push(runAt(95 + i, "failure"));
  const m = computeMetrics(runs);
  assert.equal(m.failed, 5);
  assert.equal(m.errorBudgetUsedPct, 100);
});

test("formatSummary: contains key metrics", () => {
  const metrics = computeMetrics([runAt(0, "success"), runAt(4, "success"), runAt(8, "failure")]);
  const dlq = { count: 2, perDay: 0.07 };
  const out = formatSummary(metrics, dlq);
  assert.match(out, /Success rate: 66\.7%/);
  assert.match(out, /DLQ growth: 2 archived/);
});

test("formatSummary: shows red emoji when below target", () => {
  const metrics = computeMetrics([runAt(0, "failure"), runAt(4, "success")]);
  const out = formatSummary(metrics, { count: 0, perDay: 0 });
  assert.match(out, /🔴/);
});
