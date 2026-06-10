const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildKeywordResetPatch,
  buildOldArticleFailurePatch,
  buildRunPipelineArgs,
  countPlaceholderMatches,
  validateRegenerationPreflight,
} = require("../scripts/lib/regenerate-draft");

const articleId = "62e72631-6267-46ec-ae97-05da5e5c715a";
const keywordId = "ff36854c-ed82-4066-a737-3063869d0c8b";

function goodState(overrides = {}) {
  return {
    article: {
      id: articleId,
      keyword_id: keywordId,
      title: "7 Mejores IAs para Hacer Tareas que Probe en 2026",
      slug: "mejor-ia-para-hacer-tareas-2026",
      status: "draft",
      language: "es",
      wp_post_id: null,
      wp_url: null,
      content_markdown: "Tool A hace matematicas. Tool B redacta. Tool C resume.",
    },
    keyword: {
      id: keywordId,
      keyword: "mejor ia para hacer tareas",
      status: "generated",
      language: "es",
      assigned_article_id: articleId,
    },
    config: {
      paused: false,
      spanish_pipeline_enabled: false,
    },
    ...overrides,
  };
}

test("regeneration preflight passes only for the exact unpublished Spanish draft and keyword", () => {
  const state = goodState();
  const result = validateRegenerationPreflight({
    ...state,
    articleId,
    keywordId,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);

  const published = validateRegenerationPreflight({
    ...goodState({ article: { ...state.article, wp_post_id: 123 } }),
    articleId,
    keywordId,
  });
  assert.equal(published.ok, false);
  assert.match(published.issues.join("\n"), /wp_post_id must be null/);

  const enabled = validateRegenerationPreflight({
    ...goodState({ config: { paused: false, spanish_pipeline_enabled: true } }),
    articleId,
    keywordId,
  });
  assert.equal(enabled.ok, false);
  assert.match(enabled.issues.join("\n"), /spanish_pipeline_enabled must be false/);
});

test("regeneration refuses drafts without placeholders", () => {
  const matches = countPlaceholderMatches(
    "ChatGPT hace matematicas. Claude redacta. Gemini resume."
  );

  assert.equal(matches.count, 0);
  assert.equal(matches.summary.length, 0);
});

test("old draft failure patch blocks publish and retires slug before rerun", () => {
  const state = goodState();
  const matches = countPlaceholderMatches(state.article.content_markdown);
  const patch = buildOldArticleFailurePatch({
    article: state.article,
    placeholderMatches: matches.matches,
    now: new Date("2026-06-10T02:00:00.000Z"),
  });

  assert.equal(patch.status, "qa_failed");
  assert.equal(patch.wp_post_id, null);
  assert.equal(patch.wp_url, null);
  assert.equal(patch.quality_score, 0);
  assert.equal(patch.repair_status, "regenerate_from_scratch");
  assert.equal(patch.slug, "mejor-ia-para-hacer-tareas-2026-qa-failed-20260610t020000");
  assert.equal(patch.qa_issues[0].code, "placeholder_terms");
  assert.match(patch.qa_issues[0].message, /3 placeholder term/);
});

test("keyword reset and pipeline command stay scoped to one Spanish draft", () => {
  assert.deepEqual(buildKeywordResetPatch({ now: new Date("2026-06-10T02:00:00.000Z") }), {
    status: "queued",
    assigned_article_id: null,
    updated_at: "2026-06-10T02:00:00.000Z",
  });

  assert.deepEqual(buildRunPipelineArgs(keywordId), [
    "scripts/run-pipeline.js",
    "--gen",
    "1",
    "--include-es",
    "--no-pub",
    "--only-keyword-id",
    keywordId,
  ]);
});
