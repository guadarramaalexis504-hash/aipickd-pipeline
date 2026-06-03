const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildArticleUrlMap,
  normUrl,
  rowMetric,
  toArticleMetricUpdates,
  toGscDetailRows,
} = require("../scripts/gsc-ctr-report");

test("gsc: normalizes article urls from wp_url and slug", () => {
  const byUrl = buildArticleUrlMap([
    {
      id: "article-1",
      slug: "jasper-vs-copy",
      wp_url: "https://www.aipickd.com/jasper-vs-copy/",
    },
  ]);

  assert.equal(normUrl("https://www.aipickd.com/jasper-vs-copy/"), "aipickd.com/jasper-vs-copy");
  assert.equal(byUrl.get("aipickd.com/jasper-vs-copy").id, "article-1");
});

test("gsc: page summaries become article metric updates", () => {
  const byUrl = buildArticleUrlMap([
    { id: "article-1", title: "Jasper vs Copy", slug: "jasper-vs-copy", wp_url: null },
  ]);

  const updates = toArticleMetricUpdates([
    {
      keys: ["https://aipickd.com/jasper-vs-copy/"],
      clicks: 3,
      impressions: 120,
      ctr: 0.025444,
      position: 8.237,
    },
    {
      keys: ["https://aipickd.com/unmatched/"],
      clicks: 1,
      impressions: 20,
      ctr: 0.05,
      position: 3,
    },
  ], byUrl, "2026-06-03T12:00:00.000Z");

  assert.equal(updates.length, 1);
  assert.equal(updates[0].article.id, "article-1");
  assert.equal(updates[0].gsc_ctr, undefined);
  assert.equal(updates[0].ctr, 0.0254);
  assert.equal(updates[0].position, 8.24);
});

test("gsc: detail rows keep query, device, date, and unmatched urls", () => {
  const byUrl = buildArticleUrlMap([
    {
      id: "article-1",
      title: "Jasper vs Copy",
      slug: "jasper-vs-copy",
      wp_url: "https://aipickd.com/jasper-vs-copy/",
    },
  ]);

  const rows = toGscDetailRows([
    {
      keys: ["https://aipickd.com/jasper-vs-copy/", "best ai copy tool", "MOBILE", "2026-06-01"],
      clicks: 2,
      impressions: 100,
      ctr: 0.02,
      position: 7.12,
    },
    {
      keys: ["https://aipickd.com/not-in-supabase/", "aipickd", "DESKTOP", "2026-06-01"],
      clicks: 0,
      impressions: 12,
      ctr: 0,
      position: 14.9,
    },
  ], byUrl, {
    importRunId: "run-1",
    startDate: "2026-05-05",
    endDate: "2026-06-01",
    importedAt: "2026-06-03T12:00:00.000Z",
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    import_run_id: "run-1",
    article_id: "article-1",
    page_url: "https://aipickd.com/jasper-vs-copy/",
    normalized_page_url: "aipickd.com/jasper-vs-copy",
    query: "best ai copy tool",
    device: "MOBILE",
    row_date: "2026-06-01",
    search_type: "web",
    start_date: "2026-05-05",
    end_date: "2026-06-01",
    imported_at: "2026-06-03T12:00:00.000Z",
    impressions: 100,
    clicks: 2,
    ctr: 0.02,
    position: 7.12,
  });
  assert.equal(rows[1].article_id, null);
  assert.equal(rows[1].normalized_page_url, "aipickd.com/not-in-supabase");
});

test("gsc: rowMetric keeps ctr as a 0-1 value", () => {
  assert.deepEqual(rowMetric({
    clicks: 1.2,
    impressions: 10.7,
    ctr: 0.123456,
    position: 4.567,
  }), {
    clicks: 1,
    impressions: 11,
    ctr: 0.1235,
    position: 4.57,
  });
});
