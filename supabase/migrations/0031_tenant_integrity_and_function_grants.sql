-- Tenant isolation had three holes, each verified against this database:
--   * belongs_to_tenant(NULL) returned true, and the app creates clients
--     without a tenant_id — so every client made from the UI sat outside
--     tenant isolation entirely (20 rows at the time of writing).
--   * email_outbox was readable by every member of a tenant, exposing other
--     consultants' client names and recipients.
--   * SECURITY DEFINER helpers were executable by anon: one could wipe
--     extracted requirements catalog-wide, one confirmed which emails are
--     registered and returned their user id.

-- 1. A client always has a tenant: the creator's own, when not given.
create or replace function public.default_client_tenant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.tenant_id is null then
    select tm.tenant_id into new.tenant_id
      from tenant_members tm
     where tm.user_id = new.consultant_id
     order by tm.joined_at
     limit 1;
  end if;
  if new.tenant_id is null then
    raise exception 'client % has no tenant: its consultant belongs to none', new.name;
  end if;
  return new;
end $$;

drop trigger if exists clients_default_tenant on clients;
create trigger clients_default_tenant
  before insert on clients
  for each row execute function public.default_client_tenant();

update clients c
   set tenant_id = (select tm.tenant_id from tenant_members tm
                     where tm.user_id = c.consultant_id order by tm.joined_at limit 1)
 where c.tenant_id is null;

alter table clients alter column tenant_id set not null;

create or replace function public.belongs_to_tenant(target_tenant_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select target_tenant_id is not null and exists (
    select 1 from tenant_members tm
    where tm.tenant_id = target_tenant_id and tm.user_id = auth.uid()
  );
$$;

-- 2. Queued email is visible to the client's own team or its recipient.
alter table email_outbox alter column tenant_id drop default;
delete from email_outbox where tenant_id is null;
alter table email_outbox alter column tenant_id set not null;

drop policy if exists email_outbox_read on email_outbox;
create policy email_outbox_read on email_outbox
  for select to authenticated
  using (
    belongs_to_tenant(tenant_id)
    and (
      (client_id is not null and public.owns_client(client_id))
      or lower(recipient_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

-- 3. Definer helpers: only who needs them.
revoke execute on function public.replace_extracted_requirements(uuid) from public, anon, authenticated;
grant execute on function public.replace_extracted_requirements(uuid) to service_role;

revoke execute on function public.find_consultant_by_email(text) from public, anon;
grant execute on function public.find_consultant_by_email(text) to authenticated;

-- Only answers for someone in a tenant the caller also belongs to.
create or replace function public.find_consultant_by_email(target_email text)
returns uuid language sql stable security definer set search_path = public as $$
  select c.id
    from consultants c
   where lower(c.email) = lower(target_email)
     and exists (
       select 1 from tenant_members mine
         join tenant_members theirs on theirs.tenant_id = mine.tenant_id
        where mine.user_id = auth.uid() and theirs.user_id = c.id
     )
   limit 1;
$$;
