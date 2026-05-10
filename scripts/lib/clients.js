/**
 * Supabase REST + WordPress REST clients shared across scripts.
 *
 * Both clients build on fetchWithRetry so every caller inherits the same
 * retry/timeout semantics — no more inline ad-hoc retry loops.
 */

const { loadEnv } = require("./env");
const { fetchWithRetry } = require("./http");

const WP_HOST = "https://aipickd.com";

const WP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function getEnv() {
  return loadEnv();
}

async function supa(method, endpoint, body, opts = {}) {
  const env = getEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("supa(): SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing");
  }
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
}

async function wp(method, endpoint, body, opts = {}) {
  const env = getEnv();
  if (!env.WP_USERNAME || !env.WP_ADMIN_PASSWORD) {
    throw new Error("wp(): WP_USERNAME or WP_ADMIN_PASSWORD missing");
  }
  const auth = Buffer.from(`${env.WP_USERNAME}:${env.WP_ADMIN_PASSWORD}`).toString("base64");

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
}

module.exports = { supa, wp, WP_USER_AGENT };
