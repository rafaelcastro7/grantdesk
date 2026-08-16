-- Freshness has to be a fact, not an assumption.
--
-- Coverage claims ("automatic", "out of date") are derived from when a source
-- last actually completed, so that has to be recorded rather than inferred
-- from row timestamps — a source can run successfully and legitimately return
-- nothing new, and that is still a healthy refresh.

create table if not exists source_runs (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  funders_upserted integer not null default 0,
  grants_upserted integer not null default 0,
  error text
);
create index if not exists source_runs_recent_idx on source_runs (source_key, started_at desc);

alter table source_runs enable row level security;

-- Catalog telemetry is shared reference data: any signed-in consultant can see
-- whether a market is fresh, and only service_role writes it.
create policy source_runs_read on source_runs for select to authenticated using (true);

-- The last successful run per source, which is what coverage reads.
create or replace view source_freshness as
select
  source_key,
  max(finished_at) filter (where status = 'ok') as last_ok_at,
  count(*) filter (where status = 'failed' and started_at > now() - interval '7 days') as failures_7d
from source_runs
group by source_key;

grant select on source_freshness to authenticated, service_role;
