const { test } = require("node:test");
const assert = require("node:assert/strict");

const dashboard = require("../scripts/lib/dashboard");

test("dashboard: exports render function", () => {
  assert.equal(typeof dashboard.render, "function");
});

// Full render() requires Supabase; we only smoke-test the surface here.
// End-to-end coverage comes from running the dashboard-update workflow
// against a real Supabase project in PR.
