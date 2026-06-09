#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const CHECKS = [
  ["schema", ["check-schema-drift.js"]],
  ["qa_failures", ["report-qa-failures.js", "--limit", "25"]],
  ["reconcile", ["reconcile-wp-supabase.js", "--limit", "50"]],
  ["language_bridge", ["wp-language-bridge-probe.js"]],
];

function runCheck(name, args) {
  const result = spawnSync(process.execPath, [path.join(__dirname, args[0]), ...args.slice(1)], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    name,
    status: result.status,
    ok: result.status === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function main() {
  console.log("AIPickd Phase 1 audit-all (report-only)");
  const results = CHECKS.map(([name, args]) => runCheck(name, args));
  for (const result of results) {
    console.log(`\n== ${result.name} (${result.ok ? "ok" : `exit ${result.status}`}) ==`);
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
  }
  const hardFailures = results.filter((result) => !result.ok && result.name === "schema");
  return hardFailures.length > 0 ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { runCheck };
