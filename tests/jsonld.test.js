const { test } = require("node:test");
const assert = require("node:assert/strict");

const { validate, validateHtml } = require("../scripts/lib/jsonld");

test("validate: rejects non-object input", () => {
  assert.equal(validate(null).ok, false);
  assert.equal(validate(undefined).ok, false);
  assert.equal(validate("x").ok, false);
});

test("validate: missing @type", () => {
  const r = validate({ name: "x" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /@type/);
});

test("validate: unknown @type passes through with skipped flag", () => {
  const r = validate({ "@type": "WeirdThing" });
  assert.equal(r.ok, true);
  assert.ok(r.skipped);
});

// ── Article ──
test("Article: minimal valid", () => {
  const r = validate({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "Best AI Tools 2026",
    image: "https://example.com/img.jpg",
    datePublished: "2026-05-09T12:00:00Z",
    author: { "@type": "Person", name: "AIPickd" },
    publisher: { "@type": "Organization", name: "AIPickd" },
  });
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("Article: missing headline", () => {
  const r = validate({
    "@context": "https://schema.org",
    "@type": "Article",
    image: "x",
    datePublished: "2026-05-09",
    author: { name: "X" },
    publisher: { name: "X" },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /headline/.test(e)));
});

test("Article: headline too long flagged", () => {
  const r = validate({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "x".repeat(120),
    image: "x",
    datePublished: "2026-05-09",
    author: { name: "X" },
    publisher: { name: "X" },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /headline too long/.test(e)));
});

test("Article: invalid date format", () => {
  const r = validate({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "x",
    image: "x",
    datePublished: "yesterday",
    author: { name: "X" },
    publisher: { name: "X" },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /ISO 8601/.test(e)));
});

// ── Review ──
test("Review: valid", () => {
  const r = validate({
    "@type": "Review",
    itemReviewed: { "@type": "Product", name: "Jasper" },
    reviewRating: { "@type": "Rating", ratingValue: "4.5", bestRating: "5" },
    author: { "@type": "Person", name: "AIPickd" },
  });
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("Review: non-numeric rating flagged", () => {
  const r = validate({
    "@type": "Review",
    itemReviewed: "x",
    reviewRating: { ratingValue: "good" },
    author: "x",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /numeric/.test(e)));
});

// ── Product ──
test("Product: valid with offers", () => {
  const r = validate({
    "@type": "Product",
    name: "Jasper",
    offers: { "@type": "Offer", price: 49, priceCurrency: "USD" },
  });
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("Product: missing all rich-result options", () => {
  const r = validate({ "@type": "Product", name: "Jasper" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /offers\/aggregateRating\/review/.test(e)));
});

test("Product: offers missing currency", () => {
  const r = validate({
    "@type": "Product",
    name: "X",
    offers: [{ price: 10 }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /priceCurrency/.test(e)));
});

// ── FAQPage ──
test("FAQPage: valid", () => {
  const r = validate({
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What is X?",
        acceptedAnswer: { "@type": "Answer", text: "X is Y." },
      },
    ],
  });
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("FAQPage: empty mainEntity", () => {
  const r = validate({ "@type": "FAQPage", mainEntity: [] });
  assert.equal(r.ok, false);
});

test("FAQPage: question missing acceptedAnswer", () => {
  const r = validate({
    "@type": "FAQPage",
    mainEntity: [{ "@type": "Question", name: "?" }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /acceptedAnswer/.test(e)));
});

// ── BreadcrumbList ──
test("BreadcrumbList: valid", () => {
  const r = validate({
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://aipickd.com" },
      { "@type": "ListItem", position: 2, name: "Best AI Tools" },
    ],
  });
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("BreadcrumbList: missing position", () => {
  const r = validate({
    "@type": "BreadcrumbList",
    itemListElement: [{ "@type": "ListItem", name: "Home" }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /position/.test(e)));
});

// ── HTML scraper ──
test("validateHtml: extracts and validates multiple blocks", () => {
  const html = `
    <html><head>
      <script type="application/ld+json">{"@type":"Article","headline":"X","image":"i","datePublished":"2026-05-09","author":{"name":"X"},"publisher":{"name":"X"}}</script>
      <script type="application/ld+json">{"@type":"FAQPage","mainEntity":[]}</script>
    </head></html>
  `;
  const r = validateHtml(html);
  assert.equal(r.blocks.length, 2);
  assert.equal(r.blocks[0].type, "Article");
  assert.equal(r.blocks[0].ok, false); // missing @context
  assert.equal(r.blocks[1].type, "FAQPage");
  assert.equal(r.blocks[1].ok, false);
  assert.equal(r.ok, false);
});

test("validateHtml: handles JSON parse errors", () => {
  const html = `<script type="application/ld+json">{not json}</script>`;
  const r = validateHtml(html);
  assert.equal(r.ok, false);
  assert.equal(r.blocks[0].ok, false);
  assert.match(r.blocks[0].errors[0], /JSON parse/);
});

test("validateHtml: handles array payload", () => {
  const html = `<script type="application/ld+json">[
    {"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"x"},{"@type":"ListItem","position":2,"name":"Page"}]}
  ]</script>`;
  const r = validateHtml(html);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].ok, true, r.blocks[0].errors?.join("; "));
});
