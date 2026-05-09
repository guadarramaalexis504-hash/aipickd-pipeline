const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseEnvFile, loadEnv, require: requireEnv } = require("../scripts/lib/env");

test("parseEnvFile: handles unquoted, double-quoted, single-quoted", () => {
  const out = parseEnvFile(["FOO=bar", 'BAZ="hello world"', "QUX='single quoted'"].join("\n"));
  assert.equal(out.FOO, "bar");
  assert.equal(out.BAZ, "hello world");
  assert.equal(out.QUX, "single quoted");
});

test("parseEnvFile: handles escaped quotes inside double quotes", () => {
  const out = parseEnvFile('FOO="say \\"hi\\""');
  assert.equal(out.FOO, 'say "hi"');
});

test("parseEnvFile: handles values containing equal signs", () => {
  const out = parseEnvFile('TOKEN="abc=def=ghi"');
  assert.equal(out.TOKEN, "abc=def=ghi");
});

test("parseEnvFile: skips comments and blank lines", () => {
  const out = parseEnvFile(
    ["# comment", "", "FOO=bar", "  # indented comment", "BAZ=qux"].join("\n")
  );
  assert.deepEqual(out, { FOO: "bar", BAZ: "qux" });
});

test("parseEnvFile: ignores invalid keys", () => {
  const out = parseEnvFile("123BAD=x\nGOOD=y");
  assert.equal(out["123BAD"], undefined);
  assert.equal(out.GOOD, "y");
});

test("loadEnv: process.env takes precedence over file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
  const envPath = path.join(tmp, ".env");
  fs.writeFileSync(envPath, 'FROM_FILE="file-value"\nOVERRIDDEN="from-file"');

  process.env.OVERRIDDEN = "from-process";
  const env = loadEnv({ envPath, refresh: true });

  assert.equal(env.FROM_FILE, "file-value");
  assert.equal(env.OVERRIDDEN, "from-process");

  delete process.env.OVERRIDDEN;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("loadEnv: works without a .env file", () => {
  const env = loadEnv({ envPath: "/nonexistent/.env", refresh: true });
  assert.equal(env.PATH !== undefined, true);
});

test("require: throws ENV_MISSING when keys absent", () => {
  loadEnv({ envPath: "/nonexistent/.env", refresh: true });
  delete process.env.__TEST_REQUIRED_KEY;
  try {
    requireEnv(["__TEST_REQUIRED_KEY"]);
    assert.fail("should have thrown");
  } catch (e) {
    assert.equal(e.code, "ENV_MISSING");
    assert.deepEqual(e.missing, ["__TEST_REQUIRED_KEY"]);
  }
});

test("require: returns env when all keys present", () => {
  process.env.__TEST_REQUIRED_KEY = "ok";
  loadEnv({ envPath: "/nonexistent/.env", refresh: true });
  const env = requireEnv(["__TEST_REQUIRED_KEY"]);
  assert.equal(env.__TEST_REQUIRED_KEY, "ok");
  delete process.env.__TEST_REQUIRED_KEY;
});
