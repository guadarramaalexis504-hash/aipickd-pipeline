const { test } = require("node:test");
const assert = require("node:assert/strict");

const { validateRenderedHtml } = require("../scripts/lib/html-validator");

test("clean HTML returns no issues", () => {
  const html = `<p>Intro paragraph.</p>
<h2>Section one</h2>
<p>Some content with a <a href="https://example.com">link</a>.</p>
<table class="wp-block-table"><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>`;
  assert.deepEqual(validateRenderedHtml(html, "My title"), []);
});

test("detects stray markdown fence in HTML body", () => {
  const html = "<p>\\`\\`\\`markdown</p><h2>Section</h2><p>body</p>";
  // The actual incident had ``` literally in the output — match that case
  const real = "<p>```markdown</p><h2>Section</h2><p>body</p>";
  const issues = validateRenderedHtml(real, "My title");
  assert.ok(issues.some((i) => i.includes("markdown fence")));
});

test("detects duplicate H1 in body (WP renders title separately)", () => {
  const html = "<h1>My title</h1><p>intro</p><h2>Section</h2>";
  const issues = validateRenderedHtml(html, "My title");
  assert.ok(issues.some((i) => i.includes("<h1>")));
});

test("detects empty paragraphs", () => {
  const html = "<p></p><h2>Section</h2><p>body</p><p>   </p>";
  const issues = validateRenderedHtml(html, "My title");
  assert.ok(issues.some((i) => i.includes("empty")));
});

test("detects malformed table (missing thead)", () => {
  const html = "<p>intro</p><table><tbody><tr><td>1</td></tr></tbody></table>";
  const issues = validateRenderedHtml(html, "Title");
  assert.ok(issues.some((i) => i.includes("table")));
});

test("detects unprocessed [AFFILIATE:] tag", () => {
  const html = "<p>Check out [AFFILIATE:jasper]Jasper AI[/AFFILIATE] for writing.</p>";
  const issues = validateRenderedHtml(html, "Title");
  assert.ok(issues.some((i) => i.includes("[AFFILIATE:]")));
});

test("detects bad href attributes", () => {
  const html = '<p><a href="javascript:alert(1)">bad</a> <a href="">empty</a></p>';
  const issues = validateRenderedHtml(html, "Title");
  assert.ok(issues.some((i) => i.includes("href")));
});

test("detects title duplicated as H2 mid-body", () => {
  const html = "<p>intro</p><h2>Best AI Tools 2026</h2><p>body</p>";
  const issues = validateRenderedHtml(html, "Best AI Tools 2026");
  assert.ok(issues.some((i) => i.includes("duplicated")));
});

test("empty HTML reports as empty", () => {
  assert.deepEqual(validateRenderedHtml("", "Title"), ["empty HTML"]);
  assert.deepEqual(validateRenderedHtml(null, "Title"), ["empty HTML"]);
});

test("handles title with regex special chars", () => {
  // Should not throw even when title has $, *, etc.
  const issues = validateRenderedHtml("<p>intro</p><h2>Foo $ Bar</h2>", "Foo $ Bar");
  assert.ok(Array.isArray(issues));
});
