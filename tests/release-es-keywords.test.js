const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseReleaseOptions,
  resolveBridgeVerification,
  selectKeywordsForRelease,
} = require("../scripts/release-es-keywords");

const keywordRows = [
  {
    id: "ff36854c-ed82-4066-a737-3063869d0c8b",
    keyword: "mejor ia para hacer tareas",
    language: "es",
    status: "es_hold",
    priority: 1000,
    search_volume: 2400,
  },
  {
    id: "second-es-keyword",
    keyword: "otra keyword es",
    language: "es",
    status: "es_hold",
    priority: 900,
    search_volume: 1000,
  },
];

test("release-es bridge: read-only probe without published ES evidence remains blocked", () => {
  const options = parseReleaseOptions(["--limit", "1"]);
  const bridge = resolveBridgeVerification(options, { readOnlyVerified: false });

  assert.equal(bridge.verified, false);
  assert.match(bridge.reason, /read-only/i);
  assert.match(bridge.reason, /explicit bridge evidence/i);
});

test("release-es bridge: --go without explicit bridge evidence remains blocked", () => {
  const options = parseReleaseOptions(["--limit", "1", "--go"]);
  const bridge = resolveBridgeVerification(options, { readOnlyVerified: false });

  assert.equal(options.go, true);
  assert.equal(bridge.verified, false);
  assert.match(bridge.reason, /blocked/i);
});

test("release-es bridge: --go with bridge run evidence allows one keyword", () => {
  const options = parseReleaseOptions(["--limit", "5", "--go", "--bridge-run-id", "27241516739"]);
  const bridge = resolveBridgeVerification(options, { readOnlyVerified: false });
  const selected = selectKeywordsForRelease(keywordRows, options);

  assert.equal(bridge.verified, true);
  assert.match(bridge.source, /GitHub Actions run 27241516739/);
  assert.equal(options.effectiveLimit, 1);
  assert.deepEqual(
    selected.map((keyword) => keyword.id),
    ["ff36854c-ed82-4066-a737-3063869d0c8b"]
  );
});

test("release-es bridge: explicit confirmation evidence also caps release to one keyword", () => {
  const options = parseReleaseOptions([
    "--limit",
    "2",
    "--go",
    "--bridge-verified",
    "--confirm-bridge",
    "WP_LANGUAGE_BRIDGE_VERIFIED",
  ]);
  const bridge = resolveBridgeVerification(options, { readOnlyVerified: false });
  const selected = selectKeywordsForRelease(keywordRows, options);

  assert.equal(bridge.verified, true);
  assert.match(bridge.source, /explicit --bridge-verified/i);
  assert.equal(selected.length, 1);
});
