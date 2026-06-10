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
const secondArticleId = "939a80da-9254-4c9a-bafc-141742fdc42a";
const keywordId = "ff36854c-ed82-4066-a737-3063869d0c8b";
const otherKeywordId = "11111111-1111-4111-8111-111111111111";

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

function secondDraftState(overrides = {}) {
  return goodState({
    article: {
      id: secondArticleId,
      keyword_id: keywordId,
      title: "7 Mejores IAs para Hacer Tareas en 2026 [Probadas]",
      slug: "mejor-ia-para-hacer-tareas-2026",
      status: "draft",
      language: "es",
      wp_post_id: null,
      wp_url: null,
      qa_issues: [],
      repair_status: null,
      content_markdown: [
        "# 7 Mejores IAs para Hacer Tareas en 2026 [Probadas]",
        "",
        "## Quick Picks: las campeonas",
        "Probamos en proyectos reales y vimos mejoras de 30%-40%.",
        "",
        "## [Herramienta 1]: Zapier",
        "A octubre 2023, Zapier era una opcion frecuente.",
        "",
        "## Jasper AI",
        "Ayuda con textos.",
        "",
        "## Monday.com",
        "Organiza tareas.",
        "",
        "## ClickUp",
        "Centraliza proyectos.",
        "",
        "## Writesonic",
        "Genera borradores.",
        "",
        "## Preguntas frecuentes",
        "### Cual IA conviene?",
        "Depende del tipo de tarea, precio e idioma.",
      ].join("\n"),
    },
    keyword: {
      id: keywordId,
      keyword: "mejor ia para hacer tareas",
      status: "generated",
      language: "es",
      assigned_article_id: secondArticleId,
    },
    ...overrides,
  });
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

test("regeneration preflight accepts the second unpublished Spanish draft when QA blockers are detectable", () => {
  const state = secondDraftState();
  const result = validateRegenerationPreflight({
    ...state,
    articleId: secondArticleId,
    keywordId,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.ok(result.reasons.some((reason) => reason.code === "placeholder_terms"));
  assert.ok(result.reasons.some((reason) => reason.code === "english_residual"));
  assert.ok(result.reasons.some((reason) => reason.code === "list_count_mismatch"));
  assert.ok(result.reasons.some((reason) => reason.code === "stale_reference"));
  assert.ok(result.reasons.some((reason) => reason.code === "unsupported_claim"));
});

test("regeneration preflight rejects an unrelated article id", () => {
  const state = secondDraftState();
  const result = validateRegenerationPreflight({
    ...state,
    articleId: "22222222-2222-4222-8222-222222222222",
    keywordId,
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /article.id must be 22222222/);
  assert.match(result.issues.join("\n"), /keyword.assigned_article_id must be 22222222/);
});

test("regeneration preflight rejects an unapproved keyword id", () => {
  const state = secondDraftState({
    article: {
      ...secondDraftState().article,
      keyword_id: otherKeywordId,
    },
    keyword: {
      id: otherKeywordId,
      keyword: "otra keyword",
      status: "generated",
      language: "es",
      assigned_article_id: secondArticleId,
    },
  });

  const result = validateRegenerationPreflight({
    ...state,
    articleId: secondArticleId,
    keywordId: otherKeywordId,
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /keyword_id must be approved keyword/);
});

test("regeneration preflight rejects published articles", () => {
  const state = secondDraftState({
    article: {
      ...secondDraftState().article,
      status: "published",
      wp_post_id: 1828,
      wp_url: "https://aipickd.com/es/mejor-ia-para-hacer-tareas-2026/",
    },
  });

  const result = validateRegenerationPreflight({
    ...state,
    articleId: secondArticleId,
    keywordId,
  });

  assert.equal(result.ok, false);
  assert.match(
    result.issues.join("\n"),
    /article.status must be draft, needs_repair, or qa_failed/
  );
  assert.match(result.issues.join("\n"), /article.wp_post_id must be null/);
  assert.match(result.issues.join("\n"), /article.wp_url must be null/);
});

test("regeneration preflight rejects drafts without detectable QA or repair problems", () => {
  const cleanState = secondDraftState({
    article: {
      ...secondDraftState().article,
      title: "5 IAs para Hacer Tareas en 2026",
      qa_issues: [],
      repair_status: null,
      last_error: null,
      content_markdown: [
        "# 5 IAs para Hacer Tareas en 2026",
        "",
        "## ChatGPT",
        "Ayuda a explicar conceptos y redactar borradores.",
        "## Claude",
        "Resume textos largos y mejora explicaciones.",
        "## Gemini",
        "Responde dudas conectadas con busqueda.",
        "## Perplexity",
        "Sirve para investigar con enlaces visibles.",
        "## Notion AI",
        "Organiza apuntes y tareas.",
        "",
        "## Preguntas frecuentes",
        "### Cual IA conviene?",
        "Depende del tipo de tarea, precio e idioma.",
      ].join("\n"),
    },
  });

  const result = validateRegenerationPreflight({
    ...cleanState,
    articleId: secondArticleId,
    keywordId,
  });

  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /detectable regeneration reason/);
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
