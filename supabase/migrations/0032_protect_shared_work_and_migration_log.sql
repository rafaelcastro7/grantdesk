-- Three defects from the third audit, each checked against this database.

-- 1. Re-reading a call deleted every extracted requirement nobody had drafted
--    against — including ones other tenants had ticked as satisfied or had an
--    assessment cached for, both of which cascade away with it. A requirement
--    anyone has touched in any way stays.
create or replace function public.replace_extracted_requirements(target_grant uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  removed integer;
begin
  with deleted as (
    delete from requirements r
     where r.grant_id = target_grant
       and r.client_id is null
       and r.extracted_from is not null
       and not exists (select 1 from proposal_sections ps where ps.requirement_id = r.id)
       and not exists (select 1 from requirement_acknowledgements a where a.requirement_id = r.id)
       and not exists (select 1 from requirement_assessments s where s.requirement_id = r.id)
     returning 1
  )
  select count(*) into removed from deleted;
  return removed;
end $$;

revoke execute on function public.replace_extracted_requirements(uuid) from public, anon, authenticated;
grant execute on function public.replace_extracted_requirements(uuid) to service_role;

-- 2. The migration log was writable by any signed-in user through the API:
--    deleting a row re-runs a migration, inserting one skips it.
revoke all on public.schema_migrations from anon, authenticated;
alter table public.schema_migrations enable row level security;

-- 3. A client's tenant is as fixed as its owner; a member of two tenants
--    could otherwise move a client between them.
create or replace function public.pin_client_ownership()
returns trigger language plpgsql as $$
begin
  new.consultant_id := old.consultant_id;
  new.tenant_id := old.tenant_id;
  return new;
end $$;
