-- Track the Discord message ID for the always-updating dashboard.
--
-- The dashboard updater script needs to remember which Discord
-- message to PATCH on each hourly run. We store the ID on the
-- existing pipeline_config singleton so we don't need another table
-- just for one string.
--
-- NULL means "no dashboard message exists yet" — the script will
-- create one on its next run and write the ID back here.

ALTER TABLE pipeline_config
  ADD COLUMN IF NOT EXISTS dashboard_message_id TEXT;

COMMENT ON COLUMN pipeline_config.dashboard_message_id IS
  'Discord message ID of the pinned auto-updating status dashboard. Updated by scripts/update-dashboard.js.';
