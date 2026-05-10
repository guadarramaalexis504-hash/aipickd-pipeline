/**
 * Token-bucket rate limiter for outbound requests.
 *
 * Why: Hostinger/LiteSpeed throws 429 on aipickd.com WP REST when we
 * burst >5 req/s. A leaky bucket smooths bursts so we stay under the
 * server's rate limit instead of triggering it and burning retry budget.
 *
 * Usage:
 *   const limiter = createLimiter({ tokensPerSecond: 4, burst: 8 });
 *   await limiter.acquire();           // waits until a token is available
 *   await wpFetch(...);
 *
 *   await limiter.acquire(2);          // costs 2 tokens (e.g. heavy endpoint)
 */

/**
 * @param {{ tokensPerSecond: number, burst?: number }} opts
 */
function createLimiter({ tokensPerSecond, burst = tokensPerSecond * 2 }) {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) {
    throw new Error("createLimiter: tokensPerSecond must be a positive finite number");
  }
  let tokens = burst;
  let lastRefill = Date.now();

  function refill() {
    const now = Date.now();
    const elapsedSec = (now - lastRefill) / 1000;
    if (elapsedSec > 0) {
      tokens = Math.min(burst, tokens + elapsedSec * tokensPerSecond);
      lastRefill = now;
    }
  }

  /**
   * Resolves when `cost` tokens are available; returns ms waited.
   * @param {number} [cost=1]
   */
  async function acquire(cost = 1) {
    if (cost > burst) {
      throw new Error(`acquire(${cost}): exceeds burst capacity (${burst})`);
    }
    const startedAt = Date.now();
    // Loop instead of single sleep so multiple waiters share fairly.
    while (true) {
      refill();
      if (tokens >= cost) {
        tokens -= cost;
        return Date.now() - startedAt;
      }
      const deficit = cost - tokens;
      const waitMs = Math.max(5, Math.ceil((deficit / tokensPerSecond) * 1000));
      await sleep(waitMs);
    }
  }

  function stats() {
    refill();
    return { tokens: Number(tokens.toFixed(3)), burst, tokensPerSecond };
  }

  return { acquire, stats };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { createLimiter };
