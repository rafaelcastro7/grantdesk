-- 0039 redefined public.reject_if_submitted() with a direct reference to
-- new.document_id / old.document_id. The function is shared by every
-- submitted-lock trigger, and requirement_assignments (0038) has no
-- document_id column, so any write to it failed with "record new has no field
-- document_id" instead of being checked against the lock.
--
-- Same behaviour as 0039, reading the column through to_jsonb so the function
-- works on any table: on requirement_acknowledgements, an UPDATE whose only
-- change is document_id becoming null (the register document was deleted and
-- the FK set it null) is allowed; every other write to a submitted
-- application is refused.
create or replace function public.reject_if_submitted()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_row jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  old_row jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  target uuid := coalesce((new_row ->> 'proposal_id')::uuid, (old_row ->> 'proposal_id')::uuid);
begin
  if tg_table_name = 'requirement_acknowledgements' and tg_op = 'UPDATE'
     and new_row ->> 'document_id' is null
     and old_row ->> 'document_id' is not null
     and (new_row - 'document_id') = (old_row - 'document_id') then
    return new;
  end if;
  if exists (select 1 from submissions s where s.proposal_id = target) then
    raise exception 'This application was submitted and is locked.'
      using errcode = 'P0001', hint = 'submitted';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;
