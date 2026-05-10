const { test } = require("node:test");
const assert = require("node:assert/strict");

const cache = require("../scripts/lib/cache");

test("cache: rejects empty key on get", async () => {
  await assert.rejects(() => cache.get(""), /non-empty string/);
  await assert.rejects(() => cache.get(null), /non-empty string/);
});

test("cache: rejects empty key on set", async () => {
  await assert.rejects(() => cache.set("", "x"), /non-empty string/);
});

test("cache: rejects invalid ttlSeconds", async () => {
  await assert.rejects(() => cache.set("k", "v", { ttlSeconds: 0 }), /positive number/);
  await assert.rejects(() => cache.set("k", "v", { ttlSeconds: -1 }), /positive number/);
  await assert.rejects(() => cache.set("k", "v", { ttlSeconds: NaN }), /positive number/);
});

test("cache: exports surface", () => {
  assert.equal(typeof cache.get, "function");
  assert.equal(typeof cache.set, "function");
  assert.equal(typeof cache.del, "function");
  assert.equal(typeof cache.getOrCompute, "function");
  assert.equal(typeof cache.pruneExpired, "function");
});
