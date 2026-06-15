"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const {
  pickRelatedArticles,
  buildRelatedBlock,
  injectRelatedBlock,
  MARK_START,
} = require("../scripts/lib/related-articles");

const corpus = [
  { id: "1", title: "Jasper vs Copy.ai (2026)", slug: "jasper-vs-copy-ai-2026", language: "en", wp_url: "https://aipickd.com/jasper-vs-copy-ai-2026/", niche_id: "writing", primary_keyword: "jasper vs copy", published_at: "2026-06-01" },
  { id: "2", title: "Best AI Writing Tools (2026)", slug: "best-ai-writing-tools-2026", language: "en", wp_url: "https://aipickd.com/best-ai-writing-tools-2026/", niche_id: "writing", primary_keyword: "ai writing tools", published_at: "2026-06-02" },
  { id: "3", title: "Cursor vs Copilot (2026)", slug: "cursor-vs-copilot-2026", language: "en", wp_url: "https://aipickd.com/cursor-vs-copilot-2026/", niche_id: "coding", primary_keyword: "cursor vs copilot", published_at: "2026-06-03" },
  { id: "4", title: "Mejores IA para escribir (2026)", slug: "mejores-ia-escribir-2026", language: "es", wp_url: "https://aipickd.com/es/mejores-ia-escribir-2026/", niche_id: "writing", primary_keyword: "ia para escribir", published_at: "2026-06-04" },
];

test("picks same-language related articles only", () => {
  const article = corpus[0]; // EN
  const related = pickRelatedArticles(article, corpus, 4);
  assert.ok(related.length >= 1);
  assert.ok(related.every((r) => r.language === "en"));
  assert.ok(related.every((r) => r.id !== article.id));
});

test("prefers same-niche / topical overlap (writing before coding)", () => {
  const related = pickRelatedArticles(corpus[0], corpus, 3);
  const ids = related.map((r) => r.id);
  // article 2 (same niche 'writing') should rank above article 3 ('coding')
  assert.ok(ids.indexOf("2") < ids.indexOf("3") || !ids.includes("3"));
});

test("buildRelatedBlock localizes the heading for Spanish", () => {
  const enBlock = buildRelatedBlock([corpus[1]], "en");
  const esBlock = buildRelatedBlock([corpus[3]], "es");
  assert.match(enBlock, /Related articles/);
  assert.match(esBlock, /Artículos relacionados/);
});

test("buildRelatedBlock is empty when there are no related articles", () => {
  assert.equal(buildRelatedBlock([], "en"), "");
});

test("injectRelatedBlock appends once and refreshes on re-run (idempotent)", () => {
  const block1 = buildRelatedBlock([corpus[1]], "en");
  const first = injectRelatedBlock("<p>body</p>", block1);
  assert.ok(first.changed);
  assert.ok(first.html.includes(MARK_START));
  // Re-running with a new block should replace, not duplicate.
  const block2 = buildRelatedBlock([corpus[2]], "en");
  const second = injectRelatedBlock(first.html, block2);
  const occurrences = (second.html.match(new RegExp(MARK_START, "g")) || []).length;
  assert.equal(occurrences, 1);
  assert.ok(second.html.includes("Cursor vs Copilot"));
  assert.ok(!second.html.includes("Best AI Writing Tools"));
});

test("injectRelatedBlock does NOT append when a different-format related block exists", () => {
  // internal-links.js writes this div variant; we must not add a second block.
  const existing = '<p>body</p>\n<div class="aipickd-related"><h3>Related</h3></div>';
  const block = buildRelatedBlock([corpus[1]], "en");
  const out = injectRelatedBlock(existing, block);
  assert.equal(out.changed, false);
  assert.equal(out.html, existing);
});

test("escapes HTML in titles", () => {
  const block = buildRelatedBlock(
    [{ title: "A & B <script>", slug: "x", wp_url: "https://aipickd.com/x/", language: "en" }],
    "en"
  );
  assert.ok(block.includes("A &amp; B &lt;script&gt;"));
});
