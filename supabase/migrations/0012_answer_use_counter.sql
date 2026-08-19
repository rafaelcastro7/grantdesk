-- The answer library counted nothing.
--
-- `times_used` was in the schema from the start and never incremented, so the
-- one question the library exists to answer — which of this client's answers
-- actually earn their keep — had no data behind it. An UPDATE ... SET x = x + 1
-- cannot be expressed through PostgREST, hence a function.
create or replace function record_answer_use(answer_ids uuid[])
returns void
language sql security invoker as $$
  update answer_library
     set times_used = times_used + 1,
         last_used_at = now()
   where id = any (answer_ids);
$$;

grant execute on function public.record_answer_use(uuid[]) to authenticated;
