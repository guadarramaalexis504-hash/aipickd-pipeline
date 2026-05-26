-- AI Citation tracking — observability for GEO/AEO success.
--
-- After shipping Citation Capsules (the > **Key fact** blockquotes), we
-- need to MEASURE whether AI search engines (Perplexity, ChatGPT,
-- Google AI Overviews) actually cite aipickd.com. Otherwise we're
-- optimizing blind.
--
-- This table holds the weekly probe results: for each query, did
-- Perplexity's sources include aipickd.com? Which page? What position?
-- Aggregated over time, this lets us answer:
--   * "Are we showing up in AI citations at all?"
--   * "Which keywords win citations (replicate that pattern)?"
--   * "Which articles get cited most (give them more internal links)?"
--   * "Did Citation Capsule launch on date X move the numbers?"

CREATE TABLE IF NOT EXISTS ai_citations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  probed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source        TEXT NOT NULL,            -- 'perplexity', 'chatgpt-search', 'gemini', etc
  query         TEXT NOT NULL,            -- the search prompt we sent
  cited         BOOLEAN NOT NULL,         -- did the response cite aipickd.com?
  cited_url     TEXT,                     -- specific aipickd.com URL if cited
  citation_position INTEGER,              -- 1-based position in sources list, NULL if not cited
  total_sources INTEGER,                  -- how many sources the AI cited overall
  response_excerpt TEXT,                  -- first ~500 chars of the AI's answer (for context)
  raw_response  JSONB,                    -- full API response for debugging / re-analysis
  CONSTRAINT ai_citations_position_when_cited
    CHECK ((cited = TRUE AND citation_position IS NOT NULL) OR cited = FALSE)
);

CREATE INDEX IF NOT EXISTS ai_citations_probed_at_idx ON ai_citations (probed_at DESC);
CREATE INDEX IF NOT EXISTS ai_citations_source_query_idx ON ai_citations (source, query);
CREATE INDEX IF NOT EXISTS ai_citations_cited_idx ON ai_citations (cited) WHERE cited = TRUE;

COMMENT ON TABLE ai_citations IS
  'Weekly probe results for AI search citation tracking (GEO/AEO observability). Run by scripts/check-ai-citations.js via ai-citations-check.yml workflow.';
