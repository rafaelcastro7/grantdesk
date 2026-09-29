-- Post-award obligations (ADR-0007) and the Opportunity Brief's budget lines.

-- ── What was awarded ───────────────────────────────────────────────────────
-- Deliberately not under the submitted-lock of 0034: an award is recorded
-- after submission by definition, and reports are marked sent months later.
create table if not exists award_details (
  proposal_id uuid primary key references proposals(id) on delete cascade,
  amount numeric check (amount is null or amount >= 0),
  currency text,
  start_on date,
  end_on date,
  notes text,
  updated_at timestamptz not null default now(),
  check (start_on is null or end_on is null or end_on >= start_on)
);
alter table award_details enable row level security;

drop policy if exists award_details_own_all on award_details;
create policy award_details_own_all on award_details
  for all to authenticated
  using (exists (
    select 1 from proposals p
    where p.id = award_details.proposal_id and public.owns_client(p.client_id)
  ))
  with check (exists (
    select 1 from proposals p
    where p.id = award_details.proposal_id and public.owns_client(p.client_id)
  ));

create table if not exists award_reports (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals(id) on delete cascade,
  label text not null check (length(trim(label)) > 0),
  kind text not null check (kind in ('interim', 'final', 'financial', 'other')),
  due_on date not null,
  submitted_on date,
  created_at timestamptz not null default now()
);
create index if not exists award_reports_proposal_idx on award_reports (proposal_id);
create index if not exists award_reports_open_due_idx on award_reports (due_on)
  where submitted_on is null;
alter table award_reports enable row level security;

drop policy if exists award_reports_own_all on award_reports;
create policy award_reports_own_all on award_reports
  for all to authenticated
  using (exists (
    select 1 from proposals p
    where p.id = award_reports.proposal_id and public.owns_client(p.client_id)
  ))
  with check (exists (
    select 1 from proposals p
    where p.id = award_reports.proposal_id and public.owns_client(p.client_id)
  ));

-- ── Report reminders through the same outbox ───────────────────────────────
alter table email_outbox add column if not exists award_report_id uuid
  references award_reports(id) on delete cascade;
alter table email_outbox drop constraint if exists email_outbox_kind_check;
alter table email_outbox add constraint email_outbox_kind_check
  check (kind in ('new_grant_match', 'deadline_reminder', 'system_alert', 'award_report_due'));

-- Two reports on one grant due the same week would otherwise dedup each other
-- away, because the old key stops at the grant.
drop index if exists email_outbox_daily_dedup_idx;
create unique index email_outbox_daily_dedup_idx on email_outbox (
  recipient_email,
  kind,
  coalesce(grant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(award_report_id, '00000000-0000-0000-0000-000000000000'::uuid),
  created_date
);

-- ── Budget lines behind the brief's money fields ───────────────────────────
-- Either hours x rate or a flat amount; a line with neither costs nothing and
-- would make the totals look complete when they are not.
create table if not exists brief_budget_lines (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  grant_id uuid not null references grants(id) on delete cascade,
  category text not null check (length(trim(category)) > 0),
  description text,
  hours numeric check (hours is null or hours >= 0),
  rate numeric check (rate is null or rate >= 0),
  amount numeric check (amount is null or amount >= 0),
  funded_by text not null check (funded_by in ('grant', 'cash_match', 'in_kind')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  check (amount is not null or (hours is not null and rate is not null))
);
create index if not exists brief_budget_lines_client_grant_idx
  on brief_budget_lines (client_id, grant_id);
alter table brief_budget_lines enable row level security;

drop policy if exists brief_budget_lines_own_all on brief_budget_lines;
create policy brief_budget_lines_own_all on brief_budget_lines
  for all to authenticated
  using (public.owns_client(client_id))
  with check (public.owns_client(client_id));
