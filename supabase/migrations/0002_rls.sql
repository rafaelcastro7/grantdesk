-- Row-level security. For a consultant tool this is not hygiene, it is the
-- product claim: one client's material is unreachable from another's session,
-- enforced by the database rather than by remembering to add a WHERE clause.
--
-- Shape: everything client-scoped resolves ownership through clients.consultant_id
-- back to auth.uid(). The catalog (funders/grants/awards) is shared reference
-- data — readable by any signed-in consultant, writable only by service_role.

alter table consultants          enable row level security;
alter table clients              enable row level security;
alter table client_profiles      enable row level security;
alter table matches              enable row level security;
alter table eligibility_checks   enable row level security;
alter table proposals            enable row level security;
alter table proposal_sections    enable row level security;
alter table answer_library       enable row level security;
alter table submissions          enable row level security;
alter table agent_runs           enable row level security;
alter table funders              enable row level security;
alter table grants               enable row level security;
alter table grant_embeddings     enable row level security;
alter table past_awards          enable row level security;
alter table requirements         enable row level security;

-- Owns this client? Used by every client-scoped policy below.
create or replace function public.owns_client(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from clients c
    where c.id = target and c.consultant_id = auth.uid()
  );
$$;
grant execute on function public.owns_client(uuid) to authenticated;

-- ── Identity ────────────────────────────────────────────────────────────────
create policy consultants_self_read on consultants
  for select to authenticated using (id = auth.uid());
create policy consultants_self_write on consultants
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ── Clients and their profile ───────────────────────────────────────────────
create policy clients_own_all on clients
  for all to authenticated
  using (consultant_id = auth.uid())
  with check (consultant_id = auth.uid());

create policy client_profiles_own_all on client_profiles
  for all to authenticated
  using (public.owns_client(client_id))
  with check (public.owns_client(client_id));

-- ── Shared catalog: read for any consultant, writes via service_role only ────
create policy funders_read on funders for select to authenticated using (true);
create policy grants_read on grants for select to authenticated using (true);
create policy grant_embeddings_read on grant_embeddings for select to authenticated using (true);
create policy past_awards_read on past_awards for select to authenticated using (true);
create policy requirements_read on requirements for select to authenticated using (true);

-- ── Work product ────────────────────────────────────────────────────────────
create policy matches_own_all on matches
  for all to authenticated
  using (public.owns_client(client_id))
  with check (public.owns_client(client_id));

create policy eligibility_checks_own_read on eligibility_checks
  for select to authenticated
  using (exists (
    select 1 from matches m
    where m.id = eligibility_checks.match_id and public.owns_client(m.client_id)
  ));

create policy proposals_own_all on proposals
  for all to authenticated
  using (public.owns_client(client_id))
  with check (public.owns_client(client_id));

create policy proposal_sections_own_all on proposal_sections
  for all to authenticated
  using (exists (
    select 1 from proposals p
    where p.id = proposal_sections.proposal_id and public.owns_client(p.client_id)
  ))
  with check (exists (
    select 1 from proposals p
    where p.id = proposal_sections.proposal_id and public.owns_client(p.client_id)
  ));

create policy answer_library_own_all on answer_library
  for all to authenticated
  using (public.owns_client(client_id))
  with check (public.owns_client(client_id));

create policy submissions_own_all on submissions
  for all to authenticated
  using (exists (
    select 1 from proposals p
    where p.id = submissions.proposal_id and public.owns_client(p.client_id)
  ))
  with check (exists (
    select 1 from proposals p
    where p.id = submissions.proposal_id and public.owns_client(p.client_id)
  ));

create policy agent_runs_own_read on agent_runs
  for select to authenticated
  using (client_id is null or public.owns_client(client_id));

-- A new auth.users row becomes a consultant automatically; without this the
-- first request after signup has no row to resolve ownership against.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.consultants (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
