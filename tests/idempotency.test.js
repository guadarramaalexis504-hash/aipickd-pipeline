const { test } = require("node:test");
const assert = require("node:assert/strict");

const { keyFor, publishKey } = require("../scripts/lib/idempotency");

test("keyFor: deterministic for same input", () => {
  const a = keyFor({ slug: "x", day: "2026-01-01", n: 1 });
  const b = keyFor({ slug: "x", day: "2026-01-01", n: 1 });
  assert.equal(a, b);
});

test("keyFor: order-independent", () => {
  const a = keyFor({ slug: "x", day: "2026-01-01", n: 1 });
  const b = keyFor({ n: 1, day: "2026-01-01", slug: "x" });
  assert.equal(a, b);
});

test("keyFor: different input → different key", () => {
  assert.notEqual(keyFor({ a: 1 }), keyFor({ a: 2 }));
  assert.notEqual(keyFor({ a: 1 }), keyFor({ a: "1" }));
});

test("keyFor: returns 32-char hex", () => {
  const k = keyFor({ a: 1 });
  assert.equal(k.length, 32);
  assert.match(k, /^[a-f0-9]+$/);
});

test("keyFor: rejects non-objects", () => {
  assert.throws(() => keyFor(null));
  assert.throws(() => keyFor("x"));
  assert.throws(() => keyFor(undefined));
});

test("publishKey: stable for same slug+body+day", () => {
  const a = publishKey({ slug: "best-ai-tools", body: "hello world", day: "2026-05-09" });
  const b = publishKey({ slug: "best-ai-tools", body: "hello world", day: "2026-05-09" });
  assert.equal(a, b);
});

test("publishKey: changes when body changes", () => {
  const a = publishKey({ slug: "x", body: "v1", day: "2026-05-09" });
  const b = publishKey({ slug: "x", body: "v2", day: "2026-05-09" });
  assert.notEqual(a, b);
});

test("publishKey: changes when day changes", () => {
  const a = publishKey({ slug: "x", body: "same", day: "2026-05-09" });
  const b = publishKey({ slug: "x", body: "same", day: "2026-05-10" });
  assert.notEqual(a, b);
});

test("publishKey: defaults day to today UTC if omitted", () => {
  const today = new Date().toISOString().slice(0, 10);
  const a = publishKey({ slug: "x", body: "y" });
  const b = publishKey({ slug: "x", body: "y", day: today });
  assert.equal(a, b);
});

test("publishKey: rejects missing slug or body", () => {
  assert.throws(() => publishKey({ body: "x" }));
  assert.throws(() => publishKey({ slug: "x" }));
  assert.throws(() => publishKey({ slug: "x", body: 42 }));
});
