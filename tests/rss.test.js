const { test } = require("node:test");
const assert = require("node:assert/strict");

const { build } = require("../scripts/lib/rss");

const baseChannel = {
  title: "AIPickd",
  description: "AI tools reviews",
  link: "https://aipickd.com",
  items: [],
};

test("rss: rejects missing title/description", () => {
  assert.throws(() => build({ description: "x", items: [] }));
  assert.throws(() => build({ title: "x", items: [] }));
});

test("rss: rejects items not array", () => {
  assert.throws(() => build({ title: "t", description: "d", items: "x" }));
});

test("rss: builds valid empty feed", () => {
  const xml = build(baseChannel);
  assert.match(xml, /<\?xml/);
  assert.match(xml, /<rss version="2\.0"/);
  assert.match(xml, /<title>AIPickd<\/title>/);
  assert.match(xml, /xmlns:media/);
  assert.match(xml, /xmlns:dc/);
});

test("rss: includes media:content for items with image", () => {
  const xml = build({
    ...baseChannel,
    items: [
      {
        title: "Article 1",
        link: "https://aipickd.com/a-1",
        pubDate: "2026-05-09T00:00:00Z",
        imageUrl: "https://aipickd.com/img.jpg",
        imageWidth: 1200,
        imageHeight: 630,
      },
    ],
  });
  assert.match(
    xml,
    /<media:content url="https:\/\/aipickd\.com\/img\.jpg" medium="image" width="1200" height="630"/
  );
});

test("rss: emits dc:creator and categories", () => {
  const xml = build({
    ...baseChannel,
    items: [
      {
        title: "x",
        link: "https://aipickd.com/x",
        author: "Jane Doe",
        categories: ["AI", "Productivity"],
      },
    ],
  });
  assert.match(xml, /<dc:creator>Jane Doe<\/dc:creator>/);
  assert.match(xml, /<category>AI<\/category>/);
  assert.match(xml, /<category>Productivity<\/category>/);
});

test("rss: escapes XML special chars", () => {
  const xml = build({
    ...baseChannel,
    items: [{ title: "Tom & Jerry's <test>", link: "https://aipickd.com/x" }],
  });
  assert.match(xml, /Tom &amp; Jerry&apos;s &lt;test&gt;/);
});

test("rss: wraps content in CDATA and escapes ]]>", () => {
  const xml = build({
    ...baseChannel,
    items: [
      {
        title: "x",
        link: "https://aipickd.com/x",
        content: "<p>Hello]]>world</p>",
      },
    ],
  });
  assert.match(xml, /<!\[CDATA\[<p>Hello\]\]\]\]><!\[CDATA\[>world<\/p>\]\]>/);
});

test("rss: rejects items missing title/link", () => {
  assert.throws(() => build({ ...baseChannel, items: [{ link: "x" }] }));
  assert.throws(() => build({ ...baseChannel, items: [{ title: "x" }] }));
});
