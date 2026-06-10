const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildReleaseKeywordEndpoint,
  parseReleaseOptions,
  resolveBridgeVerification,
  selectKeywordsForRelease,
  validatePipelineConfig,
} = require("../scripts/release-es-keywords");

const studyComparisonKeywordId = "58a4cb28-0a04-4c19-aa1d-0e676335301e";

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
  {
    id: studyComparisonKeywordId,
    keyword: "chatgpt vs claude vs gemini para estudiar",
    language: "es",
    status: "es_hold",
    priority: 100,
    search_volume: 880,
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

test("release-es can target one explicit Spanish smoke keyword", () => {
  const options = parseReleaseOptions(["--limit", "5", "--keyword-id", studyComparisonKeywordId]);
  const selected = selectKeywordsForRelease(keywordRows, options);
  const endpoint = buildReleaseKeywordEndpoint(options);

  assert.equal(options.keywordId, studyComparisonKeywordId);
  assert.equal(options.effectiveLimit, 1);
  assert.deepEqual(
    selected.map((keyword) => keyword.id),
    [studyComparisonKeywordId]
  );
  assert.match(endpoint, new RegExp(`id=eq\\.${studyComparisonKeywordId}`));
  assert.match(endpoint, /status=eq\.es_hold/);
  assert.match(endpoint, /language=eq\.es/);
  assert.match(endpoint, /assigned_article_id=is\.null/);
});

test("release-es rejects invalid explicit keyword ids", () => {
  assert.throws(() => parseReleaseOptions(["--keyword-id", "not-a-uuid"]), /valid UUID/);
});

test("release-es blocks writes when Spanish pipeline is globally enabled", () => {
  assert.deepEqual(validatePipelineConfig({ spanish_pipeline_enabled: false }), {
    ok: true,
    reason: "pipeline_config.spanish_pipeline_enabled=false",
  });
  assert.deepEqual(validatePipelineConfig({ spanish_pipeline_enabled: true }), {
    ok: false,
    reason: "pipeline_config.spanish_pipeline_enabled must remain false",
  });
});
