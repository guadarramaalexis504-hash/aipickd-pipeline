const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildQueuedKeywordEndpoint,
  parseOnlyKeywordId,
  selectPipelineKeywords,
} = require("../scripts/lib/pipeline-keywords");

const spanishKeywordId = "ff36854c-ed82-4066-a737-3063869d0c8b";

test("--only-keyword-id filters to the exact Spanish keyword", () => {
  const rows = [
    { id: "11111111-1111-4111-8111-111111111111", keyword: "best ai tools", language: "en" },
    { id: spanishKeywordId, keyword: "mejor ia para hacer tareas", language: "es" },
  ];

  const selected = selectPipelineKeywords(rows, {
    includeEs: true,
    spanishPipelineEnabled: false,
    onlyKeywordId: spanishKeywordId,
  });

  assert.deepEqual(
    selected.map((row) => row.id),
    [spanishKeywordId]
  );
});

test("--only-keyword-id does not take an English keyword by accident", () => {
  const rows = [
    { id: "11111111-1111-4111-8111-111111111111", keyword: "best ai tools", language: "en" },
    { id: spanishKeywordId, keyword: "mejor ia para hacer tareas", language: "es" },
  ];

  const selected = selectPipelineKeywords(rows, {
    includeEs: true,
    spanishPipelineEnabled: false,
    onlyKeywordId: spanishKeywordId,
  });

  assert.equal(
    selected.some((row) => row.language === "en"),
    false
  );
});

test("--only-keyword-id keeps Spanish gate protections unless include-es is passed", () => {
  const selected = selectPipelineKeywords(
    [{ id: spanishKeywordId, keyword: "mejor ia para hacer tareas", language: "es" }],
    { includeEs: false, spanishPipelineEnabled: false, onlyKeywordId: spanishKeywordId }
  );

  assert.deepEqual(selected, []);
});

test("queued keyword endpoint targets the exact keyword when --only-keyword-id is set", () => {
  const endpoint = buildQueuedKeywordEndpoint({ onlyKeywordId: spanishKeywordId });

  assert.match(endpoint, new RegExp(`id=eq\\.${spanishKeywordId}`));
  assert.match(endpoint, /status=eq\.queued/);
  assert.match(endpoint, /assigned_article_id=is\.null/);
  assert.match(endpoint, /limit=1/);
  assert.doesNotMatch(endpoint, /order=priority/);
});

test("parseOnlyKeywordId requires a valid UUID value", () => {
  assert.equal(parseOnlyKeywordId(["--only-keyword-id", spanishKeywordId]), spanishKeywordId);
  assert.throws(() => parseOnlyKeywordId(["--only-keyword-id"]), /requires a UUID/);
  assert.throws(() => parseOnlyKeywordId(["--only-keyword-id", "not-a-uuid"]), /valid UUID/);
});
