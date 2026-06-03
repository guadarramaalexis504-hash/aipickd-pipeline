/**
 * fetch wrapper with timeout + exponential backoff retry.
 *
 * Retries on:
 *   - network errors (TypeError from fetch, AbortError on timeout)
 *   - HTTP 5xx
 *   - HTTP 429 (respects Retry-After header if present)
 *
 * Does NOT retry on 4xx (except 429) — those are caller bugs, not transient.
 *
 * Optional SSRF protection: set HTTP_ALLOWED_HOSTS=host1,host2,host3 to
 * restrict which hosts can be reached. Useful in CI to prevent a compromised
 * dependency from exfiltrating data to an attacker-controlled host.
 */

const dns = require("node:dns");

// Hostinger publishes both AAAA and A records for aipickd.com, but GitHub
// Actions and some local networks can hang on the IPv6 route. Undici's fetch
// follows Node's DNS result order, so prefer IPv4 to avoid connect timeouts.
dns.setDefaultResultOrder("ipv4first");

const DEFAULTS = {
  retries: 3,
  baseDelay: 1000,
  maxDelay: 15000,
  timeout: 30000,
  retryOn: [429, 500, 502, 503, 504],
};

const DEFAULT_ALLOWED_HOSTS = [
  "api.openai.com",
  "api.anthropic.com",
  "discord.com",
  "discordapp.com",
  "aipickd.com",
  "www.aipickd.com",
  "api.unsplash.com",
  "images.unsplash.com",
  "api.indexnow.org",
  "google.com",
  "www.google.com",
  "www.bing.com",
  "yandex.com",
  "hc-ping.com",
];

// Loopback always allowed — needed for local tests with ephemeral servers.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseAllowlist() {
  const env = process.env.HTTP_ALLOWED_HOSTS;
  if (!env || env.trim() === "") return null;
  if (env.trim() === "*") return null; // explicitly allow all
  return env
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Throws if the URL's host is not on the allowlist.
 * Allowlist sources (first non-empty wins):
 *   1. opts.allowedHosts (explicit)
 *   2. process.env.HTTP_ALLOWED_HOSTS
 *   3. process.env.SUPABASE_URL host (auto-added so Supabase always works)
 *   4. DEFAULT_ALLOWED_HOSTS (the curated set above)
 *
 * @param {string | URL} url
 * @param {string[] | null | undefined} explicitList
 */
function assertHostAllowed(url, explicitList) {
  let host;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    throw new Error(`http: invalid URL: ${String(url).slice(0, 120)}`);
  }

  // Always allow loopback — tests bind to 127.0.0.1 with ephemeral ports.
  const hostNoPort = host.split(":")[0];
  if (LOOPBACK_HOSTS.has(hostNoPort) || LOOPBACK_HOSTS.has(host)) return;

  let list = explicitList ?? parseAllowlist();
  if (!list) {
    list = [...DEFAULT_ALLOWED_HOSTS];
    // Resolve SUPABASE_URL from process.env (CI) OR .env (local dev).
    // Previously only checked process.env, which silently blocked local runs
    // where the secret lives in .env. loadEnv() unifies both sources.
    let supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) {
      try {
        const { loadEnv } = require("./env");
        supabaseUrl = loadEnv().SUPABASE_URL;
      } catch {
        /* env helper unavailable — fall through to defaults */
      }
    }
    if (supabaseUrl) {
      try {
        list.push(new URL(supabaseUrl).host.toLowerCase());
      } catch {
        /* ignore malformed SUPABASE_URL — validate-secrets catches that */
      }
    }
  }

  if (list.includes("*")) return;
  if (!list.some((h) => host === h || host.endsWith("." + h))) {
    const err = new Error(`http: host not allowed: ${host}`);
    err.code = "HOST_NOT_ALLOWED";
    err.host = host;
    throw err;
  }
}

function jitter(ms) {
  return ms * (0.5 + Math.random() * 0.5);
}

function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * @typedef {object} RetryOptions
 * @property {number} [retries=3]      Max retry attempts after the first try.
 * @property {number} [baseDelay=1000]  Base delay in ms (doubled per attempt).
 * @property {number} [maxDelay=15000]  Cap for any single backoff sleep.
 * @property {number} [timeout=30000]   Per-attempt timeout in ms.
 * @property {number[]} [retryOn]       HTTP statuses that trigger a retry.
 * @property {string[] | null} [allowedHosts]  Override the SSRF allowlist.
 *                                             Pass `null` to disable the check.
 */

/**
 * Drop-in `fetch` replacement with exponential backoff + jittered retries
 * on transient failures (network errors, 5xx, 429). Honors `Retry-After`
 * on 429. Aborts each attempt after `timeout`.
 *
 * @param {string | URL} url
 * @param {RequestInit} [options]
 * @param {RetryOptions} [opts]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (opts.allowedHosts !== null) {
    assertHostAllowed(url, opts.allowedHosts);
  }
  let lastErr = null;

  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeout);

    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });

      if (cfg.retryOn.includes(res.status) && attempt < cfg.retries) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        const delay = retryAfter ?? Math.min(jitter(cfg.baseDelay * 2 ** attempt), cfg.maxDelay);
        process.stderr.write(
          `[http] ${res.status} on ${shortUrl(url)} — retry ${attempt + 1}/${cfg.retries} in ${Math.round(delay)}ms\n`
        );
        await sleep(delay);
        continue;
      }

      return res;
    } catch (err) {
      lastErr = err;
      const isAbort = err.name === "AbortError";
      const isNetwork =
        err.name === "TypeError" ||
        err.code === "ECONNRESET" ||
        err.code === "ECONNREFUSED" ||
        err.code === "ETIMEDOUT" ||
        err.code === "EAI_AGAIN";

      if (attempt >= cfg.retries || (!isAbort && !isNetwork)) {
        throw err;
      }

      const delay = Math.min(jitter(cfg.baseDelay * 2 ** attempt), cfg.maxDelay);
      process.stderr.write(
        `[http] ${err.name}${isAbort ? " (timeout)" : ""} on ${shortUrl(url)} — retry ${attempt + 1}/${cfg.retries} in ${Math.round(delay)}ms\n`
      );
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr || new Error(`fetchWithRetry exhausted retries for ${url}`);
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return String(url).slice(0, 80);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { fetchWithRetry, parseRetryAfter, assertHostAllowed };
