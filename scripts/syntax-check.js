#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function listJavaScriptFiles(roots = ["scripts", "tests"]) {
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stat = fs.statSync(root);
    if (stat.isFile()) {
      if (root.endsWith(".js")) files.push(path.resolve(root));
      continue;
    }
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        files.push(...listJavaScriptFiles([full]));
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(path.resolve(full));
      }
    }
  }
  return files.sort();
}

function checkFileSyntax(file) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    file,
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function main(argv = process.argv.slice(2)) {
  const roots = argv.length > 0 ? argv : ["scripts", "tests"];
  const files = listJavaScriptFiles(roots);
  let failures = 0;
  for (const file of files) {
    const result = checkFileSyntax(file);
    if (!result.ok) {
      failures++;
      console.error(`syntax error in ${file}`);
      if (result.stderr) console.error(result.stderr.trim());
      if (result.stdout) console.error(result.stdout.trim());
    }
  }
  if (failures > 0) {
    console.error(`Syntax check failed: ${failures}/${files.length} file(s) failed.`);
    return 1;
  }
  console.log(`Syntax check passed: ${files.length} file(s).`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { listJavaScriptFiles, checkFileSyntax, main };
