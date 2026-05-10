/**
 * Bulk operations against Supabase REST.
 *
 * Why: scripts often UPSERT hundreds of rows and used to do it one
 * fetch at a time (slow + chatty). Postgres limits ~32k bound parameters
 * per statement, and the REST proxy chokes on enormous JSON payloads
 * around 1-2 MB. Chunking at 100 rows is a safe default.
 *
 * Usage:
 *   const { bulkInsert, bulkUpsert } = require("./lib/bulk");
 *   await bulkInsert("keywords", rows);
 *   await bulkUpsert("articles", rows, { onConflict: "slug" });
 */

const { supa } = require("./clients");

const DEFAULT_CHUNK = 100;

function chunk(arr, size) {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * @param {string} table
 * @param {object[]} rows
 * @param {{ chunkSize?: number, prefer?: string }} [opts]
 * @returns {Promise<object[]>}  Concatenated representations of inserted rows.
 */
async function bulkInsert(table, rows, opts = {}) {
  if (!Array.isArray(rows)) throw new TypeError("bulkInsert: rows must be an array");
  if (rows.length === 0) return [];

  const chunkSize = opts.chunkSize || DEFAULT_CHUNK;
  const out = [];
  for (const batch of chunk(rows, chunkSize)) {
    const result = await supa("POST", table, batch, {
      prefer: opts.prefer || "return=representation",
    });
    if (Array.isArray(result)) out.push(...result);
  }
  return out;
}

/**
 * Upsert with ON CONFLICT clause (Supabase REST: `?on_conflict=col`).
 *
 * @param {string} table
 * @param {object[]} rows
 * @param {{ onConflict: string, chunkSize?: number, ignoreDuplicates?: boolean }} opts
 * @returns {Promise<object[]>}
 */
async function bulkUpsert(table, rows, opts) {
  if (!opts || !opts.onConflict) {
    throw new Error("bulkUpsert: onConflict column(s) required");
  }
  if (!Array.isArray(rows)) throw new TypeError("bulkUpsert: rows must be an array");
  if (rows.length === 0) return [];

  const prefer = [
    "return=representation",
    `resolution=${opts.ignoreDuplicates ? "ignore-duplicates" : "merge-duplicates"}`,
  ].join(",");

  const chunkSize = opts.chunkSize || DEFAULT_CHUNK;
  const endpoint = `${table}?on_conflict=${encodeURIComponent(opts.onConflict)}`;
  const out = [];
  for (const batch of chunk(rows, chunkSize)) {
    const result = await supa("POST", endpoint, batch, { prefer });
    if (Array.isArray(result)) out.push(...result);
  }
  return out;
}

/**
 * Update many rows by primary key. The shape is {pk: value, ...changes} per row.
 * Issues one PATCH per row (REST has no native multi-row UPDATE) but keeps the
 * loop here so callers don't have to.
 *
 * @param {string} table
 * @param {object[]} rows
 * @param {{ pkColumn?: string }} [opts]
 */
async function bulkUpdate(table, rows, opts = {}) {
  if (!Array.isArray(rows)) throw new TypeError("bulkUpdate: rows must be an array");
  const pk = opts.pkColumn || "id";
  const out = [];
  for (const row of rows) {
    if (row[pk] === undefined || row[pk] === null) {
      throw new Error(`bulkUpdate: row missing primary key '${pk}'`);
    }
    const id = row[pk];
    const changes = { ...row };
    delete changes[pk];
    const result = await supa("PATCH", `${table}?${pk}=eq.${encodeURIComponent(id)}`, changes);
    if (Array.isArray(result)) out.push(...result);
  }
  return out;
}

module.exports = { bulkInsert, bulkUpsert, bulkUpdate, chunk };
