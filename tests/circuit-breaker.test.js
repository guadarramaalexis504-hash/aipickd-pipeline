const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createBreaker, STATES } = require("../scripts/lib/circuit-breaker");

test("circuit-breaker: starts CLOSED and lets calls through", async () => {
  const cb = createBreaker("test");
  const result = await cb.exec(async () => 42);
  assert.equal(result, 42);
  assert.equal(cb.state(), STATES.CLOSED);
});

test("circuit-breaker: opens after N consecutive failures", async () => {
  const cb = createBreaker("test", { failureThreshold: 3, cooldownMs: 1000 });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() =>
      cb.exec(async () => {
        throw new Error("nope");
      })
    );
  }
  assert.equal(cb.state(), STATES.OPEN);
});

test("circuit-breaker: fast-fails when OPEN with code CIRCUIT_OPEN", async () => {
  const cb = createBreaker("test", { failureThreshold: 1, cooldownMs: 5000 });
  await assert.rejects(() =>
    cb.exec(async () => {
      throw new Error("x");
    })
  );
  let calls = 0;
  await assert.rejects(
    () =>
      cb.exec(async () => {
        calls++;
        return "ok";
      }),
    (err) => {
      assert.equal(err.code, "CIRCUIT_OPEN");
      assert.equal(err.circuit, "test");
      assert.ok(err.retryInMs > 0);
      return true;
    }
  );
  assert.equal(calls, 0, "underlying fn must not be invoked when OPEN");
});

test("circuit-breaker: transitions OPEN → HALF_OPEN after cooldown", async () => {
  const cb = createBreaker("test", { failureThreshold: 1, cooldownMs: 30 });
  await assert.rejects(() =>
    cb.exec(async () => {
      throw new Error("x");
    })
  );
  assert.equal(cb.state(), STATES.OPEN);
  await new Promise((r) => setTimeout(r, 50));
  // First call after cooldown is the trial — succeeds → CLOSED
  const result = await cb.exec(async () => "ok");
  assert.equal(result, "ok");
  assert.equal(cb.state(), STATES.CLOSED);
});

test("circuit-breaker: HALF_OPEN failure re-opens immediately", async () => {
  const cb = createBreaker("test", { failureThreshold: 1, cooldownMs: 20 });
  await assert.rejects(() =>
    cb.exec(async () => {
      throw new Error("x");
    })
  );
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(() =>
    cb.exec(async () => {
      throw new Error("y");
    })
  );
  assert.equal(cb.state(), STATES.OPEN);
});

test("circuit-breaker: timeoutMs aborts long calls and counts as failure", async () => {
  const cb = createBreaker("test", { failureThreshold: 1, timeoutMs: 30 });
  await assert.rejects(
    () => cb.exec(() => new Promise((r) => setTimeout(() => r("late"), 200))),
    (err) => err.code === "CIRCUIT_TIMEOUT"
  );
  assert.equal(cb.state(), STATES.OPEN);
});

test("circuit-breaker: trip() and reset() force state", async () => {
  const cb = createBreaker("test");
  cb.trip();
  assert.equal(cb.state(), STATES.OPEN);
  cb.reset();
  assert.equal(cb.state(), STATES.CLOSED);
});

test("circuit-breaker: stats() exposes counters", async () => {
  const cb = createBreaker("svc", { failureThreshold: 5 });
  await assert.rejects(() =>
    cb.exec(async () => {
      throw new Error("x");
    })
  );
  await assert.rejects(() =>
    cb.exec(async () => {
      throw new Error("x");
    })
  );
  const s = cb.stats();
  assert.equal(s.name, "svc");
  assert.equal(s.state, STATES.CLOSED);
  assert.equal(s.consecutiveFailures, 2);
});
