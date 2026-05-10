/**
 * Supabase REST + WordPress REST clients shared across scripts.
 *
 * Both clients build on fetchWithRetry (timeout + retry/backoff) and are
 * wrapped in a process-singleton circuit breaker. WP additionally gets a
 * token-bucket rate limiter so we stay under Hostinger/LiteSpeed's 5 req/s
 * threshold instead of triggering it.
 *
 * Behavior under sustained failure:
 *   - 5 consecutive failures → circuit OPEN for 60s
 *   - calls during OPEN throw with `code: "CIRCUIT_OPEN"` (no network hit)
 *   - first call after cooldown is a HALF_OPEN trial — success closes,
 *     failure re-opens for another 60s
 *
 * The breakers are exported (`breakers.supabase`, `breakers.wordpress`)
 * so callers can introspect / trip / reset them in tests or admin scripts.
 */

const { loadEnv } = require("./env");
const { fetchWithRetry } = require("./http");
const { createBreaker } = require("./circuit-breaker");
const { createLimiter } = require("./rate-limiter");

const WP_HOST = "https://aipickd.com";

const WP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const breakers = {
  supabase: createBreaker("supabase", {
    failureThreshold: 5,
    cooldownMs: 60_000,
    timeoutMs: 45_000,
  }),
  wordpress: createBreaker("wordpress", {
    failureThreshold: 5,
    cooldownMs: 60_000,
    timeoutMs: 75_000,
  }),
};

// 4 req/s sustained, burst 8 — well under the Hostinger 429 threshold.
const wpLimiter = createLimiter({ tokensPerSecond: 4, burst: 8 });

function getEnv() {
  return loadEnv();
}

/**
 * Authenticated REST call to Supabase using the service-role key from env.
 * Throws on non-2xx responses with the body included in the error message.
 *
 * @param {"GET" | "POST" | "PATCH" | "DELETE"} method
 * @param {string} endpoint  Path under `/rest/v1/`, e.g. `articles?select=id`.
 * @param {unknown} [body]   Auto-JSON-stringified.
 * @param {{ prefer?: string, timeout?: number, retries?: number }} [opts]
 * @returns {Promise<unknown>}
 */
async function supa(method, endpoint, body, opts = {}) {
  const env = getEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("supa(): SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
  }
  return breakers.supabase.exec(async () => {
    const res = await fetchWithRetry(
      `${env.SUPABASE_URL}/rest/v1/${endpoint}`,
      {
        method,
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: opts.prefer || "return=representation",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      { timeout: opts.timeout || 30000, retries: opts.retries ?? 3 }
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Supabase ${method} ${endpoint}: ${res.status} ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  });
}

/**
 * Authenticated REST call to WordPress using basic auth (Application Password).
 * Sends a real-browser User-Agent to bypass Hostinger/LiteSpeed bot rate limits,
 * gated by a token-bucket limiter that stays under the server's 5 req/s ceiling.
 *
 * @param {"GET" | "POST" | "PATCH" | "PUT" | "DELETE"} method
 * @param {string} endpoint  Path under `/wp-json/wp/v2/`, e.g. `posts?per_page=10`.
 * @param {unknown} [body]
 * @param {{ timeout?: number, retries?: number }} [opts]
 * @returns {Promise<unknown>}
 */
async function wp(method, endpoint, body, opts = {}) {
  const env = getEnv();
  if (!env.WP_USERNAME || !env.WP_ADMIN_PASSWORD) {
    throw new Error("wp(): WP_USERNAME or WP_ADMIN_PASSWORD missing");
  }
  const auth = Buffer.from(`${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`).toString("base64");

  await wpLimiter.acquire();

  return breakers.wordpress.exec(async () => {
    const res = await fetchWithRetry(
      `${WP_HOST}/wp-json/wp/v2/${endpoint}`,
      {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          "User-Agent": WP_USER_AGENT,
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      { timeout: opts.timeout || 60000, retries: opts.retries ?? 3 }
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`WP ${method} ${endpoint}: ${res.status} ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  });
}

module.exports = { supa, wp, breakers, wpLimiter, WP_USER_AGENT };
