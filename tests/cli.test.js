const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "scripts", "cli.js");

test("cli: help shows command list", () => {
  const r = spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /AIPickd CLI/);
  assert.match(r.stdout, /pipeline/);
  assert.match(r.stdout, /dlq list/);
  assert.match(r.stdout, /affiliate check/);
});

test("cli: no args also shows help", () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Commands:/);
});

test("cli: --help flag works", () => {
  const r = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Commands:/);
});

test("cli: unknown command exits non-zero", () => {
  const r = spawnSync(process.execPath, [CLI, "doesnotexist"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown command/);
});

test("cli: dlq triage without id exits non-zero", () => {
  const r = spawnSync(process.execPath, [CLI, "dlq", "triage"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage:/);
});

test("cli: COMMANDS map exports expected entries", () => {
  const { COMMANDS } = require("../scripts/cli");
  for (const key of ["help", "pipeline", "monitor", "cost", "dashboard", "dlq list"]) {
    assert.ok(COMMANDS[key], `missing command: ${key}`);
  }
});
