-- Owners and internal due dates per requirement, and the SOP's Stage 2 checks
-- on the brief. A firm running thirty clients needs "who has this, by when"
-- more than it needs another screen; both live on screens that already exist.

create table if not exists requirement_assignments (
  proposal_id uuid not null references proposals(id) on delete cascade,
  requirement_id uuid not null references requirements(id) on delete cascade,
  owner_id uuid references consultants(id) on delete set null,
  due_on date,
  done_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (proposal_id, requirement_id)
);

create index if not exists requirement_assignments_owner_idx
  on requirement_assignments (owner_id) where owner_id is not null;

alter table requirement_assignments enable row level security;

create policy requirement_assignments_select on requirement_assignments
  for select to authenticated using (
    exists (select 1 from proposals p where p.id = proposal_id and public.owns_client(p.client_id))
  );
create policy requirement_assignments_insert on requirement_assignments
  for insert to authenticated with check (
    exists (select 1 from proposals p where p.id = proposal_id and public.owns_client(p.client_id))
  );
create policy requirement_assignments_update on requirement_assignments
  for update to authenticated
  using (exists (select 1 from proposals p where p.id = proposal_id and public.owns_client(p.client_id)))
  with check (exists (select 1 from proposals p where p.id = proposal_id and public.owns_client(p.client_id)));
create policy requirement_assignments_delete on requirement_assignments
  for delete to authenticated using (
    exists (select 1 from proposals p where p.id = proposal_id and public.owns_client(p.client_id))
  );

-- RLS proves the caller may touch the application, not that the owner they
-- named works on it or that the requirement belongs to it. Assigning a section
-- to someone outside the client's team would hand them a task they can never
-- open; pairing a requirement from another call (or another client's manual
-- heading) with this proposal would leak its label into a list it is not on.
create or replace function public.check_requirement_assignment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target_client uuid;
  target_grant uuid;
begin
  select p.client_id, p.grant_id into target_client, target_grant
    from proposals p where p.id = new.proposal_id;

  if not exists (
    select 1 from requirements r
     where r.id = new.requirement_id
       and r.grant_id = target_grant
       and (r.client_id is null or r.client_id = target_client)
  ) then
    raise exception 'That requirement does not belong to this application.'
      using errcode = 'P0001', hint = 'requirement';
  end if;

  if new.owner_id is not null and not exists (
    select 1 from clients c where c.id = target_client and c.consultant_id = new.owner_id
    union all
    select 1 from client_team_members m where m.client_id = target_client and m.user_id = new.owner_id
  ) then
    raise exception 'The owner must be on this client''s team.'
      using errcode = 'P0001', hint = 'owner';
  end if;

  new.updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists requirement_assignments_check on requirement_assignments;
create trigger requirement_assignments_check
  before insert or update on requirement_assignments
  for each row execute function public.check_requirement_assignment();

drop trigger if exists requirement_assignments_submitted_lock on requirement_assignments;
create trigger requirement_assignments_submitted_lock
  before insert or update or delete on requirement_assignments
  for each row execute function public.reject_if_submitted();

-- Consultants can read only their own row (0002), so an owner's name is
-- otherwise invisible to the teammate who assigned them. This returns the
-- team of every client the caller works on — owner plus members — and
-- nothing about anyone else.
create or replace function public.client_team_roster(target uuid default null)
returns table (client_id uuid, user_id uuid, email text, display_name text, is_owner boolean)
language sql stable security definer set search_path = public as $$
  select c.id, k.id, k.email, k.display_name, true
    from clients c join consultants k on k.id = c.consultant_id
   where (target is null or c.id = target) and public.owns_client(c.id)
  union
  select c.id, k.id, k.email, k.display_name, false
    from clients c
    join client_team_members m on m.client_id = c.id
    join consultants k on k.id = m.user_id
   where (target is null or c.id = target) and public.owns_client(c.id)
     and m.user_id <> c.consultant_id;
$$;

revoke all on function public.client_team_roster(uuid) from public, anon;
grant execute on function public.client_team_roster(uuid) to authenticated;

-- Stage 2 of the SOP: who was pitched, who approved the pitch, and who checked
-- the cash match and delivery capacity, on which day. Typed names, like
-- decided_by: they record a claim a person made, which is what the SOP asks.
alter table opportunity_decisions
  add column if not exists partner_contact text,
  add column if not exists pitch_approved_by text,
  add column if not exists cash_match_verified_by text,
  add column if not exists cash_match_verified_on date,
  add column if not exists capacity_verified_by text,
  add column if not exists capacity_verified_on date;
