"use strict";

function normalizeLanguage(language) {
  const lang = String(language || "en")
    .toLowerCase()
    .trim();
  if (lang.startsWith("es")) return "es";
  return "en";
}

function spanishAllowed({ includeEs = false, spanishPipelineEnabled = false } = {}) {
  return Boolean(includeEs || spanishPipelineEnabled);
}

function filterPipelineKeywords(rows, opts = {}) {
  const allowSpanish = spanishAllowed(opts);
  return (rows || []).filter((row) => {
    const lang = normalizeLanguage(row.language);
    return lang !== "es" || allowSpanish;
  });
}

function keywordStateForArticle(article = {}) {
  if (article.status === "qa_failed") return "qa_failed";
  if (article.status === "needs_repair") return "needs_repair";
  if (article.status === "published" && article.wp_post_id && article.wp_url) {
    return "published";
  }
  return "generated";
}

module.exports = {
  normalizeLanguage,
  spanishAllowed,
  filterPipelineKeywords,
  keywordStateForArticle,
};
