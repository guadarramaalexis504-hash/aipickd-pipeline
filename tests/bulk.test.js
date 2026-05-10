const { test } = require("node:test");
const assert = require("node:assert/strict");

const { chunk } = require("../scripts/lib/bulk");

test("chunk: splits even array", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5, 6], 2), [
    [1, 2],
    [3, 4],
    [5, 6],
  ]);
});

test("chunk: handles uneven trailing batch", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("chunk: empty array returns empty", () => {
  assert.deepEqual(chunk([], 10), []);
});

test("chunk: size larger than array → single chunk", () => {
  assert.deepEqual(chunk([1, 2, 3], 100), [[1, 2, 3]]);
});

test("chunk: rejects size <= 0", () => {
  assert.throws(() => chunk([1, 2], 0));
  assert.throws(() => chunk([1, 2], -1));
});

// The bulk* helpers are thin wrappers over supa(); their behavior is
// covered transitively by lib/clients tests + a smoke check that they
// validate inputs without hitting the network.
test("bulkInsert: rejects non-array input", async () => {
  const { bulkInsert } = require("../scripts/lib/bulk");
  await assert.rejects(() => bulkInsert("t", null), /must be an array/);
});

test("bulkInsert: empty rows returns [] without network call", async () => {
  const { bulkInsert } = require("../scripts/lib/bulk");
  const out = await bulkInsert("t", []);
  assert.deepEqual(out, []);
});

test("bulkUpsert: requires onConflict", async () => {
  const { bulkUpsert } = require("../scripts/lib/bulk");
  await assert.rejects(() => bulkUpsert("t", [{ a: 1 }], {}), /onConflict/);
});

test("bulkUpdate: requires PK on every row", async () => {
  const { bulkUpdate } = require("../scripts/lib/bulk");
  await assert.rejects(() => bulkUpdate("t", [{}]), /missing primary key/);
});
