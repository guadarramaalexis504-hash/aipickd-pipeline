/**
 * Deterministic idempotency keys for pipeline operations.
 *
 * Why: a network blip mid-publish can leave Supabase thinking the article
 * wasn't published while WP already accepted it. Next run picks the same
 * draft and publishes a duplicate. An idempotency key derived from the
 * canonical inputs (slug + scheduled day + content hash) lets us detect
 * "already done" without trusting timing.
 *
 * Use these as primary-key-equivalent strings: store on the article row,
 * pass on the WP request as `?idempotency_key=...`, check in the next
 * run before publishing.
 */

const crypto = require("node:crypto");

/**
 * Stable hash of the canonical inputs to a pipeline operation.
 * @param {object} parts  Will be JSON-stringified with sorted keys.
 * @returns {string}      32-char hex digest (truncated SHA-256).
 */
function keyFor(parts) {
  if (parts == null || typeof parts !== "object") {
    throw new TypeError("keyFor: parts must be an object");
  }
  const canonical = JSON.stringify(parts, Object.keys(parts).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Convenience for the publish operation: scoped to (slug + UTC day + body hash).
 * Two publishes with the same inputs on the same day produce the same key.
 *
 * @param {{ slug: string, body: string, day?: string }} input
 * @returns {string}
 */
function publishKey({ slug, body, day }) {
  if (!slug || typeof slug !== "string") {
    throw new TypeError("publishKey: slug required");
  }
  if (typeof body !== "string") {
    throw new TypeError("publishKey: body required (string)");
  }
  const utcDay = day || new Date().toISOString().slice(0, 10);
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 16);
  return keyFor({ op: "publish", slug, day: utcDay, bodyHash });
}

module.exports = { keyFor, publishKey };
