-- Core Web Vitals history — field-data CWV from Google's CrUX API.
--
-- CrUX is the same dataset Google uses to evaluate page experience for
-- ranking purposes. Lab data (PageSpeed Insights) is a snapshot; CrUX
-- is the actual real-user 75th percentile from Chrome users worldwide.
--
-- We probe once a week per URL. URL-level data needs ~28 days of
-- traffic before CrUX serves it, so new articles return "no data" for
-- their first month — that's normal and we log it.
--
-- Schema notes:
--   * One row per (url, probed_at) — append-only history table.
--   * NULLs are meaningful: "no CrUX data available yet" vs zero.
--   * threshold columns let us compare current vs Google's pass marks
--     without re-reading the rubric every query.

CREATE TABLE IF NOT EXISTS cwv_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url         TEXT NOT NULL,
  probed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  form_factor TEXT NOT NULL DEFAULT 'PHONE',  -- 'PHONE' | 'DESKTOP' | 'TABLET'

  -- Core metrics (75th percentile from CrUX) — NULL = no data yet
  lcp_p75_ms   INTEGER,  -- Largest Contentful Paint, pass <= 2500ms
  inp_p75_ms   INTEGER,  -- Interaction to Next Paint, pass <= 200ms
  cls_p75      NUMERIC,  -- Cumulative Layout Shift, pass <= 0.10
  fcp_p75_ms   INTEGER,  -- First Contentful Paint (informational)
  ttfb_p75_ms  INTEGER,  -- Time to First Byte (informational)

  -- CrUX bucket distribution (good/needs improvement/poor) — useful
  -- for spotting "mostly good but tail is bad" patterns.
  lcp_good_pct  NUMERIC,
  lcp_ni_pct    NUMERIC,
  lcp_poor_pct  NUMERIC,
  inp_good_pct  NUMERIC,
  inp_ni_pct    NUMERIC,
  inp_poor_pct  NUMERIC,
  cls_good_pct  NUMERIC,
  cls_ni_pct    NUMERIC,
  cls_poor_pct  NUMERIC,

  has_data    BOOLEAN NOT NULL DEFAULT FALSE  -- false = CrUX returned "no data"
);

CREATE INDEX IF NOT EXISTS cwv_history_url_probed_idx ON cwv_history (url, probed_at DESC);
CREATE INDEX IF NOT EXISTS cwv_history_probed_at_idx ON cwv_history (probed_at DESC);

COMMENT ON TABLE cwv_history IS
  'Core Web Vitals field-data history per URL. Run by scripts/check-cwv.js via cwv-check.yml workflow weekly. Pass thresholds: LCP <= 2500ms, INP <= 200ms, CLS <= 0.10.';
