-- 0043_tenant_email_domains.sql
--
-- Until now handle_new_user put every sign-up into the IIAL tenant, so anyone
-- who could reach the sign-in page (and, with OAuth, anyone holding a Google or
-- Microsoft account) became a member of IIAL's workspace. A sign-up now joins a
-- tenant only when that tenant lists the email's domain; everyone else gets a
-- personal tenant of their own.

alter table tenants
  add column if not exists allowed_email_domains text[] not null default '{}';

-- Nobody current is moved: IIAL allows exactly the domains its members already
-- sign in from. Public mailbox providers are excluded because allowing one would
-- admit every account at that provider, not a colleague.
update tenants t
   set allowed_email_domains = coalesce((
     select array_agg(distinct split_part(lower(c.email), '@', 2) order by split_part(lower(c.email), '@', 2))
       from tenant_members tm
       join consultants c on c.id = tm.user_id
      where tm.tenant_id = t.id
        and c.email like '%@%'
        and split_part(lower(c.email), '@', 2) not in (
          'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
          'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com'
        )
   ), '{}')
 where t.id = '11111111-1111-1111-1111-111111111111';

create index if not exists tenants_allowed_email_domains_idx
  on tenants using gin (allowed_email_domains);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  email_domain text := nullif(split_part(lower(coalesce(new.email, '')), '@', 2), '');
  local_part text;
  target_tenant uuid;
  personal_slug text;
begin
  insert into public.consultants (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'display_name', new.email))
  on conflict (id) do nothing;

  if email_domain is not null then
    -- Oldest tenant wins if two ever list the same domain, so the choice is
    -- stable rather than whatever order the planner returns.
    select t.id into target_tenant
      from public.tenants t
     where email_domain = any (t.allowed_email_domains)
     order by t.created_at, t.id
     limit 1;
  end if;

  if target_tenant is not null then
    insert into public.tenant_members (tenant_id, user_id, role)
    values (target_tenant, new.id, 'member')
    on conflict (tenant_id, user_id) do nothing;
    return new;
  end if;

  local_part := regexp_replace(lower(split_part(coalesce(new.email, ''), '@', 1)), '[^a-z0-9]+', '-', 'g');
  local_part := left(trim(both '-' from local_part), 40);
  if local_part = '' then
    local_part := 'desk';
  end if;
  -- The suffix comes from the user id, which is unique, so two people named
  -- "info@" at different domains cannot collide on slug or subdomain.
  personal_slug := local_part || '-' || substr(replace(new.id::text, '-', ''), 1, 6);

  insert into public.tenants (slug, name, subdomain, branding)
  values (personal_slug, coalesce(new.email, personal_slug), personal_slug, '{}'::jsonb)
  returning id into target_tenant;

  insert into public.tenant_members (tenant_id, user_id, role)
  values (target_tenant, new.id, 'owner');

  return new;
end;
$$;

-- tenants is publicly readable for branding; the domain list is who-may-join
-- policy and has no business being enumerable by an anonymous visitor.
revoke select on tenants from anon, authenticated;
grant select (id, slug, name, subdomain, branding, created_at) on tenants to anon, authenticated;
