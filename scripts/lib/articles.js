/**
 * Soft-delete helpers for the articles table.
 *
 * Backs the deleted_at/deleted_reason columns from migration
 * 20260510130000. Use these instead of `DELETE FROM articles` so a
 * mistake (or a moderation false-positive) is recoverable.
 *
 * Reading: existing queries against `articles` see soft-deleted rows by
 * default. New code that should ignore them can SELECT from the
 * `articles_active` view instead.
 */

const { supa } = require("./clients");

/**
 * Soft-delete an article. Idempotent: re-deleting only refreshes the
 * deleted_at timestamp.
 *
 * @param {string} articleId
 * @param {{ reason?: string }} [opts]
 */
async function softDelete(articleId, opts = {}) {
  if (!articleId) throw new Error("softDelete: articleId required");
  return supa("PATCH", `articles?id=eq.${encodeURIComponent(articleId)}`, {
    deleted_at: new Date().toISOString(),
    deleted_reason: opts.reason || null,
  });
}

/**
 * Restore a soft-deleted article (clear deleted_at + deleted_reason).
 *
 * @param {string} articleId
 */
async function restore(articleId) {
  if (!articleId) throw new Error("restore: articleId required");
  return supa("PATCH", `articles?id=eq.${encodeURIComponent(articleId)}`, {
    deleted_at: null,
    deleted_reason: null,
  });
}

/**
 * List soft-deleted articles (most recent first).
 *
 * @param {{ limit?: number }} [opts]
 */
async function listDeleted({ limit = 50 } = {}) {
  return supa(
    "GET",
    `articles?deleted_at=not.is.null&order=deleted_at.desc&limit=${limit}&select=id,title,slug,deleted_at,deleted_reason`
  );
}

module.exports = { softDelete, restore, listDeleted };
