-- Permissions for the Phase 3 matching path.
--
-- Split from 0005 because that migration had already been applied: an applied
-- migration is history, and editing it in place makes the file disagree with
-- every database that ran it.

-- Rule results were readable but not writable, which made the matching run
-- impossible to perform as the consultant themselves. Writing them under the
-- service role instead would have moved the ownership check out of the
-- database and into application code, where it is easier to get wrong.
drop policy if exists eligibility_checks_own_write on eligibility_checks;
create policy eligibility_checks_own_write on eligibility_checks
  for insert to authenticated
  with check (exists (
    select 1 from matches m
    where m.id = eligibility_checks.match_id and public.owns_client(m.client_id)
  ));

drop policy if exists eligibility_checks_own_delete on eligibility_checks;
create policy eligibility_checks_own_delete on eligibility_checks
  for delete to authenticated
  using (exists (
    select 1 from matches m
    where m.id = eligibility_checks.match_id and public.owns_client(m.client_id)
  ));

-- Retrieval reads the catalog, which is shared reference data; the function is
-- stable and takes no user identity, so it is safe for any signed-in caller.
grant execute on function public.search_grants(text, vector, text, text[], integer, integer)
  to authenticated;
grant execute on function public.grant_text_config(text) to authenticated;
