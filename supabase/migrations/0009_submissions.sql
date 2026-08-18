-- Phase 5 — submit and track.

-- ── Who won this before ─────────────────────────────────────────────────────
-- The differentiator the incumbent admits it lacks, and it needs a key to look
-- awards up by. US federal calls carry an Assistance Listing (formerly CFDA)
-- number, which is what USAspending indexes prior awards under — so the same
-- number that identifies a program identifies everyone who has ever won it.
alter table grants add column if not exists assistance_listings text[] not null default '{}';
create index if not exists grants_assistance_listings_idx
  on grants using gin (assistance_listings);

-- Awards are attributed to the listing rather than to one opportunity: a
-- program reissues its call every year, and last year's winners are the useful
-- answer to "who wins this".
alter table past_awards add column if not exists assistance_listing text;
alter table past_awards add column if not exists recipient_location text;
create index if not exists past_awards_listing_idx on past_awards (assistance_listing);

-- ── Acknowledging a condition ───────────────────────────────────────────────
-- A call that rejects applications without audited statements is a hard gate no
-- software can clear. What software can do is refuse to call the application
-- ready until a person says they have it — and record who said so.
create table if not exists requirement_acknowledgements (
  proposal_id uuid not null references proposals(id) on delete cascade,
  requirement_id uuid not null references requirements(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  acknowledged_by uuid not null references consultants(id),
  primary key (proposal_id, requirement_id)
);
alter table requirement_acknowledgements enable row level security;

create policy requirement_ack_own_all on requirement_acknowledgements
  for all to authenticated
  using (exists (
    select 1 from proposals p
    where p.id = requirement_acknowledgements.proposal_id and public.owns_client(p.client_id)
  ))
  with check (exists (
    select 1 from proposals p
    where p.id = requirement_acknowledgements.proposal_id and public.owns_client(p.client_id)
  ));

-- ── Submission ──────────────────────────────────────────────────────────────
-- One recorded submission per application. Recording it twice would make the
-- tracker disagree with itself about what was sent and when.
create unique index if not exists submissions_proposal_idx on submissions (proposal_id);

-- What the consultant was told at the moment they submitted. Kept because a
-- submission made over a stated warning is a decision someone made, and six
-- months later "did we know?" has to be answerable.
alter table submissions add column if not exists overridden_blockers jsonb
  not null default '[]'::jsonb;
alter table submissions add column if not exists notes text;

-- Outcome tracking. Deliberately few states: a consultant updates this by hand
-- between other work, and a taxonomy nobody maintains is worse than none.
alter table submissions drop constraint if exists submissions_outcome_check;
alter table submissions add constraint submissions_outcome_check
  check (outcome is null or outcome in ('awaiting', 'awarded', 'declined', 'withdrawn'));
update submissions set outcome = 'awaiting' where outcome is null;
alter table submissions alter column outcome set default 'awaiting';

-- Past awards are shared reference data, like the catalog they describe.
drop policy if exists past_awards_read on past_awards;
create policy past_awards_read on past_awards for select to authenticated using (true);
