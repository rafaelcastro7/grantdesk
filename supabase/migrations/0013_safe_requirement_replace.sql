-- Re-reading a call must not delete a requirement someone else is writing
-- against.
--
-- The replace added in the previous pass decided what was safe to remove by
-- reading `proposal_sections` as the caller — and row-level security means the
-- caller sees only their own. So consultant A re-reading a shared call would
-- happily delete a requirement consultant B had already drafted a section for.
-- `proposal_sections.requirement_id` is `on delete set null`, so B's work
-- survived in the table but lost its link, and the proposal screen maps
-- sections by requirement: B's section simply vanished from B's screen, with no
-- error anywhere.
--
-- Requirements are shared reference data, so the check has to see across every
-- consultant. That needs SECURITY DEFINER — the one place in this schema where
-- stepping outside RLS is the correct answer rather than a shortcut, because
-- the question being asked ("is anyone at all writing against this?") is
-- genuinely not the caller's to answer from their own rows.
--
-- It deletes only rows this app extracted (`extracted_from is not null`), so a
-- heading the consultant typed from the funder's own form is never touched.
create or replace function replace_extracted_requirements(target_grant uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  with deleted as (
    delete from requirements r
     where r.grant_id = target_grant
       and r.extracted_from is not null
       and not exists (
         select 1 from proposal_sections ps where ps.requirement_id = r.id
       )
    returning 1
  )
  select count(*) into removed from deleted;
  return removed;
end;
$$;

grant execute on function public.replace_extracted_requirements(uuid) to authenticated;
