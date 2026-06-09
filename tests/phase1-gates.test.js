const { test } = require("node:test");
const assert = require("node:assert/strict");

const { hasWriteFlag } = require("../scripts/lib/cli-safety");
const { appendUtm, buildLocalizedCta } = require("../scripts/lib/cta");
const {
  filterCandidatesByLanguage,
  buildRelatedBlock,
} = require("../scripts/lib/internal-linking");
const { filterPipelineKeywords, keywordStateForArticle } = require("../scripts/lib/spanish-gate");
const { buildRecoveryPublishPlan } = require("../scripts/lib/recovery-publisher");
const {
  cleanupAiTellPhrases,
  detectAiTellPhrases,
  qualityGate,
} = require("../scripts/lib/quality");

test("cli safety: mutating scripts are dry/report-only unless an explicit write flag is present", () => {
  assert.equal(hasWriteFlag([]), false);
  assert.equal(hasWriteFlag(["--dry-run"]), false);
  assert.equal(hasWriteFlag(["--limit", "1"]), false);
  assert.equal(hasWriteFlag(["--go"]), true);
  assert.equal(hasWriteFlag(["--fix"]), true);
  assert.equal(hasWriteFlag(["--apply"]), true);
  assert.equal(hasWriteFlag(["--confirm"]), true);
});

test("spanish gate: cron excludes Spanish keywords unless flag or config gate is enabled", () => {
  const rows = [
    { id: "en-1", keyword: "best ai tools", language: "en" },
    { id: "es-1", keyword: "mejor ia para tareas", language: "es" },
  ];

  assert.deepEqual(
    filterPipelineKeywords(rows, { includeEs: false, spanishPipelineEnabled: false }).map(
      (r) => r.id
    ),
    ["en-1"]
  );
  assert.deepEqual(
    filterPipelineKeywords(rows, { includeEs: true, spanishPipelineEnabled: false }).map(
      (r) => r.id
    ),
    ["en-1", "es-1"]
  );
  assert.deepEqual(
    filterPipelineKeywords(rows, { includeEs: false, spanishPipelineEnabled: true }).map(
      (r) => r.id
    ),
    ["en-1", "es-1"]
  );
});

test("keyword state follows article publication truth", () => {
  assert.equal(
    keywordStateForArticle({ status: "draft", wp_post_id: null, wp_url: null }),
    "generated"
  );
  assert.equal(keywordStateForArticle({ status: "qa_failed" }), "qa_failed");
  assert.equal(
    keywordStateForArticle({
      status: "published",
      wp_post_id: 123,
      wp_url: "https://aipickd.com/es/foo/",
    }),
    "published"
  );
  assert.equal(
    keywordStateForArticle({ status: "published", wp_post_id: null, wp_url: null }),
    "generated"
  );
});

test("recovery publish plan preserves language and reports all non-writing actions", () => {
  const plan = buildRecoveryPublishPlan({
    id: "article-1",
    title: "Mejor IA para hacer tareas",
    slug: "mejor-ia-para-hacer-tareas",
    language: "es",
    status: "draft",
    content_markdown:
      "Intro con mejor ia para hacer tareas.\n\n## Seccion uno\nTexto.\n\n## Seccion dos\nTexto.\n\n## Seccion tres\nTexto.\n\n## Seccion cuatro\nTexto.\n\n## Seccion cinco\nTexto.\n\n## FAQ\n### Que es?\nRespuesta suficiente.",
    primary_keyword: "mejor ia para hacer tareas",
    word_count: 1250,
  });

  assert.equal(plan.willWrite, false);
  assert.equal(plan.language, "es");
  assert.deepEqual(plan.wpMeta, { _pipeline_lang: "es" });
  assert.match(plan.disclosure, /enlaces de afiliado/i);
  assert.match(plan.idempotencyKey, /^[a-f0-9]{32}$/);
  assert.equal(typeof plan.qa.pass, "boolean");
  assert.equal(plan.schema.action, "inject");
  assert.equal(plan.indexNow.action, "submit-after-publish");
});

test("appendUtm preserves existing query strings", () => {
  assert.equal(
    appendUtm("https://example.com/product?ref=abc", {
      utm_source: "aipickd",
      utm_medium: "cta",
    }),
    "https://example.com/product?ref=abc&utm_source=aipickd&utm_medium=cta"
  );
});

test("CTA copy localizes to Spanish", () => {
  const html = buildLocalizedCta({
    brand: "Jasper",
    baseUrl: "https://example.com/?ref=abc",
    slug: "mejor-ia",
    language: "es",
  });
  assert.match(html, /Listo para probarlo/i);
  assert.match(html, /utm_source=aipickd/);
  assert.match(html, /ref=abc&utm_source/);
});

test("internal links are same-language by default and do not use nofollow", () => {
  const source = { id: "a", language: "es" };
  const related = filterCandidatesByLanguage(source, [
    { id: "b", title: "ES target", language: "es", wp_url: "https://aipickd.com/es/b/" },
    { id: "c", title: "EN target", language: "en", wp_url: "https://aipickd.com/c/" },
  ]);

  assert.deepEqual(
    related.map((r) => r.id),
    ["b"]
  );
  const block = buildRelatedBlock(related, { language: "es" });
  assert.match(block, /Articulos relacionados/);
  assert.doesNotMatch(block, /nofollow/i);
});

test("AI-tell cleanup removes common phrases and QA blocks any leftovers clearly", () => {
  const articleBody = [
    "# Top 10 AI-Powered Blog Writing Tools Ranked for 2026",
    "",
    "In today's digital landscape, teams want a game-changer that can unlock better drafts.",
    "This cutting-edge workflow can feel seamless, but a robust solution still needs editing.",
    "Let's dive in and delve into how to harness the power of each powerful tool.",
    "The goal is not to revolutionize your process or elevate every paragraph overnight.",
    "",
    "## FAQ",
    "### What should buyers check first?",
    "Start with output quality, pricing, and editorial controls.",
  ].join("\n");

  const detected = detectAiTellPhrases(articleBody);
  assert.ok(detected.length >= 7, `expected 7+ AI-tells, got ${detected.length}`);

  const cleaned = cleanupAiTellPhrases(articleBody);
  assert.equal(detectAiTellPhrases(cleaned.text).length, 0);

  const qa = qualityGate({
    content_markdown: articleBody,
    language: "en",
    word_count: 1200,
  });
  const aiTellIssue = qa.issues.find((issue) => issue.code === "ai_tells");
  assert.ok(aiTellIssue, "QA should block uncleaned AI-tell clusters");
  assert.match(aiTellIssue.message, /AI-tell phrases/);
  assert.equal(aiTellIssue.repairable, true);
});
