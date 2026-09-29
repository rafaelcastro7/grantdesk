-- Findings from the integrity review, each reproduced against this database.

-- 1. A submitted application is the record of what the funder received. The
--    lock lived only in one server function; a section upsert after
--    submission still returned 201. Enforced here for every writer.
create or replace function public.reject_if_submitted()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target uuid := coalesce(new.proposal_id, old.proposal_id);
begin
  if exists (select 1 from submissions s where s.proposal_id = target) then
    raise exception 'This application was submitted and is locked.'
      using errcode = 'P0001', hint = 'submitted';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists proposal_sections_submitted_lock on proposal_sections;
create trigger proposal_sections_submitted_lock
  before insert or update or delete on proposal_sections
  for each row execute function public.reject_if_submitted();

drop trigger if exists requirement_acks_submitted_lock on requirement_acknowledgements;
create trigger requirement_acks_submitted_lock
  before insert or update or delete on requirement_acknowledgements
  for each row execute function public.reject_if_submitted();

-- 2. Two people saving one section: the "previous version" was the browser's
--    copy, so the other person's save was overwritten and never kept. This
--    saves under a row lock, keeps the database's current text as a revision,
--    and refuses when the section changed since the caller loaded it.
create or replace function public.save_section(
  target_proposal uuid,
  target_requirement uuid,
  new_heading text,
  new_content text,
  new_word_count integer,
  new_drafted_by text,
  new_fabrication_concerns jsonb,
  new_reused_answer_ids uuid[],
  expected_updated_at timestamptz
)
returns timestamptz
language plpgsql security invoker set search_path = public as $$
declare
  current_row proposal_sections%rowtype;
  saved_at timestamptz := clock_timestamp();
begin
  select * into current_row
    from proposal_sections
   where proposal_id = target_proposal and requirement_id = target_requirement
   for update;

  if found then
    if expected_updated_at is not null and current_row.updated_at <> expected_updated_at then
      raise exception 'This section was changed by someone else since you opened it.'
        using errcode = 'P0001', hint = 'conflict';
    end if;
    if coalesce(trim(current_row.content), '') <> '' then
      insert into proposal_section_revisions (proposal_id, requirement_id, content, word_count, drafted_by)
      values (target_proposal, target_requirement, current_row.content, current_row.word_count, current_row.drafted_by);
    end if;
    update proposal_sections
       set heading = new_heading,
           content = new_content,
           word_count = new_word_count,
           drafted_by = new_drafted_by,
           fabrication_concerns = coalesce(new_fabrication_concerns, '[]'::jsonb),
           reused_answer_ids = coalesce(new_reused_answer_ids, '{}'),
           updated_at = saved_at
     where id = current_row.id;
  else
    insert into proposal_sections
      (proposal_id, requirement_id, heading, content, word_count, drafted_by,
       fabrication_concerns, reused_answer_ids, sort_order, updated_at)
    values
      (target_proposal, target_requirement, new_heading, new_content, new_word_count,
       new_drafted_by, coalesce(new_fabrication_concerns, '[]'::jsonb),
       coalesce(new_reused_answer_ids, '{}'), 0, saved_at);
  end if;
  return saved_at;
end $$;

grant execute on function public.save_section(uuid, uuid, text, text, integer, text, jsonb, uuid[], timestamptz)
  to authenticated;

-- 3. Offboarding. Deleting a consultant failed (HTTP 500 from auth) whenever
--    they had reviewed a submission, acknowledged a condition or added a
--    teammate. The record keeps its facts; the person reference goes null.
alter table submissions alter column human_reviewed_by drop not null;
alter table submissions drop constraint if exists submissions_human_reviewed_by_fkey;
alter table submissions add constraint submissions_human_reviewed_by_fkey
  foreign key (human_reviewed_by) references consultants(id) on delete set null;

alter table requirement_acknowledgements alter column acknowledged_by drop not null;
alter table requirement_acknowledgements drop constraint if exists requirement_acknowledgements_acknowledged_by_fkey;
alter table requirement_acknowledgements add constraint requirement_acknowledgements_acknowledged_by_fkey
  foreign key (acknowledged_by) references consultants(id) on delete set null;

alter table client_team_members drop constraint if exists client_team_members_added_by_fkey;
alter table client_team_members add constraint client_team_members_added_by_fkey
  foreign key (added_by) references consultants(id) on delete set null;

-- 4. Money that cannot be negative or inverted.
alter table grants drop constraint if exists grants_amounts_sane;
alter table grants add constraint grants_amounts_sane check (
  (amount_min is null or amount_min >= 0)
  and (amount_max is null or amount_max >= 0)
  and (amount_min is null or amount_max is null or amount_min <= amount_max)
);
alter table opportunity_decisions drop constraint if exists opportunity_decisions_amounts_sane;
alter table opportunity_decisions add constraint opportunity_decisions_amounts_sane check (
  coalesce(request_amount, 0) >= 0 and coalesce(net_revenue, 0) >= 0
  and coalesce(match_required, 0) >= 0 and coalesce(in_kind_cap, 0) >= 0
);
