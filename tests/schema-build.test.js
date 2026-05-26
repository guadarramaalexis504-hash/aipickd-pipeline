const { test } = require("node:test");
const assert = require("node:assert/strict");

// We have to re-export buildSchema for testability. The script file
// is structured as a CLI tool, so we use a minimal re-implementation
// here that mirrors the public contract — these tests document the
// expected shape and will fail fast if someone breaks the schema
// emission downstream.
//
// If add-schema-markup.js ever extracts buildSchema into lib/, swap
// this require for the real one.

// For now, dynamically require + eval the function via a tiny test
// shim so tests stay close to the actual implementation.
const fs = require("node:fs");
const path = require("node:path");
const src = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "add-schema-markup.js"),
  "utf8"
);
// Pull just the buildSchema function definition out for evaluation.
const fnMatch = src.match(/function buildSchema\([\s\S]*?\n^}/m);
assert.ok(fnMatch, "could not locate buildSchema in add-schema-markup.js");
// Make it available in this scope.
// eslint-disable-next-line no-eval
const buildSchema = eval(`(${fnMatch[0].replace(/^function /, "function ")})`);

const fakeWpPost = {
  link: "https://aipickd.com/best-ai-writing-tools-2026/",
  date: "2026-05-25T10:00:00Z",
  modified: "2026-05-25T10:00:00Z",
};

test("review article returns Review schema with itemReviewed", () => {
  const out = buildSchema(
    { article_type: "review", title: "Jasper AI Review 2026", meta_description: "..." },
    fakeWpPost
  );
  const arr = Array.isArray(out) ? out : [out];
  const base = arr[0];
  assert.equal(base["@type"], "Review");
  assert.ok(base.itemReviewed);
  assert.equal(base.itemReviewed["@type"], "SoftwareApplication");
});

test("comparison article returns Review schema", () => {
  const out = buildSchema(
    { article_type: "comparison", title: "Jasper vs Writesonic 2026", meta_description: "..." },
    fakeWpPost
  );
  const arr = Array.isArray(out) ? out : [out];
  assert.equal(arr[0]["@type"], "Review");
});

test("listicle emits Article + ItemList", () => {
  const out = buildSchema(
    { article_type: "listicle", title: "Top 10 AI Writing Tools 2026", meta_description: "..." },
    fakeWpPost
  );
  assert.ok(Array.isArray(out));
  assert.equal(out[0]["@type"], "Article");
  assert.equal(out[1]["@type"], "ItemList");
  assert.equal(out[1].itemListOrder, "https://schema.org/ItemListOrderDescending");
});

test("title starting with 'Best' also triggers ItemList", () => {
  const out = buildSchema(
    { article_type: "guide", title: "Best AI Coding Assistants 2026", meta_description: "..." },
    fakeWpPost
  );
  assert.ok(Array.isArray(out));
  assert.ok(out.some((s) => s["@type"] === "ItemList"));
});

test("how-to article emits Article + HowTo", () => {
  const out = buildSchema(
    { article_type: "how-to", title: "How to Use Jasper AI Effectively", meta_description: "..." },
    fakeWpPost
  );
  assert.ok(Array.isArray(out));
  assert.ok(out.some((s) => s["@type"] === "HowTo"));
  const howto = out.find((s) => s["@type"] === "HowTo");
  assert.ok(Array.isArray(howto.step));
});

test("plain article returns single object (back-compat)", () => {
  const out = buildSchema(
    { article_type: "article", title: "Some Generic Article", meta_description: "..." },
    fakeWpPost
  );
  assert.equal(Array.isArray(out), false);
  assert.equal(out["@type"], "Article");
});

test("base schema has all required Article fields", () => {
  const out = buildSchema(
    { article_type: "article", title: "X", meta_description: "Y" },
    fakeWpPost
  );
  const base = Array.isArray(out) ? out[0] : out;
  assert.ok(base.headline);
  assert.ok(base.image);
  assert.ok(base.datePublished);
  assert.ok(base.dateModified);
  assert.ok(base.author);
  assert.ok(base.publisher);
  assert.equal(base.image["@type"], "ImageObject");
});
