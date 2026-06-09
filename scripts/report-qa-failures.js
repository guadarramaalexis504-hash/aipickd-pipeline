#!/usr/bin/env node
"use strict";

const { readIntFlag } = require("./lib/cli-safety");
const { issueMessages } = require("./lib/quality");
const { supa } = require("./lib/clients");

const argv = process.argv.slice(2);
const LIMIT = readIntFlag(argv, "--limit", 100);

function issueCodes(article) {
  if (Array.isArray(article.qa_issues) && article.qa_issues.length > 0) {
    return article.qa_issues.map((issue) =>
      typeof issue === "string" ? issue : issue.code || issue.message || "unknown"
    );
  }
  if (article.last_error) return [article.last_error];
  return ["unknown"];
}

async function main() {
  const rows = await supa(
    "GET",
    `articles?status=eq.qa_failed&order=created_at.desc&limit=${LIMIT}&select=id,title,slug,language,qa_issues,last_error,quality_score,word_count,created_at,repair_status`
  );
  const articles = Array.isArray(rows) ? rows : [];
  const byCause = new Map();
  const byLanguage = new Map();
  for (const article of articles) {
    byLanguage.set(article.language || "en", (byLanguage.get(article.language || "en") || 0) + 1);
    for (const code of issueCodes(article)) {
      byCause.set(code, (byCause.get(code) || 0) + 1);
    }
  }

  console.log(`QA failures: ${articles.length}`);
  console.log("By language:", Object.fromEntries(byLanguage));
  console.log("By cause:", Object.fromEntries(byCause));
  for (const article of articles) {
    console.log(
      JSON.stringify(
        {
          id: article.id,
          title: article.title,
          slug: article.slug,
          language: article.language || "en",
          word_count: article.word_count || 0,
          quality_score: article.quality_score,
          causes: issueMessages({ issues: article.qa_issues || [] }),
          last_error: article.last_error || null,
          repair_status: article.repair_status || null,
        },
        null,
        2
      )
    );
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}
