#!/usr/bin/env node
"use strict";

const { hasWriteFlag, readFlag } = require("./lib/cli-safety");
const { supa } = require("./lib/clients");
const {
  detectToolPlaceholders,
  issueMessages,
  qualityGate,
  repairToolPlaceholders,
} = require("./lib/quality");

const argv = process.argv.slice(2);
const GO = hasWriteFlag(argv, new Set(["--go"]));
const ARTICLE_ID = readFlag(argv, "--article-id", null);

const DEFAULT_REPAIR_TOOLS = {
  toolA: "ChatGPT",
  toolB: "Claude",
  toolC: "Gemini",
  toolSet: "ChatGPT/Claude/Gemini",
  genericTool: "ChatGPT",
  genericProduct: "ChatGPT",
};

function qaIssueObjects(qa) {
  return (qa.issues || []).map((issue) => ({
    code: issue.code || "qa_failed",
    message: issue.message || String(issue),
    severity: issue.severity || "blocking",
    repairable: issue.repairable !== false,
    recommendation: issue.recommendation || "repair or regenerate before publishing",
  }));
}

function requireArticleId() {
  if (ARTICLE_ID) return;
  console.error("Usage: node scripts/repair-placeholder-draft.js --article-id <uuid> [--go]");
  console.error("Default mode is report-only; --go is required for Supabase writes.");
  process.exit(2);
}

async function fetchArticle(id) {
  const rows = await supa(
    "GET",
    `articles?id=eq.${encodeURIComponent(id)}` +
      "&select=id,title,slug,language,status,keyword_id,primary_keyword,content_markdown,word_count,wp_post_id,wp_url"
  );
  return Array.isArray(rows) ? rows[0] : null;
}

async function main() {
  requireArticleId();

  const article = await fetchArticle(ARTICLE_ID);
  if (!article) {
    console.error(`Article not found: ${ARTICLE_ID}`);
    return 1;
  }

  console.log(`repair-placeholder-draft mode=${GO ? "WRITE --go" : "REPORT ONLY"}`);
  console.log(`Target article: ${article.id} "${article.title}"`);
  console.log("This script never publishes to WordPress and never sets status=published.");

  if (article.wp_post_id || article.wp_url || article.status === "published") {
    console.error(
      "Refusing to edit an article that already appears published. Use manual editorial review."
    );
    return 3;
  }

  const matches = detectToolPlaceholders(article.content_markdown || "");
  const repaired = repairToolPlaceholders(article.content_markdown || "", DEFAULT_REPAIR_TOOLS);
  const wordCount = repaired.text.split(/\s+/).filter(Boolean).length;
  const qa = qualityGate({
    ...article,
    content_markdown: repaired.text,
    word_count: wordCount,
  });
  const plannedStatus = qa.pass ? "draft" : "needs_repair";

  console.log(
    JSON.stringify(
      {
        article_id: article.id,
        slug: article.slug,
        language: article.language || "en",
        current_status: article.status,
        placeholder_matches: matches.map((match) => match.value),
        replacements: repaired.replacements,
        remaining_placeholders: repaired.remaining,
        planned_status: plannedStatus,
        qa_pass_after_repair: qa.pass,
        qa_issues_after_repair: issueMessages(qa),
        will_write: GO,
        will_publish: false,
      },
      null,
      2
    )
  );

  if (!GO) {
    console.log("No writes performed. Re-run with --go to apply the safe draft repair.");
    return 0;
  }

  if (matches.length === 0) {
    console.log("No placeholder repair needed; no writes performed.");
    return 0;
  }

  const patch = {
    content_markdown: repaired.text,
    word_count: wordCount,
    status: plannedStatus,
    qa_issues: qaIssueObjects(qa),
    last_qa_at: new Date().toISOString(),
    repair_status: qa.pass ? "repaired_placeholders" : "needs_repair",
    repair_notes: `repair-placeholder-draft replaced generic tool placeholders at ${new Date().toISOString()}`,
    last_error: qa.pass ? null : issueMessages(qa).join("; ").slice(0, 500),
    last_error_at: qa.pass ? null : new Date().toISOString(),
  };

  await supa("PATCH", `articles?id=eq.${encodeURIComponent(article.id)}`, patch);

  if (article.keyword_id) {
    await supa("PATCH", `keywords?id=eq.${encodeURIComponent(article.keyword_id)}`, {
      status: qa.pass ? "generated" : "needs_repair",
      assigned_article_id: article.id,
      updated_at: new Date().toISOString(),
    });
  }

  console.log(
    `Applied placeholder repair. Article status=${plannedStatus}; WordPress publish was not attempted.`
  );
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`ERROR: ${err.message}`);
      process.exitCode = 1;
    });
}
