/**
 * Dead-letter queue for keywords that exhausted their retry budget.
 *
 * Backs the `failed_keywords` table from migration 20260509130000.
 *
 * Lifecycle:
 *   1. run-pipeline catches a generation error → increments
 *      keywords.attempts and stores last_error_at/last_error.
 *   2. When attempts >= 3, run-pipeline calls archiveFailedKeyword(id).
 *   3. Daily report surfaces listUntriaged() count.
 *   4. Human reviews via a script or SQL query, then calls markTriaged().
 */

const { supa } = require("./clients");

/**
 * Move a keyword from `keywords` to `failed_keywords`.
 * Idempotent: if the keyword is already archived, it's a no-op.
 *
 * @param {string} keywordId  UUID from keywords.id.
 * @param {{ note?: string }} [opts]
 * @returns {Promise<{ archivedId: string | null, alreadyArchived: boolean }>}
 */
async function archiveFailedKeyword(keywordId, opts = {}) {
  if (!keywordId) throw new Error("archiveFailedKeyword: keywordId required");

  const rows = await supa(
    "GET",
    `keywords?id=eq.${encodeURIComponent(keywordId)}&select=id,keyword,niche_id,attempts,last_error,last_error_at`
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    // Keyword may have been deleted already; check if it's in DLQ.
    const archived = await supa(
      "GET",
      `failed_keywords?original_id=eq.${encodeURIComponent(keywordId)}&select=id&limit=1`
    );
    return {
      archivedId: archived?.[0]?.id || null,
      alreadyArchived: archived?.length > 0,
    };
  }
  const k = rows[0];

  // Skip if already archived for this original_id.
  const existing = await supa(
    "GET",
    `failed_keywords?original_id=eq.${encodeURIComponent(k.id)}&select=id&limit=1`
  );
  if (Array.isArray(existing) && existing.length > 0) {
    return { archivedId: existing[0].id, alreadyArchived: true };
  }

  const inserted = await supa("POST", "failed_keywords", [
    {
      keyword: k.keyword,
      niche_id: k.niche_id,
      original_id: k.id,
      attempts: k.attempts || 0,
      last_error: k.last_error,
      last_error_at: k.last_error_at,
      triage_note: opts.note || null,
    },
  ]);
  const archivedRow = Array.isArray(inserted) ? inserted[0] : null;

  // Mark the original keyword as failed so it stops appearing in the queue.
  await supa("PATCH", `keywords?id=eq.${encodeURIComponent(k.id)}`, {
    status: "failed",
  });

  return { archivedId: archivedRow?.id || null, alreadyArchived: false };
}

/**
 * Get untriaged DLQ entries (most recent first).
 *
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Array<{ id: string, keyword: string, attempts: number, last_error: string | null, archived_at: string }>>}
 */
async function listUntriaged({ limit = 50 } = {}) {
  const rows = await supa(
    "GET",
    `failed_keywords?triaged=is.false&order=archived_at.desc&limit=${limit}&select=id,keyword,attempts,last_error,archived_at`
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Count of untriaged DLQ entries — used by daily-report for a quick metric.
 *
 * @returns {Promise<number>}
 */
async function untriagedCount() {
  const rows = await supa("GET", `failed_keywords?triaged=is.false&select=id`, undefined, {
    prefer: "count=exact",
  });
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * Mark a DLQ entry as triaged (reviewed by human).
 *
 * @param {string} failedId  failed_keywords.id
 * @param {{ note?: string }} [opts]
 */
async function markTriaged(failedId, opts = {}) {
  if (!failedId) throw new Error("markTriaged: failedId required");
  await supa("PATCH", `failed_keywords?id=eq.${encodeURIComponent(failedId)}`, {
    triaged: true,
    triage_note: opts.note || null,
  });
}

module.exports = { archiveFailedKeyword, listUntriaged, untriagedCount, markTriaged };
