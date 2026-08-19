-- A multilingual embedder, because the eval refuted the claim in ADR-0004.
--
-- That ADR asserted that cross-language matching is "the vector side's job".
-- Nobody had ever measured it. Adding French and Spanish rows to the labelled
-- corpus put a number on it: **33% cross-language recall** — the Spanish row
-- was found, both French rows were missed entirely.
--
-- Measured directly, against an English profile about ravine restoration:
--
--                      relevant FR   irrelevant FR   separation
--   nomic-embed-text      0.5537        0.4699         0.084
--   bge-m3                0.7557        0.5299         0.226
--
-- nomic-embed-text is an English model. It rates a relevant French call barely
-- above an irrelevant one, and a gap that small does not survive three thousand
-- English documents competing for the same ranking. bge-m3 is explicitly
-- multilingual and separates them cleanly — it even scores the French call
-- above the English control.
--
-- This matters because the product claims the Américas, in four languages. With
-- an English-only embedder the semantic half of retrieval was English-only too,
-- and every French or Spanish call in the catalog was reachable by exact
-- wording alone. That is the failure mode this whole design exists to avoid.
--
-- 1024 dimensions rather than 768, so every stored vector must be recomputed.
-- They are dropped rather than converted: there is no meaningful conversion
-- between two models' spaces, and a half-migrated index would return confident
-- nonsense instead of an error.

drop index if exists grant_embeddings_hnsw_idx;
drop index if exists answer_library_embedding_idx;

truncate table grant_embeddings;
alter table grant_embeddings alter column embedding type vector(1024);

update answer_library set embedding = null;
alter table answer_library alter column embedding type vector(1024);

create index grant_embeddings_hnsw_idx
  on grant_embeddings using hnsw (embedding vector_cosine_ops);
create index answer_library_embedding_idx
  on answer_library using hnsw (embedding vector_cosine_ops);

-- Both retrieval functions take a query vector, so both change width. Dropped
-- first: changing a parameter type is a new signature, not a replacement, and
-- leaving the old one behind means a caller can silently bind to the 768
-- version forever.
drop function if exists search_grants(text, vector, text, text[], integer, integer);
drop function if exists match_answers(uuid, vector, integer, numeric);

create or replace function search_grants(
  q text,
  q_embedding vector(1024),
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

create or replace function match_answers(
  target_client uuid,
  q_embedding vector(1024),
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

grant execute on function public.search_grants(text, vector, text, text[], integer, integer)
  to authenticated;
grant execute on function public.match_answers(uuid, vector, integer, numeric) to authenticated;
