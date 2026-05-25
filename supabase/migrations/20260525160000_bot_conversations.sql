-- Bot conversation history (persistent across Railway reboots).
--
-- The Discord bot keeps per-channel conversation context so Claude can
-- remember earlier messages in a thread. Until now this lived in an
-- in-memory Map that got wiped on every restart — losing context made
-- the bot feel forgetful, especially during ongoing debug sessions.
--
-- Schema:
--   channel_id   Discord channel ID (snowflake string, stable per channel)
--   messages     JSONB array of {role, content} pairs in Anthropic format
--   updated_at   for TTL/GC (we keep last 7 days only)
--
-- Read pattern: load once on first message per channel, keep in memory
-- for the session. Write pattern: upsert after each assistant reply
-- (bounded to the last MAX_HISTORY messages).

CREATE TABLE IF NOT EXISTS bot_conversations (
  channel_id  TEXT PRIMARY KEY,
  messages    JSONB NOT NULL DEFAULT '[]'::jsonb,
  message_count INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on every change
CREATE OR REPLACE FUNCTION update_bot_conversations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  NEW.message_count = COALESCE(jsonb_array_length(NEW.messages), 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bot_conversations_updated_at ON bot_conversations;
CREATE TRIGGER bot_conversations_updated_at
  BEFORE UPDATE ON bot_conversations
  FOR EACH ROW EXECUTE FUNCTION update_bot_conversations_updated_at();

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS bot_conversations_updated_at_idx
  ON bot_conversations (updated_at);

COMMENT ON TABLE bot_conversations IS
  'Per-channel Discord bot conversation history. Cleaned up after 7 days idle by scripts/cleanup-old-conversations.js (run nightly).';
