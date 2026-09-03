-- A drafted section is overwritten in place on every re-draft and every edit
-- (proposal.functions.ts's upsert, and saveEdit in the proposal route) — once
-- overwritten, an earlier version is gone. That is fine for a typo fix and a
-- real loss for "the second draft was worse, I want the first one back",
-- which nothing before this let a consultant recover from.
--
-- Append-only, insert-only: nothing here is ever updated or deleted by the
-- app, so the history itself cannot be silently rewritten the way the
-- current section content can be.
create table if not exists proposal_section_revisions (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals(id) on delete cascade,
  requirement_id uuid references requirements(id) on delete set null,
  content text not null,
  word_count integer,
  drafted_by text,
  created_at timestamptz not null default now()
);

create index if not exists proposal_section_revisions_lookup_idx
  on proposal_section_revisions (proposal_id, requirement_id, created_at desc);

alter table proposal_section_revisions enable row level security;

-- Same ownership check as proposal_sections itself: a revision is only ever
-- visible to the consultant who owns the client the proposal belongs to.
drop policy if exists proposal_section_revisions_own_all on proposal_section_revisions;
create policy proposal_section_revisions_own_all on proposal_section_revisions
  for all to authenticated
  using (exists (
    select 1 from proposals p
    where p.id = proposal_section_revisions.proposal_id and owns_client(p.client_id)
  ))
  with check (exists (
    select 1 from proposals p
    where p.id = proposal_section_revisions.proposal_id and owns_client(p.client_id)
  ));
