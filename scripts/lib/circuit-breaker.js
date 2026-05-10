/**
 * Circuit breaker for external service calls.
 *
 * Why: when OpenAI/Supabase/WP have an outage, retrying every request
 * for hours wastes time and money and can prolong the outage. The
 * circuit breaker detects sustained failure and short-circuits subsequent
 * calls until the service appears healthy again.
 *
 * States:
 *   CLOSED   — normal operation, calls go through
 *   OPEN     — too many failures, all calls fail fast for `cooldownMs`
 *   HALF_OPEN — cooldown elapsed, one trial call allowed; success → CLOSED
 *
 * Usage:
 *   const cb = createBreaker("openai", { failureThreshold: 5, cooldownMs: 60000 });
 *   try {
 *     const result = await cb.exec(() => openaiCall(...));
 *   } catch (err) {
 *     if (err.code === "CIRCUIT_OPEN") { ... fallback ... }
 *     throw err;
 *   }
 */

const STATES = { CLOSED: "closed", OPEN: "open", HALF_OPEN: "half_open" };

const DEFAULTS = {
  failureThreshold: 5, // consecutive failures before opening
  successThreshold: 1, // consecutive successes in HALF_OPEN before closing
  cooldownMs: 60_000, // how long OPEN lasts before HALF_OPEN
  timeoutMs: 30_000, // per-call timeout enforced by the breaker
};

/**
 * @param {string} name  Identifier surfaced in logs/errors.
 * @param {Partial<typeof DEFAULTS>} [opts]
 */
function createBreaker(name, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let state = STATES.CLOSED;
  let consecutiveFailures = 0;
  let consecutiveSuccesses = 0;
  let openedAt = 0;

  function transitionTo(next) {
    if (state === next) return;
    state = next;
    if (next === STATES.OPEN) {
      openedAt = Date.now();
    } else if (next === STATES.CLOSED) {
      consecutiveFailures = 0;
      consecutiveSuccesses = 0;
    }
  }

  function maybeReopen() {
    if (state === STATES.OPEN && Date.now() - openedAt >= cfg.cooldownMs) {
      transitionTo(STATES.HALF_OPEN);
    }
  }

  async function exec(fn) {
    maybeReopen();

    if (state === STATES.OPEN) {
      const remaining = cfg.cooldownMs - (Date.now() - openedAt);
      const err = new Error(
        `Circuit '${name}' is OPEN — fast-failing (${remaining}ms until retry)`
      );
      err.code = "CIRCUIT_OPEN";
      err.circuit = name;
      err.retryInMs = Math.max(0, remaining);
      throw err;
    }

    let result;
    try {
      result = await withTimeout(fn(), cfg.timeoutMs, name);
    } catch (err) {
      onFailure();
      throw err;
    }

    onSuccess();
    return result;
  }

  function onSuccess() {
    consecutiveFailures = 0;
    if (state === STATES.HALF_OPEN) {
      consecutiveSuccesses++;
      if (consecutiveSuccesses >= cfg.successThreshold) {
        transitionTo(STATES.CLOSED);
      }
    }
  }

  function onFailure() {
    consecutiveSuccesses = 0;
    if (state === STATES.HALF_OPEN) {
      transitionTo(STATES.OPEN);
      return;
    }
    consecutiveFailures++;
    if (consecutiveFailures >= cfg.failureThreshold) {
      transitionTo(STATES.OPEN);
    }
  }

  return {
    exec,
    /** Force the breaker open (e.g. from an external alert). */
    trip: () => transitionTo(STATES.OPEN),
    /** Force the breaker closed (e.g. for testing). */
    reset: () => transitionTo(STATES.CLOSED),
    state: () => state,
    stats: () => ({
      name,
      state,
      consecutiveFailures,
      consecutiveSuccesses,
      openedAt: openedAt || null,
    }),
  };
}

async function withTimeout(promise, ms, name) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Circuit '${name}' timeout after ${ms}ms`);
      err.code = "CIRCUIT_TIMEOUT";
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { createBreaker, STATES };
