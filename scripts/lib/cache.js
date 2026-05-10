/**
 * Supabase-backed TTL cache for expensive computations or API results.
 *
 * Persists across pipeline runs (each cron-triggered run is a new VM).
 * Use for things that are expensive to compute or fetch but don't
 * change often:
 *   - "list of active niches" (cheap to query but read on every run)
 *   - "current month's published slugs" (used by dedup checks)
 *   - "GA4 daily traffic top 10" (rate-limited external API)
 *
 * Backed by the cache_entries table (migration 20260511130000).
 *
 * Usage:
 *   const cache = require("./lib/cache");
 *   const niches = await cache.getOrCompute(
 *     "niches:active",
 *     () => supa("GET", "niches?status=eq.active"),
 *     { ttlSeconds: 3600 }
 *   );
 */

const { supa } = require("./clients");

const DEFAULT_TTL_SECONDS = 600; // 10 minutes

/**
 * Read a cache entry. Returns null if missing or expired.
 *
 * @param {string} key
 * @returns {Promise<unknown | null>}
 */
async function get(key) {
  if (!key || typeof key !== "string") {
    throw new TypeError("cache.get: key must be a non-empty string");
  }
  const rows = await supa(
    "GET",
    `cache_entries?key=eq.${encodeURIComponent(key)}&select=value,expires_at&limit=1`
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row.value;
}

/**
 * Write or replace a cache entry.
 *
 * @param {string} key
 * @param {unknown} value     Must be JSON-serializable.
 * @param {{ ttlSeconds?: number }} [opts]
 */
async function set(key, value, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
  if (!key || typeof key !== "string") {
    throw new TypeError("cache.set: key must be a non-empty string");
  }
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError("cache.set: ttlSeconds must be a positive number");
  }
  const expires_at = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await supa("POST", `cache_entries?on_conflict=key`, [{ key, value, expires_at }], {
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

/**
 * Delete a cache entry. No-op if it doesn't exist.
 *
 * @param {string} key
 */
async function del(key) {
  await supa("DELETE", `cache_entries?key=eq.${encodeURIComponent(key)}`);
}

/**
 * Read-through cache: returns cached value if fresh, otherwise calls
 * `compute()`, stores the result, and returns it.
 *
 * Negative results (null/undefined) are NOT cached — that would
 * require a sentinel and adds confusion. Compute() can throw to
 * propagate errors normally.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} compute
 * @param {{ ttlSeconds?: number }} [opts]
 * @returns {Promise<T>}
 */
async function getOrCompute(key, compute, opts = {}) {
  const cached = await get(key);
  if (cached != null) return cached;
  const value = await compute();
  if (value != null) {
    await set(key, value, opts).catch((e) => {
      // Cache write failure should never block the caller.
      process.stderr.write(`[cache] set failed for ${key}: ${e.message}\n`);
    });
  }
  return value;
}

/**
 * Removes all expired entries. Run from a daily cron.
 *
 * @returns {Promise<{ deleted: number }>}
 */
async function pruneExpired() {
  const cutoff = new Date().toISOString();
  // PostgREST DELETE returns the deleted rows when Prefer: return=representation.
  const deleted = await supa(
    "DELETE",
    `cache_entries?expires_at=lt.${encodeURIComponent(cutoff)}`,
    undefined,
    { prefer: "return=representation" }
  );
  return { deleted: Array.isArray(deleted) ? deleted.length : 0 };
}

module.exports = { get, set, del, getOrCompute, pruneExpired };
