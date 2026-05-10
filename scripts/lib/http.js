/**
 * fetch wrapper with timeout + exponential backoff retry.
 *
 * Retries on:
 *   - network errors (TypeError from fetch, AbortError on timeout)
 *   - HTTP 5xx
 *   - HTTP 429 (respects Retry-After header if present)
 *
 * Does NOT retry on 4xx (except 429) — those are caller bugs, not transient.
 */

const DEFAULTS = {
  retries: 3,
  baseDelay: 1000,
  maxDelay: 15000,
  timeout: 30000,
  retryOn: [429, 500, 502, 503, 504],
};

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

async function fetchWithRetry(url, options = {}, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
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

module.exports = { fetchWithRetry, parseRetryAfter };
