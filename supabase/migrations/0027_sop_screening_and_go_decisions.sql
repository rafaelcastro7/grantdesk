-- The SOP a real client (IIAL, docs/SOP_GR_1.DOC) runs before any writing
-- starts: six screening filters, a one-page Opportunity Brief, and a recorded
-- leadership go / no-go. Three profile facts the rules engine was missing, and
-- one table for the brief and its decision.

-- F2: whether this client can join as the paid partner of an eligible lead
-- (usually a municipality) when it cannot apply itself. The SOP calls this a
-- proven pathway, "not second prize", so a call closed to the client's own
-- legal form is a question to answer rather than a rejection.
alter table client_profiles
  add column if not exists funded_partner_pathway boolean not null default false;

-- F5: working weeks needed when a partner must apply as lead. Municipal
-- sign-off cycles are outside the client's control, so this is separate from
-- lead_time_weeks rather than a multiplier nobody could defend.
alter table client_profiles add column if not exists partner_lead_time_weeks integer
  check (partner_lead_time_weeks is null or (partner_lead_time_weeks >= 0 and partner_lead_time_weeks <= 52));

-- F4: the client's own capability domains, in its words. A call that names
-- none of them is flagged for a fit decision; it is never ruled out by a word
-- count, since meaning-based retrieval already found it for a reason.
alter table client_profiles
  add column if not exists capability_domains text[] not null default '{}';

-- Stage 4 is this client's policy, not every client's: a consultant whose
-- client has no leadership sign-off step should not be blocked by one.
alter table client_profiles
  add column if not exists requires_go_decision boolean not null default false;

comment on column client_profiles.requires_go_decision is
  'Drafting is locked until leadership records a go on the Opportunity Brief (SOP Stage 4).';
comment on column client_profiles.funded_partner_pathway is
  'Client may participate as the funded partner of an eligible lead applicant (SOP F2).';
comment on column client_profiles.partner_lead_time_weeks is
  'Working weeks needed when a partner applies as lead (SOP F5). Defaults to 8 in code.';
comment on column client_profiles.capability_domains is
  'Capability domains used for the strategic-fit check (SOP F4).';

-- Stages 3 and 4: the brief and the decision on it. One per client and call,
-- kept forever: a no-go is history the SOP requires ("do not discard the
-- record — programs reopen"), so there is no delete policy.
create table if not exists opportunity_decisions (
  client_id uuid not null references clients(id) on delete cascade,
  grant_id uuid not null references grants(id) on delete cascade,
  role text check (role in ('lead', 'funded_partner', 'other')),
  role_other text,
  intake text check (intake in ('fixed', 'rolling')),
  application_structure text check (application_structure in ('one_stage', 'two_stage')),
  strategic_angle text,
  mandatory_components text,
  request_amount numeric,
  net_revenue numeric,
  match_required numeric,
  in_kind_cap numeric,
  cash_match_confirmed boolean not null default false,
  risks text,
  recommendation text check (recommendation in ('go', 'no_go', 'go_conditional')),
  recommendation_reason text,
  condition text,
  decision text not null default 'pending'
    check (decision in ('pending', 'go', 'no_go', 'go_conditional')),
  condition_met boolean not null default false,
  decided_by text,
  decision_reason text,
  decided_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (client_id, grant_id),
  -- A decision without a named approver is not a leadership decision.
  check (decision = 'pending' or (decided_by is not null and length(trim(decided_by)) > 0)),
  check (decision <> 'go_conditional' or (condition is not null and length(trim(condition)) > 0))
);

alter table opportunity_decisions enable row level security;

create policy opportunity_decisions_select on opportunity_decisions
  for select to authenticated using (public.owns_client(client_id));
create policy opportunity_decisions_insert on opportunity_decisions
  for insert to authenticated with check (public.owns_client(client_id));
create policy opportunity_decisions_update on opportunity_decisions
  for update to authenticated
  using (public.owns_client(client_id)) with check (public.owns_client(client_id));
