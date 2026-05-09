const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const NODE = process.execPath;

function runLog(code, env = {}) {
  return spawnSync(
    NODE,
    [
      "-e",
      `const log = require(${JSON.stringify(path.join(__dirname, "..", "scripts", "lib", "log.js"))}).create({ script: "test" }); ${code}`,
    ],
    { env: { ...process.env, LOG_FORMAT: "json", ...env }, encoding: "utf8" }
  );
}

test("log: emits JSON line with required fields", () => {
  const r = runLog('log.info("hello", { a: 1 });');
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.msg, "hello");
  assert.equal(out.level, "info");
  assert.equal(out.script, "test");
  assert.equal(out.a, 1);
  assert.match(out.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("log: error/warn go to stderr", () => {
  const r = runLog('log.error("boom"); log.warn("careful"); log.info("ok");');
  assert.equal(r.status, 0);
  const errLines = r.stderr.trim().split("\n").filter(Boolean).map(JSON.parse);
  const outLines = r.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(errLines.length, 2);
  assert.equal(errLines[0].level, "error");
  assert.equal(errLines[1].level, "warn");
  assert.equal(outLines.length, 1);
  assert.equal(outLines[0].level, "info");
});

test("log: serializes Error instances safely", () => {
  const r = runLog('log.error("failed", { err: new Error("nope") });');
  const out = JSON.parse(r.stderr.trim());
  assert.equal(out.err.message, "nope");
  assert.match(out.err.stack, /at /);
});

test("log: respects LOG_LEVEL=warn (drops info/debug)", () => {
  const r = runLog('log.debug("d"); log.info("i"); log.warn("w"); log.error("e");', {
    LOG_LEVEL: "warn",
  });
  const errLines = r.stderr.trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(r.stdout.trim(), "");
  assert.equal(errLines.length, 2);
  assert.deepEqual(
    errLines.map((l) => l.msg),
    ["w", "e"]
  );
});

test("log: child() merges base fields", () => {
  const r = runLog(
    'const c = log.child({ articleId: 42 }); c.info("done", { words: 100 });'
  );
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.script, "test");
  assert.equal(out.articleId, 42);
  assert.equal(out.words, 100);
});

test("log: handles circular references without crashing", () => {
  const r = runLog('const o = {}; o.self = o; log.info("circ", { o });');
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.o.self, "[Circular]");
});
