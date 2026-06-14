"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { SPANISH_TITLE_BLOCK, SPANISH_META_BLOCK, spanishSlugify } = require("../scripts/lib/spanish-ctr");

test("spanishSlugify strips accents and ñ for URL-safe slugs", () => {
  assert.equal(spanishSlugify("Comparación: ChatGPT vs Géminis ¿Cuál gana en 2026?"), "comparacion-chatgpt-vs-geminis-cual-gana-en-2026");
  assert.equal(spanishSlugify("Mejor IA para diseñar logos en 2026"), "mejor-ia-para-disenar-logos-en-2026");
});

test("spanishSlugify is idempotent on an already-clean slug", () => {
  const clean = "mejores-ias-para-crear-videos-2026";
  assert.equal(spanishSlugify(clean), clean);
});

test("spanishSlugify keeps the year and drops trailing punctuation", () => {
  assert.equal(spanishSlugify("¿Vale la pena pagar ChatGPT Plus? (2026)"), "vale-la-pena-pagar-chatgpt-plus-2026");
});

test("the Spanish CTR blocks are non-trivial and ASCII-safe", () => {
  assert.ok(SPANISH_TITLE_BLOCK.length > 1000);
  assert.ok(SPANISH_META_BLOCK.length > 400);
  // title block must ban fake first-person testing claims
  assert.match(SPANISH_TITLE_BLOCK, /Probamos|Probadas|Evaluamos/);
});
