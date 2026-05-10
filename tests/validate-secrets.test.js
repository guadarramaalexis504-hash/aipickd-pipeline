const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "scripts", "validate-secrets.js");

function run(env) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
}

const VALID = {
  SUPABASE_URL: "https://abcdef123.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "eyJ" + "a".repeat(150),
  OPENAI_API_KEY: "sk-proj-" + "A".repeat(60),
  WP_USERNAME: "admin@aipickd.com",
  WP_ADMIN_PASSWORD: "abcd efgh ijkl mnop qrst uvwx",
};

test("validate-secrets: passes with all valid values", () => {
  const r = run(VALID);
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
});

test("validate-secrets: fails on missing required key", () => {
  const env = { ...VALID };
  delete env.OPENAI_API_KEY;
  const r = run(env);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /OPENAI_API_KEY/);
});

test("validate-secrets: fails on malformed Supabase URL", () => {
  const r = run({ ...VALID, SUPABASE_URL: "http://evil.com" });
  assert.notEqual(r.status, 0);
});

test("validate-secrets: fails on malformed OpenAI key", () => {
  const r = run({ ...VALID, OPENAI_API_KEY: "not-a-key" });
  assert.notEqual(r.status, 0);
});

test("validate-secrets: rejects bad Discord webhook", () => {
  const r = run({ ...VALID, DISCORD_WEBHOOK_URL: "http://evil.example.com/hook" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /DISCORD_WEBHOOK_URL/);
});

test("validate-secrets: accepts valid Discord webhook", () => {
  const r = run({
    ...VALID,
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/abc",
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
});

test("validate-secrets: warns on non-application-password format", () => {
  const r = run({ ...VALID, WP_ADMIN_PASSWORD: "shortpass" });
  assert.notEqual(r.status, 0);
});
