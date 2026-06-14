"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { isTransientNetworkError } = require("../scripts/lib/http");

test("classifies undici 'fetch failed' as transient", () => {
  const e = new TypeError("fetch failed");
  assert.equal(isTransientNetworkError(e), true);
});

test("classifies AbortError (timeout) as transient", () => {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  assert.equal(isTransientNetworkError(e), true);
});

test("classifies ECONNRESET / connect timeout as transient", () => {
  const e = new Error("connect ECONNRESET");
  e.code = "ECONNRESET";
  assert.equal(isTransientNetworkError(e), true);
  const e2 = new Error("Connect Timeout Error");
  e2.code = "UND_ERR_CONNECT_TIMEOUT";
  assert.equal(isTransientNetworkError(e2), true);
});

test("does NOT classify a 401/403 auth error as transient", () => {
  const e = new Error("WP POST posts: 401 unauthorized");
  e.status = 401;
  assert.equal(isTransientNetworkError(e), false);
  const e2 = new Error("forbidden");
  e2.status = 403;
  assert.equal(isTransientNetworkError(e2), false);
});

test("does NOT classify a generic logic error as transient", () => {
  assert.equal(isTransientNetworkError(new Error("undefined is not a function")), false);
  assert.equal(isTransientNetworkError(null), false);
});
