"use strict";

const { detectSpanishQualityIssues, detectToolPlaceholders } = require("./quality");
const { normalizeLanguage } = require("./spanish-gate");

const CONFIRM_REGENERATE = "REGENERATE_ONE_ES_DRAFT";
const DEFAULT_REGENERATE_ARTICLE_ID = "62e72631-6267-46ec-ae97-05da5e5c715a";
const DEFAULT_REGENERATE_KEYWORD_ID = "ff36854c-ed82-4066-a737-3063869d0c8b";
const REGENERATABLE_STATUSES = new Set(["draft", "needs_repair", "qa_failed"]);

function qaIssueSummary(issue) {
  if (!issue) return null;
  if (typeof issue === "string") return issue;
  return issue.message || issue.code || null;
}

function normalizeReason(reason) {
  return {
    code: reason.code || "regeneration_reason",
    message: reason.message || reason.code || "regeneration reason detected",
    severity: reason.severity || "blocking",
    repairable: reason.repairable !== false,
    recommendation: reason.recommendation || "regenerate from scratch before publishing",
  };
}

function uniqueReasons(reasons) {
  const seen = new Set();
  const unique = [];
  for (const reason of reasons.map(normalizeReason)) {
    const key = `${reason.code}:${reason.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reason);
  }
  return unique;
}

function detectRegenerationReasons(article = {}) {
  const reasons = [];
  const placeholders = countPlaceholderMatches(article.content_markdown || "");
  if (placeholders.count > 0) {
    const found = placeholders.summary
      .map((match) => `${match.phrase} (${match.count})`)
      .join(", ");
    reasons.push({
      code: "placeholder_terms",
      message: `${placeholders.count} placeholder term(s) detected before regeneration: ${found}`,
    });
  }

  reasons.push(...detectSpanishQualityIssues(article));

  const storedIssues = Array.isArray(article.qa_issues)
    ? article.qa_issues.map(qaIssueSummary).filter(Boolean)
    : [];
  for (const message of storedIssues) {
    reasons.push({
      code: "stored_qa_issue",
      message: `stored QA issue: ${message}`,
    });
  }

  if (article.repair_status) {
    reasons.push({
      code: "repair_status",
      message: `repair_status=${article.repair_status}`,
    });
  }

  if (article.last_error) {
    reasons.push({
      code: "last_error",
      message: `last_error=${String(article.last_error).slice(0, 240)}`,
    });
  }

  return uniqueReasons(reasons);
}

function validateRegenerationPreflight({ article, keyword, config, articleId, keywordId }) {
  const issues = [];
  let reasons = [];

  if (keywordId !== DEFAULT_REGENERATE_KEYWORD_ID) {
    issues.push(`keyword_id must be approved keyword ${DEFAULT_REGENERATE_KEYWORD_ID}`);
  }

  if (!article) {
    issues.push(`article ${articleId} not found`);
  } else {
    if (article.id !== articleId) issues.push(`article.id must be ${articleId}`);
    if (!REGENERATABLE_STATUSES.has(article.status)) {
      issues.push(
        `article.status must be draft, needs_repair, or qa_failed, got ${article.status}`
      );
    }
    if (normalizeLanguage(article.language) !== "es") {
      issues.push(`article.language must be es, got ${article.language || "null"}`);
    }
    if (article.wp_post_id !== null) issues.push("article.wp_post_id must be null");
    if (article.wp_url !== null) issues.push("article.wp_url must be null");
    if (article.keyword_id !== keywordId) {
      issues.push(`article.keyword_id must be ${keywordId}, got ${article.keyword_id || "null"}`);
    }
    reasons = detectRegenerationReasons(article);
    if (reasons.length === 0) {
      issues.push(
        "article must have a detectable regeneration reason: placeholder_terms, english_residual, list_count_mismatch, stale_reference, unsupported_claim, unsupported_quantitative_claim, stored QA issue, repair_status, or last_error"
      );
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

  return { ok: issues.length === 0, issues, reasons };
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

function buildOldArticleFailurePatch({
  article,
  placeholderMatches = [],
  regenerationReasons = [],
  now = new Date(),
}) {
  const reasons =
    regenerationReasons.length > 0
      ? regenerationReasons.map(normalizeReason)
      : [
          {
            code: "placeholder_terms",
            message: `${placeholderMatches.length} placeholder term(s) detected before regeneration: ${Array.from(
              new Set(placeholderMatches.map((match) => match.phrase))
            ).join(", ")}`,
          },
        ];
  const message = reasons.map((reason) => reason.message).join("; ");
  const retiredSlug = `${article.slug}-qa-failed-${timestampForSlug(now)}`;
  const timestamp = now.toISOString();

  return {
    status: "qa_failed",
    slug: retiredSlug,
    wp_post_id: null,
    wp_url: null,
    quality_score: 0,
    qa_issues: reasons,
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
  detectRegenerationReasons,
  timestampForSlug,
  validateRegenerationPreflight,
};
