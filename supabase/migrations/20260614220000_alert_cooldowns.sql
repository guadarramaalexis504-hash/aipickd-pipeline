-- Cross-run alert cooldown store.
--
-- scripts/lib/alert-cooldown.js uses this to throttle STANDING-condition alerts
-- (stuck keyword, cost spike, queue low, dead-man's switch) so they fire at most
-- once per window instead of every cron run. The cooldown degrades open (alerts
-- anyway) when this table is absent, so applying this migration is safe to defer.

create table if not exists public.alert_cooldowns (
  signature text primary key,
  last_sent_at timestamptz not null default now()
);

-- Internal observability table: service-role only (bypasses RLS); public roles get nothing.
alter table public.alert_cooldowns enable row level security;
revoke all on public.alert_cooldowns from anon, authenticated;

-- Rollback: drop table if alert cooldowns are no longer wanted.
--   drop table if exists public.alert_cooldowns;
