"use strict";

const { filterPipelineKeywords } = require("./spanish-gate");

const DEFAULT_QUEUED_KEYWORD_ENDPOINT =
  "keywords?status=eq.queued&assigned_article_id=is.null&order=priority.desc,search_volume.desc&limit=50&select=*,niche:niches(slug,name)";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readArgValue(argv, name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a UUID value.`);
  }
  return value;
}

function parseOnlyKeywordId(argv = process.argv.slice(2)) {
  const value = readArgValue(argv, "--only-keyword-id");
  if (value === null) return null;
  const keywordId = String(value).trim();
  if (!UUID_RE.test(keywordId)) {
    throw new Error("--only-keyword-id must be a valid UUID.");
  }
  return keywordId;
}

function buildQueuedKeywordEndpoint({ onlyKeywordId = null } = {}) {
  if (!onlyKeywordId) return DEFAULT_QUEUED_KEYWORD_ENDPOINT;
  return `keywords?id=eq.${encodeURIComponent(
    onlyKeywordId
  )}&status=eq.queued&assigned_article_id=is.null&limit=1&select=*,niche:niches(slug,name)`;
}

function selectPipelineKeywords(rows, opts = {}) {
  const onlyKeywordId = opts.onlyKeywordId || null;
  const exactRows = onlyKeywordId
    ? (rows || []).filter((row) => row && row.id === onlyKeywordId)
    : rows || [];
  return filterPipelineKeywords(exactRows, opts);
}

module.exports = {
  DEFAULT_QUEUED_KEYWORD_ENDPOINT,
  buildQueuedKeywordEndpoint,
  parseOnlyKeywordId,
  selectPipelineKeywords,
};
