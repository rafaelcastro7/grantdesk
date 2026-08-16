-- Phase 4 — requirement-driven drafting.

-- ── Requirements ────────────────────────────────────────────────────────────
-- Requirements are read from the call itself, so they carry where they came
-- from and what kind of thing they are. A consultant deciding whether to trust
-- a draft asks "is that actually what the funder asked for?", and that question
-- has to be answerable without reopening the call in another tab.
alter table requirements add column if not exists kind text not null default 'section'
  check (kind in ('section', 'eligibility', 'attachment', 'criterion'));

-- A section requirement usually names a length. Drafting to no limit produces
-- text a consultant then has to cut, which is the opposite of saving them time.
alter table requirements add column if not exists word_limit integer;

-- What the funder says they will score this on. The single most useful thing on
-- the page and the thing generic templates ignore entirely.
alter table requirements add column if not exists evaluation_note text;

-- Verbatim from the call. Never paraphrased: this is what gets quoted back when
-- someone asks why the draft says what it says.
alter table requirements add column if not exists source_quote text;

alter table requirements add column if not exists extracted_at timestamptz;
alter table requirements add column if not exists extracted_from text;

-- Re-reading a call must update its requirements rather than duplicate them.
create unique index if not exists requirements_grant_label_idx
  on requirements (grant_id, lower(label));

-- ── Drafting provenance ─────────────────────────────────────────────────────
-- Which requirement a section answers is already modelled. What was missing is
-- where its content came from: which stored answers were reused, and which
-- model wrote the rest. A draft nobody can trace is a draft a consultant has to
-- re-verify from scratch, which costs more than writing it did.
alter table proposal_sections add column if not exists reused_answer_ids uuid[]
  not null default '{}';
alter table proposal_sections add column if not exists drafted_by text;
alter table proposal_sections add column if not exists word_count integer;

-- ── Answer library ──────────────────────────────────────────────────────────
-- The promised time saving lives here. A consultant answers "describe your
-- organization's track record" dozens of times per client, and the second
-- answer should cost nothing.
--
-- Reuse is found by meaning rather than by label text, because the same
-- question is asked in different words by every funder — "organizational
-- capacity", "track record", "prior experience" are one answer.
alter table answer_library add column if not exists embedding vector(768);
alter table answer_library add column if not exists content_hash text;
alter table answer_library add column if not exists last_used_at timestamptz;

create index if not exists answer_library_embedding_idx
  on answer_library using hnsw (embedding vector_cosine_ops);

-- Find a client's stored answers closest in meaning to a requirement.
-- Scoped to one client by argument and by RLS: an answer written for one
-- organization must never surface in another's proposal.
create or replace function match_answers(
  target_client uuid,
  q_embedding vector(768),
  max_results integer default 3,
  min_similarity numeric default 0.55
)
returns table (id uuid, label text, content text, similarity numeric)
language sql stable parallel safe as $$
  select a.id,
         a.label,
         a.content,
         (1 - (a.embedding <=> q_embedding))::numeric as similarity
  from answer_library a
  where a.client_id = target_client
    and a.embedding is not null
    and (1 - (a.embedding <=> q_embedding)) >= min_similarity
  order by a.embedding <=> q_embedding
  limit max_results;
$$;

grant execute on function public.match_answers(uuid, vector, integer, numeric) to authenticated;

-- Requirements belong to the shared catalog, like the grants they describe, so
-- any signed-in consultant may read them. Writing them is reading a public
-- call: it produces reference data, not private material.
drop policy if exists requirements_read on requirements;
create policy requirements_read on requirements for select to authenticated using (true);

drop policy if exists requirements_write on requirements;
create policy requirements_write on requirements for insert to authenticated with check (true);

drop policy if exists requirements_update on requirements;
create policy requirements_update on requirements for update to authenticated using (true);
