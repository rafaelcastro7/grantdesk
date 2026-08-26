-- A client belongs to the consultant who created it, plus whoever else at the
-- same firm has been added to it. Every downstream table's RLS policy already
-- routes through owns_client() rather than checking clients.consultant_id
-- directly — that choke point is what makes this a one-function change
-- instead of a rewrite of every policy in 0002_rls.sql.
--
-- Team membership is deliberately flat: a member sees and edits the same
-- material the owner does (matches, proposals, checks, submissions), matching
-- how the products actually used for this (Foundant, Submittable) model a
-- shared account — nobody asked for per-section permissions, and building
-- them now would be solving a problem this product doesn't have yet.
-- Two things stay owner-only, because a member being able to do them would
-- let anyone with access to one shared client silently expand who has it:
-- adding a new member, and removing someone other than themselves.
create table if not exists client_team_members (
  client_id uuid not null references clients(id) on delete cascade,
  user_id uuid not null references consultants(id) on delete cascade,
  added_by uuid not null references consultants(id),
  added_at timestamptz not null default now(),
  primary key (client_id, user_id)
);

create index if not exists client_team_members_user_idx on client_team_members (user_id);

-- Ownership transfer isn't a feature, and letting a team member's own update
-- reassign it would be one by accident — an RLS with-check trying to enforce
-- "consultant_id may not change" via a subquery back into clients hits the
-- same same-command visibility problem solved below for insert. A trigger
-- reading OLD directly has no such problem, so pin it here instead.
create or replace function public.pin_client_ownership()
returns trigger
language plpgsql
as $$
begin
  new.consultant_id := old.consultant_id;
  return new;
end;
$$;

drop trigger if exists pin_client_ownership on clients;
create trigger pin_client_ownership
  before update on clients
  for each row execute function public.pin_client_ownership();

create or replace function public.owns_client(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from clients c
    where c.id = target
      and (
        c.consultant_id = auth.uid()
        or exists (
          select 1 from client_team_members m
          where m.client_id = c.id and m.user_id = auth.uid()
        )
      )
  );
$$;

-- Adding a teammate needs their id, and a member can only ever look up their
-- own row (consultants_self_read, in 0002_rls.sql) — this is the one
-- deliberate, narrow exception: given an email, hand back the id it resolves
-- to and nothing else about that account. Returning null for an unknown email
-- is what lets the caller say "no account with that email yet" instead of a
-- generic failure.
create or replace function public.find_consultant_by_email(target_email text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from consultants where lower(email) = lower(target_email) limit 1;
$$;
grant execute on function public.find_consultant_by_email(text) to authenticated;

-- clients itself doesn't go through owns_client() before this migration
-- (0002_rls.sql checked consultant_id directly), and insert is why: owns_client
-- looks the row up by id, which doesn't exist yet mid-insert, so folding
-- insert into it would reject every new client. Split by command instead —
-- creation stays owner-only, everything else opens to the team.
drop policy if exists clients_own_all on clients;

-- Deliberately not owns_client(id) here, even though every other table's
-- policy in this file routes through it. owns_client() re-queries clients by
-- id, and a self-referential subquery on the table a statement is writing to
-- cannot see that statement's own new row — Postgres evaluates it against the
-- snapshot from before the statement started. INSERT ... RETURNING (exactly
-- what the app does on every client creation) hit this immediately: the row
-- inserted fine, then its own RETURNING clause failed RLS because the SELECT
-- policy asked owns_client() to find a row that, from its subquery's point of
-- view, did not exist yet. The two-table check below has nowhere to have that
-- problem, because client_team_members is never the table being written here.
create policy clients_insert on clients
  for insert to authenticated
  with check (consultant_id = auth.uid());

create policy clients_select on clients
  for select to authenticated
  using (
    consultant_id = auth.uid()
    or exists (
      select 1 from client_team_members m where m.client_id = id and m.user_id = auth.uid()
    )
  );

-- A team member may update the row (rename it, edit its website, archive it)
-- but the with check below still rejects any attempt to change who owns it —
-- ownership transfer isn't a feature here, and letting an update quietly
-- reassign consultant_id would be one. The check is safe from the
-- insert/returning problem above: on UPDATE the row already existed before
-- the statement started, so re-reading its (unchanged) id is fine.
create policy clients_update on clients
  for update to authenticated
  using (
    consultant_id = auth.uid()
    or exists (
      select 1 from client_team_members m where m.client_id = id and m.user_id = auth.uid()
    )
  )
  with check (
    consultant_id = auth.uid()
    or exists (
      select 1 from client_team_members m where m.client_id = id and m.user_id = auth.uid()
    )
  );

create policy clients_delete on clients
  for delete to authenticated
  using (consultant_id = auth.uid());

alter table client_team_members enable row level security;

create policy client_team_members_read on client_team_members
  for select to authenticated
  using (public.owns_client(client_id));

create policy client_team_members_owner_insert on client_team_members
  for insert to authenticated
  with check (
    exists (select 1 from clients c where c.id = client_id and c.consultant_id = auth.uid())
  );

-- A member may remove themselves (leave a shared client); only the owner may
-- remove anyone else.
create policy client_team_members_delete on client_team_members
  for delete to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from clients c where c.id = client_id and c.consultant_id = auth.uid())
  );
