const { test } = require("node:test");
const assert = require("node:assert/strict");

const { assertHostAllowed, fetchWithRetry } = require("../scripts/lib/http");

test("assertHostAllowed: default list includes openai/discord/wp", () => {
  assertHostAllowed("https://api.openai.com/v1/chat", null);
  assertHostAllowed("https://discord.com/api/webhooks/x", null);
  assertHostAllowed("https://aipickd.com/wp-json/wp/v2/posts", null);
});

test("assertHostAllowed: blocks unknown host", () => {
  assert.throws(
    () => assertHostAllowed("https://evil.example.com/exfil", null),
    (err) => {
      assert.equal(err.code, "HOST_NOT_ALLOWED");
      assert.equal(err.host, "evil.example.com");
      return true;
    }
  );
});

test("assertHostAllowed: subdomains of allowlisted hosts pass", () => {
  // .discord.com matches discord.com via the suffix rule
  assertHostAllowed("https://canary.discord.com/api/x", null);
});

test("assertHostAllowed: explicit allowedHosts overrides defaults", () => {
  assertHostAllowed("https://only-this.com/x", ["only-this.com"]);
  assert.throws(() => assertHostAllowed("https://api.openai.com/x", ["only-this.com"]));
});

test("assertHostAllowed: '*' disables the check", () => {
  assertHostAllowed("https://anywhere.example/x", ["*"]);
});

test("assertHostAllowed: HTTP_ALLOWED_HOSTS env overrides default", () => {
  const before = process.env.HTTP_ALLOWED_HOSTS;
  process.env.HTTP_ALLOWED_HOSTS = "supabase.co,aipickd.com";
  try {
    assertHostAllowed("https://abc.supabase.co/x");
    assertHostAllowed("https://aipickd.com/x");
    assert.throws(() => assertHostAllowed("https://api.openai.com/x"));
  } finally {
    if (before === undefined) delete process.env.HTTP_ALLOWED_HOSTS;
    else process.env.HTTP_ALLOWED_HOSTS = before;
  }
});

test("assertHostAllowed: rejects malformed URL", () => {
  assert.throws(() => assertHostAllowed("not-a-url"));
});

test("fetchWithRetry: refuses disallowed host before any network call", async () => {
  await assert.rejects(
    () => fetchWithRetry("https://malicious.example/data"),
    (err) => err.code === "HOST_NOT_ALLOWED"
  );
});
