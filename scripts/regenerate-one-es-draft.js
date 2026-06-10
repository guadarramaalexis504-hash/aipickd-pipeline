#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { hasWriteFlag, readFlag } = require("./lib/cli-safety");
const { supa } = require("./lib/clients");
const {
  CONFIRM_REGENERATE,
  DEFAULT_REGENERATE_ARTICLE_ID,
  DEFAULT_REGENERATE_KEYWORD_ID,
  buildKeywordResetPatch,
  buildOldArticleFailurePatch,
  buildRunPipelineArgs,
  countPlaceholderMatches,
  validateRegenerationPreflight,
} = require("./lib/regenerate-draft");

const argv = process.argv.slice(2);
const GO = hasWriteFlag(argv, new Set(["--go"]));
const ARTICLE_ID = readFlag(argv, "--article-id", DEFAULT_REGENERATE_ARTICLE_ID);
const KEYWORD_ID = readFlag(argv, "--keyword-id", DEFAULT_REGENERATE_KEYWORD_ID);
const CONFIRM = readFlag(argv, "--confirm", "");
const ROOT = path.join(__dirname, "..");

function requireConfirmationForWrite() {
  if (!GO) return;
  if (CONFIRM !== CONFIRM_REGENERATE) {
    throw new Error(`Refusing to write: --confirm must be ${CONFIRM_REGENERATE}`);
  }
}

async function fetchRows() {
  const [articleRows, keywordRows, configRows] = await Promise.all([
    supa(
      "GET",
      `articles?id=eq.${encodeURIComponent(ARTICLE_ID)}` +
        "&select=id,title,slug,status,language,keyword_id,content_markdown,word_count,wp_post_id,wp_url,qa_issues"
    ),
    supa(
      "GET",
      `keywords?id=eq.${encodeURIComponent(KEYWORD_ID)}` +
        "&select=id,keyword,status,language,assigned_article_id"
    ),
    supa(
      "GET",
      "pipeline_config?id=eq.00000000-0000-0000-0000-000000000001&select=spanish_pipeline_enabled"
    ),
  ]);

  return {
    article: Array.isArray(articleRows) ? articleRows[0] : null,
    keyword: Array.isArray(keywordRows) ? keywordRows[0] : null,
    config: Array.isArray(configRows) ? configRows[0] : null,
  };
}

function clearOutlineCache(keywordId) {
  const cachePath = path.join(ROOT, ".outline-cache", `${keywordId}.json`);
  const existed = fs.existsSync(cachePath);
  if (existed) fs.unlinkSync(cachePath);
  return { cachePath, existed };
}

function runPipeline(keywordId) {
  const args = buildRunPipelineArgs(keywordId);
  console.log(`Running: node ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, AUTO_PUBLISH: "false" },
    timeout: 45 * 60 * 1000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`run-pipeline exited with status ${result.status}`);
  }
}

async function fetchFinalState() {
  const [oldRows, keywordRows, newRows] = await Promise.all([
    supa(
      "GET",
      `articles?id=eq.${encodeURIComponent(ARTICLE_ID)}` +
        "&select=id,title,slug,status,language,word_count,wp_post_id,wp_url,qa_issues,repair_status"
    ),
    supa(
      "GET",
      `keywords?id=eq.${encodeURIComponent(KEYWORD_ID)}&select=id,keyword,status,language,assigned_article_id`
    ),
    supa(
      "GET",
      `articles?keyword_id=eq.${encodeURIComponent(KEYWORD_ID)}` +
        `&id=neq.${encodeURIComponent(ARTICLE_ID)}` +
        "&order=created_at.desc&limit=1" +
        "&select=id,title,slug,status,language,word_count,quality_score,qa_issues,wp_post_id,wp_url,content_markdown,created_at"
    ),
  ]);

  const newArticle = Array.isArray(newRows) ? newRows[0] : null;
  const newPlaceholderCount = newArticle
    ? countPlaceholderMatches(newArticle.content_markdown || "").count
    : null;

  if (newArticle) delete newArticle.content_markdown;

  return {
    old_article: Array.isArray(oldRows) ? oldRows[0] : null,
    keyword: Array.isArray(keywordRows) ? keywordRows[0] : null,
    new_article: newArticle,
    new_placeholder_count: newPlaceholderCount,
  };
}

async function main() {
  requireConfirmationForWrite();

  console.log(`regenerate-one-es-draft mode=${GO ? "WRITE --go" : "REPORT ONLY"}`);
  console.log("AUTO_PUBLISH=false; WordPress publishing is not attempted by this script.");
  console.log(`Target article_id=${ARTICLE_ID}`);
  console.log(`Target keyword_id=${KEYWORD_ID}`);

  const { article, keyword, config } = await fetchRows();
  const preflight = validateRegenerationPreflight({
    article,
    keyword,
    config,
    articleId: ARTICLE_ID,
    keywordId: KEYWORD_ID,
  });
  if (!preflight.ok) {
    console.error("Preflight failed:");
    for (const issue of preflight.issues) console.error(`- ${issue}`);
    return 1;
  }

  const placeholders = countPlaceholderMatches(article.content_markdown || "");
  if (placeholders.count === 0) {
    console.error("Refusing to regenerate: old draft has no configured placeholder terms.");
    console.error("No writes performed.");
    return 1;
  }

  const now = new Date();
  const oldArticlePatch = buildOldArticleFailurePatch({
    article,
    placeholderMatches: placeholders.matches,
    now,
  });
  const keywordPatch = buildKeywordResetPatch({ now });
  const pipelineArgs = buildRunPipelineArgs(KEYWORD_ID);

  const plan = {
    will_write: GO,
    will_publish: false,
    old_article_id: article.id,
    old_article_status_from: article.status,
    old_article_status_to: oldArticlePatch.status,
    old_article_slug_from: article.slug,
    old_article_slug_to: oldArticlePatch.slug,
    keyword_id: keyword.id,
    keyword_status_from: keyword.status,
    keyword_status_to: keywordPatch.status,
    keyword_assigned_article_id_to: keywordPatch.assigned_article_id,
    old_placeholder_count: placeholders.count,
    old_placeholder_summary: placeholders.summary,
    pipeline_command: `node ${pipelineArgs.join(" ")}`,
    auto_publish: "false",
  };
  console.log(JSON.stringify({ plan }, null, 2));

  if (!GO) {
    console.log("No writes performed. Re-run with --go and exact --confirm to regenerate.");
    return 0;
  }

  const cache = clearOutlineCache(KEYWORD_ID);
  console.log(
    `Outline cache ${cache.existed ? "cleared" : "not present"}: ${path.relative(ROOT, cache.cachePath)}`
  );

  await supa("PATCH", `articles?id=eq.${encodeURIComponent(article.id)}`, oldArticlePatch);
  await supa("PATCH", `keywords?id=eq.${encodeURIComponent(keyword.id)}`, keywordPatch);

  runPipeline(KEYWORD_ID);

  const finalState = await fetchFinalState();
  console.log(JSON.stringify({ final: finalState }, null, 2));

  if (!finalState.new_article) {
    console.error("Regeneration finished without a replacement article row.");
    return 1;
  }
  if (finalState.new_article.wp_post_id !== null || finalState.new_article.wp_url !== null) {
    console.error("Safety violation: replacement article has WordPress publish fields.");
    return 1;
  }

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
