-- Reading whether a client satisfies a funder's own condition used to be a
-- manual re-read every time: "Who can apply?" on a real ACOA call is a full
-- paragraph naming a dozen organization types, and the consultant had to hold
-- their client's profile in their head against it themselves. The rules
-- engine cannot do this — these are conditions extracted from a funder's
-- prose, not the six structured checks it already runs — but reading prose
-- against a known profile and pointing out what matches is exactly the kind
-- of manual work worth automating, as long as it stays a reading aid and
-- never a verdict: the checkbox confirming it is still, and only, a person's.
create table if not exists requirement_assessments (
  proposal_id uuid not null references proposals(id) on delete cascade,
  requirement_id uuid not null references requirements(id) on delete cascade,
  assessment text not null,
  model text not null,
  assessed_at timestamptz not null default now(),
  primary key (proposal_id, requirement_id)
);
alter table requirement_assessments enable row level security;

create policy requirement_assessments_own_all on requirement_assessments
  for all to authenticated
  using (exists (
    select 1 from proposals p
    where p.id = requirement_assessments.proposal_id and public.owns_client(p.client_id)
  ))
  with check (exists (
    select 1 from proposals p
    where p.id = requirement_assessments.proposal_id and public.owns_client(p.client_id)
  ));
