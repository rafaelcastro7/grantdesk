-- The answer library goes back to a 768-wide column, on measurement.
--
-- 0014 moved everything to bge-m3 because the eval proved cross-language
-- retrieval was broken. That was right for grants and wrong for answers, and
-- the drafting eval caught it immediately: reuse fell to 0%, and with no
-- approved facts to work from the model then fabricated numbers in 67% of
-- drafts. One knock-on chain, visible in one run.
--
-- Retrieving grants and retrieving a consultant's own answers look like the
-- same problem and are not. Grants are long documents in four languages.
-- Answers are short English passages matched against a short requirement
-- heading, and bge-m3 ranks the right answer below unrelated ones there — at
-- every phrasing tried. See the measurement in src/server/embed.ts.
--
-- The two spaces never meet: grant vectors are only ever compared to grant
-- queries, answer vectors only to requirement queries. Different jobs,
-- different models, and neither can silently be used for the other because the
-- widths differ.
drop index if exists answer_library_embedding_idx;

update answer_library set embedding = null;
alter table answer_library alter column embedding type vector(768);

create index answer_library_embedding_idx
  on answer_library using hnsw (embedding vector_cosine_ops);

drop function if exists match_answers(uuid, vector, integer, numeric);

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
