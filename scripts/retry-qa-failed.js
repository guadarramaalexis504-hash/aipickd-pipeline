#!/usr/bin/env node
"use strict";

const { hasWriteFlag, readFlag, readIntFlag } = require("./lib/cli-safety");
const { issueMessages } = require("./lib/quality");
const { supa } = require("./lib/clients");

const argv = process.argv.slice(2);
const GO = hasWriteFlag(argv, new Set(["--go"]));
const LANG = readFlag(argv, "--lang", "all");
const LIMIT = readIntFlag(argv, "--limit", 20);

function langFilter(lang) {
  if (lang === "all") return "";
  if (lang !== "es" && lang !== "en") throw new Error("--lang must be es, en, or all");
  return `&language=eq.${encodeURIComponent(lang)}`;
}

async function main() {
  const endpoint =
    `articles?status=eq.qa_failed${langFilter(LANG)}` +
    `&order=created_at.desc&limit=${LIMIT}` +
    "&select=id,title,slug,language,status,keyword_id,qa_issues,last_error,quality_score,word_count,created_at,repair_status";
  const rows = await supa("GET", endpoint);
  const articles = Array.isArray(rows) ? rows : [];
  console.log(`retry-qa-failed mode=${GO ? "WRITE --go" : "REPORT ONLY"} lang=${LANG} limit=${LIMIT}`);
  console.log(`Found ${articles.length} qa_failed article(s).`);

  for (const article of articles) {
    const qa = Array.isArray(article.qa_issues) ? { issues: article.qa_issues } : { issues: [] };
    const messages = issueMessages(qa);
    console.log(
      JSON.stringify(
        {
          id: article.id,
          title: article.title,
          slug: article.slug,
          language: article.language || "en",
          keyword_id: article.keyword_id || null,
          word_count: article.word_count || 0,
          quality_score: article.quality_score,
          last_error: article.last_error || null,
          qa_issues: messages,
          planned_action: GO ? "mark repair_status=retry_requested and keyword needs_repair" : "report only",
        },
        null,
        2
      )
    );
  }

  if (!GO) {
    console.log("No writes performed. Re-run with --go to mark selected failures for repair.");
    return 0;
  }

  for (const article of articles) {
    await supa("PATCH", `articles?id=eq.${encodeURIComponent(article.id)}`, {
      repair_status: "retry_requested",
      repair_notes: `retry-qa-failed requested at ${new Date().toISOString()}`,
    });
    if (article.keyword_id) {
      await supa("PATCH", `keywords?id=eq.${encodeURIComponent(article.keyword_id)}`, {
        status: "needs_repair",
        updated_at: new Date().toISOString(),
      });
    }
  }
  console.log(`Marked ${articles.length} article(s) for repair.`);
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
