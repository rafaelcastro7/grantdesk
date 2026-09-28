-- 0025_tenants_and_subdomains.sql
-- Enterprise Multi-Tenancy with Subdomain Routing & Strict Database Isolation (RLS)
--
-- Enables dedicated tenant workspaces (e.g. IIAL) such that one tenant's material
-- is unreachable by another, enforced at the PostgreSQL RLS level.

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  subdomain text unique not null,
  branding jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists tenants_slug_idx on tenants (slug);
create index if not exists tenants_subdomain_idx on tenants (subdomain);

create table if not exists tenant_members (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references consultants(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')) default 'member',
  joined_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index if not exists tenant_members_user_idx on tenant_members (user_id);

-- Add tenant_id to clients with default IIAL tenant
alter table clients
  add column if not exists tenant_id uuid references tenants(id) on delete cascade default '11111111-1111-1111-1111-111111111111'::uuid;

create index if not exists clients_tenant_idx on clients (tenant_id);

-- Seed IIAL as the pioneer tenant
insert into tenants (id, slug, name, subdomain, branding)
values (
  '11111111-1111-1111-1111-111111111111',
  'iial',
  'Institute of Innovation and Advanced Learning',
  'iial',
  '{"tagline": "AI-Native Grant Intelligence", "primary_color": "#0ea5e9", "accent_color": "#0284c7", "logo_url": "/brand/iial-logo.png", "logo_inverse_url": "/brand/iial-logo-inverse.png"}'::jsonb
)
on conflict (slug) do update set
  name = excluded.name,
  branding = excluded.branding;

-- Backfill any existing clients with the IIAL tenant
update clients
set tenant_id = '11111111-1111-1111-1111-111111111111'
where tenant_id is null;

-- Backfill all existing consultants as members of the IIAL tenant
insert into tenant_members (tenant_id, user_id, role)
select '11111111-1111-1111-1111-111111111111', id, 'owner'
from consultants
on conflict (tenant_id, user_id) do nothing;

-- Ensure newly signed up users belong to IIAL by default
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

  insert into public.tenant_members (tenant_id, user_id, role)
  values ('11111111-1111-1111-1111-111111111111', new.id, 'member')
  on conflict (tenant_id, user_id) do nothing;

  return new;
end;
$$;

-- ── RLS for tenants & tenant_members ───────────────────────────────────────
alter table tenants enable row level security;
alter table tenant_members enable row level security;

-- Public lookup by slug/subdomain for branding & metadata resolution
drop policy if exists tenants_public_read on tenants;
create policy tenants_public_read on tenants
  for select using (true);

-- Users can only read their own tenant memberships (prevents infinite policy recursion)
drop policy if exists tenant_members_read on tenant_members;
create policy tenant_members_read on tenant_members
  for select to authenticated
  using (user_id = auth.uid());

-- Helper function: Does auth.uid() belong to this tenant? Security definer bypasses RLS recursion.
create or replace function public.belongs_to_tenant(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (target_tenant_id is null) or exists (
    select 1 from tenant_members tm
    where tm.tenant_id = target_tenant_id and tm.user_id = auth.uid()
  );
$$;
grant execute on function public.belongs_to_tenant(uuid) to authenticated;

-- Helper function to resolve tenant id by slug
create or replace function public.get_tenant_id_by_slug(target_slug text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from tenants where lower(slug) = lower(target_slug) limit 1;
$$;
grant execute on function public.get_tenant_id_by_slug(text) to authenticated, anon;

-- Enhanced owns_client(target uuid) enforcing tenant boundaries
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
      and public.belongs_to_tenant(c.tenant_id)
      and (
        c.consultant_id = auth.uid()
        or exists (
          select 1 from client_team_members m
          where m.client_id = c.id and m.user_id = auth.uid()
        )
      )
  );
$$;

-- Enhanced clients RLS policies
drop policy if exists clients_select on clients;
create policy clients_select on clients
  for select to authenticated
  using (
    public.belongs_to_tenant(tenant_id)
    and (
      consultant_id = auth.uid()
      or exists (
        select 1 from client_team_members m where m.client_id = id and m.user_id = auth.uid()
      )
    )
  );

drop policy if exists clients_insert on clients;
create policy clients_insert on clients
  for insert to authenticated
  with check (
    consultant_id = auth.uid()
    and public.belongs_to_tenant(tenant_id)
  );

drop policy if exists clients_update on clients;
create policy clients_update on clients
  for update to authenticated
  using (
    public.belongs_to_tenant(tenant_id)
    and (
      consultant_id = auth.uid()
      or exists (
        select 1 from client_team_members m where m.client_id = id and m.user_id = auth.uid()
      )
    )
  )
  with check (
    public.belongs_to_tenant(tenant_id)
    and (
      consultant_id = auth.uid()
      or exists (
        select 1 from client_team_members m where m.client_id = id and m.user_id = auth.uid()
      )
    )
  );
