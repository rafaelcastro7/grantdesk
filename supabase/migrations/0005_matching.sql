-- Phase 3 — verified matches.
--
-- Two things happen here. Retrieval gets a real fusion function instead of a
-- LIKE scan, and grants gain the structured eligibility data that lets a rule
-- decide instead of a model guessing.

-- ── Structured eligibility ──────────────────────────────────────────────────
-- Canonical applicant-type codes (see src/lib/applicant-types.ts). Empty means
-- the source told us nothing, which is a different answer from "open to all" —
-- the rules engine reports the first as needs_input and the second as a pass.
alter table grants add column if not exists eligible_applicant_types text[] not null default '{}';

-- The funder's own eligibility prose, quoted back to the consultant verbatim.
-- We never paraphrase this: it is the sentence they will be held to.
alter table grants add column if not exists eligibility_note text;

-- ── Lexical retrieval ───────────────────────────────────────────────────────
-- The original column indexed everything under 'simple', which does no
-- stemming: a client whose profile says "environmental" never matched a call
-- titled "Environment Fund". Across four languages that is a large silent
-- recall loss, so each grant is now indexed under its own language's
-- dictionary. Cross-language matching is the vector side's job, not this one's.
drop index if exists grants_search_tsv_idx;
alter table grants drop column if exists search_tsv;

create or replace function grant_text_config(lang text) returns regconfig
language sql immutable parallel safe as $$
  select case lower(coalesce(lang, 'en'))
    when 'fr' then 'french'::regconfig
    when 'es' then 'spanish'::regconfig
    when 'pt' then 'portuguese'::regconfig
    else 'english'::regconfig
  end;
$$;

alter table grants
  add column search_tsv tsvector
  generated always as (
    setweight(to_tsvector(grant_text_config(language), coalesce(title, '')), 'A') ||
    setweight(to_tsvector(grant_text_config(language), coalesce(summary, '')), 'B') ||
    setweight(to_tsvector(grant_text_config(language), coalesce(eligibility_note, '')), 'D')
  ) stored;
create index grants_search_tsv_idx on grants using gin (search_tsv);

-- ── Semantic retrieval ──────────────────────────────────────────────────────
-- HNSW over cosine distance. Chosen over IVFFlat because it needs no training
-- pass and stays usable while the corpus is still small and growing daily —
-- IVFFlat's lists have to be rebuilt as rows arrive, and a stale index there
-- degrades silently rather than loudly.
create index if not exists grant_embeddings_hnsw_idx
  on grant_embeddings using hnsw (embedding vector_cosine_ops);

-- ── Fusion ──────────────────────────────────────────────────────────────────
-- Reciprocal Rank Fusion, k = 60. RRF combines rankings without needing the
-- two scores to be comparable, which matters because ts_rank and cosine
-- distance are on unrelated scales and any hand-tuned weighting between them
-- would be a number we invented.
--
-- Either side may be absent: no query text (a profile with only structured
-- fields) or no embedding (the embedder was down when this grant landed). The
-- function degrades to whichever side it has rather than returning nothing.
create or replace function search_grants(
  q text,
  q_embedding vector(768),
  q_language text default 'en',
  countries text[] default null,
  pool integer default 200,
  result_limit integer default 60
)
returns table (
  grant_id uuid,
  lexical_rank integer,
  vector_rank integer,
  score numeric
)
language sql stable parallel safe as $$
  with parsed as (
    select case
      when q is null or btrim(q) = '' then null
      else websearch_to_tsquery(grant_text_config(q_language), q)
    end as tsq
  ),
  candidates as (
    select g.id, g.search_tsv
    from grants g
    where g.status = 'open'
      and (countries is null or g.country = any (countries))
  ),
  lexical as (
    select c.id,
           row_number() over (order by ts_rank_cd(c.search_tsv, p.tsq) desc, c.id) as rank
    from candidates c, parsed p
    where p.tsq is not null and c.search_tsv @@ p.tsq
    limit pool
  ),
  semantic as (
    select c.id,
           row_number() over (order by e.embedding <=> q_embedding, c.id) as rank
    from candidates c
    join grant_embeddings e on e.grant_id = c.id
    where q_embedding is not null
    limit pool
  )
  select coalesce(l.id, s.id) as grant_id,
         l.rank::integer as lexical_rank,
         s.rank::integer as vector_rank,
         (coalesce(1.0 / (60 + l.rank), 0) + coalesce(1.0 / (60 + s.rank), 0))::numeric as score
  from lexical l
  full outer join semantic s on s.id = l.id
  order by score desc, grant_id
  limit result_limit;
$$;

-- ── Rule results ────────────────────────────────────────────────────────────
-- A boolean cannot express the answer this product most needs to give: that a
-- rule could not be decided from what the funder published. Collapsing that
-- into "passed = false" would invent restrictions funders never stated, and
-- into "passed = true" would claim verification we did not do.
alter table eligibility_checks add column if not exists status text
  check (status in ('pass', 'fail', 'unknown'));
update eligibility_checks set status = case when passed then 'pass' else 'fail' end
  where status is null;
alter table eligibility_checks alter column status set not null;
alter table eligibility_checks alter column passed drop not null;

-- ── Match provenance ────────────────────────────────────────────────────────
-- Why a grant surfaced at all, kept beside why it was ruled in or out. Without
-- this a consultant can see the verdict but not whether the grant arrived by
-- wording or by meaning, which is the first thing they ask when a result looks
-- wrong.
alter table matches add column if not exists retrieval jsonb not null default '{}'::jsonb;
alter table matches add column if not exists matched_at timestamptz not null default now();

-- The eligible/ineligible split is the main axis of the results screen, and
-- ineligible rows are collapsed rather than dropped, so both are read together.
create index if not exists matches_client_score_idx
  on matches (client_id, relevance desc nulls last);
