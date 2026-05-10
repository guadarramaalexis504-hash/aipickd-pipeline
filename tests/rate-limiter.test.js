const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createLimiter } = require("../scripts/lib/rate-limiter");

test("rate-limiter: first burst acquires immediately", async () => {
  const lim = createLimiter({ tokensPerSecond: 10, burst: 5 });
  const waits = [];
  for (let i = 0; i < 5; i++) waits.push(await lim.acquire());
  assert.ok(
    waits.every((w) => w < 20),
    `expected zero waits, got ${waits}`
  );
});

test("rate-limiter: throttles when bucket empties", async () => {
  const lim = createLimiter({ tokensPerSecond: 100, burst: 2 });
  await lim.acquire();
  await lim.acquire();
  const waited = await lim.acquire();
  assert.ok(waited >= 5, `should wait at least ~10ms, waited ${waited}`);
});

test("rate-limiter: refills over time", async () => {
  const lim = createLimiter({ tokensPerSecond: 200, burst: 1 });
  await lim.acquire();
  await new Promise((r) => setTimeout(r, 30));
  const waited = await lim.acquire();
  assert.ok(waited < 20, `bucket should have refilled, waited ${waited}`);
});

test("rate-limiter: rejects acquire(cost > burst)", async () => {
  const lim = createLimiter({ tokensPerSecond: 10, burst: 3 });
  await assert.rejects(() => lim.acquire(5), /exceeds burst capacity/);
});

test("rate-limiter: rejects invalid config", () => {
  assert.throws(() => createLimiter({ tokensPerSecond: 0 }));
  assert.throws(() => createLimiter({ tokensPerSecond: -1 }));
  assert.throws(() => createLimiter({ tokensPerSecond: NaN }));
});

test("rate-limiter: stats() reports current state", async () => {
  const lim = createLimiter({ tokensPerSecond: 5, burst: 10 });
  await lim.acquire();
  await lim.acquire();
  const s = lim.stats();
  assert.equal(s.burst, 10);
  assert.equal(s.tokensPerSecond, 5);
  assert.ok(s.tokens >= 7 && s.tokens <= 10, `tokens=${s.tokens}`);
});

test("rate-limiter: cost > 1 consumes multiple tokens", async () => {
  const lim = createLimiter({ tokensPerSecond: 10, burst: 5 });
  await lim.acquire(3);
  const s = lim.stats();
  assert.ok(s.tokens >= 1.9 && s.tokens <= 2.5, `expected ~2 tokens, got ${s.tokens}`);
});
