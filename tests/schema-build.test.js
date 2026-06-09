const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSchemas } = require("../scripts/lib/schema");

const fakeOpts = {
  url: "https://aipickd.com/best-ai-writing-tools-2026/",
  datePublished: "2026-05-25T10:00:00Z",
  dateModified: "2026-05-25T10:00:00Z",
};

test("review article returns Review schema with itemReviewed", () => {
  const out = buildSchemas(
    { article_type: "review", title: "Jasper AI Review 2026", meta_description: "..." },
    fakeOpts
  );
  const base = out[0];
  assert.equal(base["@type"], "Review");
  assert.ok(base.itemReviewed);
  assert.equal(base.itemReviewed["@type"], "SoftwareApplication");
});

test("comparison article returns Article schema plus ItemList", () => {
  const out = buildSchemas(
    { article_type: "comparison", title: "Jasper vs Writesonic 2026", meta_description: "..." },
    fakeOpts
  );
  assert.equal(out[0]["@type"], "Article");
  assert.ok(out.some((schema) => schema["@type"] === "ItemList"));
});

test("listicle emits Article plus ItemList", () => {
  const out = buildSchemas(
    { article_type: "listicle", title: "Top 10 AI Writing Tools 2026", meta_description: "..." },
    fakeOpts
  );
  assert.ok(Array.isArray(out));
  assert.equal(out[0]["@type"], "Article");
  assert.ok(out.some((schema) => schema["@type"] === "ItemList"));
});

test("title starting with Best also triggers ItemList", () => {
  const out = buildSchemas(
    { article_type: "guide", title: "Best AI Coding Assistants 2026", meta_description: "..." },
    fakeOpts
  );
  assert.ok(out.some((schema) => schema["@type"] === "ItemList"));
});

test("how-to article emits Article plus HowTo when real steps exist", () => {
  const out = buildSchemas(
    {
      article_type: "how-to",
      title: "How to Use Jasper AI Effectively",
      meta_description: "...",
      content_markdown:
        "## Step 1: Create a prompt\nWrite the workflow goal.\n\n## Step 2: Review output\nCheck the result before publishing.",
    },
    fakeOpts
  );
  assert.ok(out.some((schema) => schema["@type"] === "HowTo"));
  const howto = out.find((schema) => schema["@type"] === "HowTo");
  assert.equal(howto.step.length, 2);
});

test("plain article returns schema array with Article base", () => {
  const out = buildSchemas(
    { article_type: "article", title: "Some Generic Article", meta_description: "..." },
    fakeOpts
  );
  assert.ok(Array.isArray(out));
  assert.equal(out[0]["@type"], "Article");
});

test("base schema has required Article fields and image when configured", () => {
  const out = buildSchemas(
    { article_type: "article", title: "X", meta_description: "Y" },
    { ...fakeOpts, imageUrl: "https://aipickd.com/example.jpg" }
  );
  const base = out[0];
  assert.ok(base.headline);
  assert.ok(base.image);
  assert.ok(base.datePublished);
  assert.ok(base.dateModified);
  assert.ok(base.author);
  assert.ok(base.publisher);
  assert.equal(base.image["@type"], "ImageObject");
});
