-- Monitor anti-flap state.
--
-- The hourly site monitor (scripts/monitor-site.js) uses this singleton row to
-- require N consecutive failed runs before alerting, so a single Hostinger
-- cold-start blip never trips a false "site down" alarm in #alertas.
--
-- The monitor degrades gracefully if this table is absent (falls back to
-- single-run alerting), so applying this migration is safe to defer.

create table if not exists public.monitor_state (
  id uuid primary key default '00000000-0000-0000-0000-000000000001',
  consecutive_failures integer not null default 0,
  last_status text,
  last_checked_at timestamptz,
  last_alerted_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Internal observability table: lock it down. The pipeline reaches it with the
-- service-role key, which bypasses RLS; public client roles get nothing.
alter table public.monitor_state enable row level security;
revoke all on public.monitor_state from anon, authenticated;

insert into public.monitor_state (id)
values ('00000000-0000-0000-0000-000000000001')
on conflict (id) do nothing;

-- Rollback: drop table if monitor anti-flap is no longer wanted.
--   drop table if exists public.monitor_state;
