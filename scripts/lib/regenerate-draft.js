"use strict";

const { detectToolPlaceholders } = require("./quality");
const { normalizeLanguage } = require("./spanish-gate");

const CONFIRM_REGENERATE = "REGENERATE_ONE_ES_DRAFT";
const DEFAULT_REGENERATE_ARTICLE_ID = "62e72631-6267-46ec-ae97-05da5e5c715a";
const DEFAULT_REGENERATE_KEYWORD_ID = "ff36854c-ed82-4066-a737-3063869d0c8b";

function validateRegenerationPreflight({ article, keyword, config, articleId, keywordId }) {
  const issues = [];

  if (!article) {
    issues.push(`article ${articleId} not found`);
  } else {
    if (article.id !== articleId) issues.push(`article.id must be ${articleId}`);
    if (article.status !== "draft")
      issues.push(`article.status must be draft, got ${article.status}`);
    if (normalizeLanguage(article.language) !== "es") {
      issues.push(`article.language must be es, got ${article.language || "null"}`);
    }
    if (article.wp_post_id !== null) issues.push("article.wp_post_id must be null");
    if (article.wp_url !== null) issues.push("article.wp_url must be null");
    if (article.keyword_id !== keywordId) {
      issues.push(`article.keyword_id must be ${keywordId}, got ${article.keyword_id || "null"}`);
    }
  }

  if (!keyword) {
    issues.push(`keyword ${keywordId} not found`);
  } else {
    if (keyword.id !== keywordId) issues.push(`keyword.id must be ${keywordId}`);
    if (normalizeLanguage(keyword.language) !== "es") {
      issues.push(`keyword.language must be es, got ${keyword.language || "null"}`);
    }
    if (keyword.assigned_article_id !== articleId) {
      issues.push(`keyword.assigned_article_id must be ${articleId}`);
    }
  }

  if (!config) {
    issues.push("pipeline_config row missing");
  } else if (config.spanish_pipeline_enabled !== false) {
    issues.push("pipeline_config.spanish_pipeline_enabled must be false");
  }

  return { ok: issues.length === 0, issues };
}

function countPlaceholderMatches(markdown = "") {
  const matches = detectToolPlaceholders(markdown);
  const byPhrase = new Map();
  for (const match of matches) {
    byPhrase.set(match.phrase, (byPhrase.get(match.phrase) || 0) + 1);
  }
  return {
    count: matches.length,
    matches,
    summary: Array.from(byPhrase, ([phrase, count]) => ({ phrase, count })),
  };
}

function timestampForSlug(date = new Date()) {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "t").toLowerCase();
}

function buildOldArticleFailurePatch({ article, placeholderMatches, now = new Date() }) {
  const count = placeholderMatches.length;
  const unique = Array.from(new Set(placeholderMatches.map((match) => match.phrase))).join(", ");
  const message = `${count} placeholder term(s) detected before regeneration: ${unique}`;
  const retiredSlug = `${article.slug}-qa-failed-${timestampForSlug(now)}`;
  const timestamp = now.toISOString();

  return {
    status: "qa_failed",
    slug: retiredSlug,
    wp_post_id: null,
    wp_url: null,
    quality_score: 0,
    qa_issues: [
      {
        code: "placeholder_terms",
        message,
        severity: "blocking",
        repairable: true,
        recommendation: "regenerate from scratch before publishing",
      },
    ],
    last_error: message,
    last_error_at: timestamp,
    last_qa_at: timestamp,
    repair_status: "regenerate_from_scratch",
    repair_notes: `Retired unpublished placeholder draft before controlled ES regeneration at ${timestamp}`,
  };
}

function buildKeywordResetPatch({ now = new Date() } = {}) {
  return {
    status: "queued",
    assigned_article_id: null,
    updated_at: now.toISOString(),
  };
}

function buildRunPipelineArgs(keywordId) {
  return [
    "scripts/run-pipeline.js",
    "--gen",
    "1",
    "--include-es",
    "--no-pub",
    "--only-keyword-id",
    keywordId,
  ];
}

module.exports = {
  CONFIRM_REGENERATE,
  DEFAULT_REGENERATE_ARTICLE_ID,
  DEFAULT_REGENERATE_KEYWORD_ID,
  buildKeywordResetPatch,
  buildOldArticleFailurePatch,
  buildRunPipelineArgs,
  countPlaceholderMatches,
  timestampForSlug,
  validateRegenerationPreflight,
};
