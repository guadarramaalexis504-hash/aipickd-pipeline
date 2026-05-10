const { test } = require("node:test");
const assert = require("node:assert/strict");

// dlq.js depends on supa() at runtime; we only assert the surface here
// (input validation, exported names) — full E2E would need Supabase.
const dlq = require("../scripts/lib/dlq");

test("dlq: exports expected functions", () => {
  assert.equal(typeof dlq.archiveFailedKeyword, "function");
  assert.equal(typeof dlq.listUntriaged, "function");
  assert.equal(typeof dlq.untriagedCount, "function");
  assert.equal(typeof dlq.markTriaged, "function");
});

test("dlq.archiveFailedKeyword: rejects empty id", async () => {
  await assert.rejects(() => dlq.archiveFailedKeyword(""), /keywordId required/);
  await assert.rejects(() => dlq.archiveFailedKeyword(null), /keywordId required/);
  await assert.rejects(() => dlq.archiveFailedKeyword(undefined), /keywordId required/);
});

test("dlq.markTriaged: rejects empty id", async () => {
  await assert.rejects(() => dlq.markTriaged(""), /failedId required/);
  await assert.rejects(() => dlq.markTriaged(null), /failedId required/);
});
