#!/usr/bin/env node
"use strict";

const { hasWriteFlag, readIntFlag } = require("./lib/cli-safety");
const { supa } = require("./lib/clients");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const argv = process.argv.slice(2);
const GO = hasWriteFlag(argv, new Set(["--go"]));
const LIMIT = readIntFlag(argv, "--limit", 1);

function verifyWordPressLanguageBridge() {
  const probe = spawnSync(process.execPath, [path.join(__dirname, "wp-language-bridge-probe.js")], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 60_000,
  });
  if (probe.status === 0) return true;
  console.log("BLOCKER: WordPress language bridge probe failed or could not verify _pipeline_lang=es.");
  const out = `${probe.stdout || ""}${probe.stderr || ""}`.trim();
  if (out) console.log(out.slice(0, 1200));
  return false;
}

async function main() {
  if (GO && LIMIT > 1) {
    throw new Error("Phase 1 guardrail: --go may release at most 1 Spanish keyword.");
  }

  const rows = await supa(
    "GET",
    `keywords?status=eq.es_hold&order=priority.desc,search_volume.desc&limit=${LIMIT}&select=id,keyword,language,status,priority,search_volume,assigned_article_id`
  );
  const keywords = Array.isArray(rows) ? rows : [];
  console.log(`release-es-keywords mode=${GO ? "WRITE --go" : "REPORT ONLY"} limit=${LIMIT}`);
  if (keywords.length === 0) {
    console.log("No es_hold keywords found.");
    return 0;
  }

  for (const keyword of keywords) {
    const action = {
      id: keyword.id,
      keyword: keyword.keyword,
      language: keyword.language || "es",
      from: keyword.status,
      to: "queued",
      assigned_article_id: keyword.assigned_article_id || null,
    };
    console.log(JSON.stringify({ planned_action: action }, null, 2));
  }

  if (!GO) {
    console.log("No writes performed. Re-run with --go to release one keyword.");
    return 0;
  }

  if (!verifyWordPressLanguageBridge()) {
    console.log("No writes performed. Spanish release remains blocked.");
    return 3;
  }

  for (const keyword of keywords) {
    await supa("PATCH", `keywords?id=eq.${encodeURIComponent(keyword.id)}`, {
      status: "queued",
      language: "es",
      updated_at: new Date().toISOString(),
    });
    console.log(`Released ${keyword.id} -> queued`);
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(err.code === "ENV_MISSING" ? 2 : 1);
  });
}
