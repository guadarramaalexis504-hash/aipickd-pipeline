-- Pipeline runtime config — single-row "knobs" table the bot can flip.
--
-- The Discord bot needs to be able to PAUSE the pipeline mid-flight
-- (e.g., "stop publishing while I fix this bug"). A single-row config
-- table is the simplest source of truth: every generate-cycle run
-- checks the `paused` flag at startup and aborts cleanly if true.
--
-- We use UPSERT with a fixed UUID so there's always exactly one row,
-- never zero, never two. Lookups are O(1) on the PK.

CREATE TABLE IF NOT EXISTS pipeline_config (
  id            UUID PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001',
  paused        BOOLEAN NOT NULL DEFAULT FALSE,
  paused_reason TEXT,
  paused_by     TEXT, -- Discord user ID or "system"
  paused_at     TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Single-row guard
  CONSTRAINT pipeline_config_singleton CHECK (id = '00000000-0000-0000-0000-000000000001')
);

-- Seed the singleton row so SELECT never returns empty.
INSERT INTO pipeline_config (id, paused)
VALUES ('00000000-0000-0000-0000-000000000001', FALSE)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION pipeline_config_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pipeline_config_updated_at ON pipeline_config;
CREATE TRIGGER pipeline_config_updated_at
  BEFORE UPDATE ON pipeline_config
  FOR EACH ROW EXECUTE FUNCTION pipeline_config_touch_updated_at();

COMMENT ON TABLE pipeline_config IS
  'Runtime config flipped by the Discord bot. Currently only `paused` is used. Read by run-pipeline.js at startup.';
