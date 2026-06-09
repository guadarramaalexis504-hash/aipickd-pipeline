const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { listJavaScriptFiles, checkFileSyntax } = require("../scripts/syntax-check");

test("syntax-check lists JS files recursively without shell-specific xargs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aipickd-syntax-"));
  fs.mkdirSync(path.join(dir, "nested"));
  fs.writeFileSync(path.join(dir, "a.js"), "const a = 1;\n");
  fs.writeFileSync(path.join(dir, "nested", "b.js"), "const b = 2;\n");
  fs.writeFileSync(path.join(dir, "nested", "not-js.txt"), "nope\n");

  const files = listJavaScriptFiles([dir])
    .map((f) => path.basename(f))
    .sort();
  assert.deepEqual(files, ["a.js", "b.js"]);
});

test("syntax-check validates files with node --check", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aipickd-syntax-"));
  const ok = path.join(dir, "ok.js");
  const bad = path.join(dir, "bad.js");
  fs.writeFileSync(ok, "const a = 1;\n");
  fs.writeFileSync(bad, "const = ;\n");

  assert.equal(checkFileSyntax(ok).ok, true);
  const result = checkFileSyntax(bad);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /SyntaxError|Unexpected/);
});
