-- Three gaps closed together: nothing ever sent email_outbox, the deadline
-- calendar was a one-off download that went stale the moment it was saved,
-- and a tenant had no way to get reminders into a team chat.

-- 1. Delivery bookkeeping, so a failed send is retried a bounded number of
--    times with backoff instead of never or forever.
alter table email_outbox add column if not exists attempts integer not null default 0;
alter table email_outbox add column if not exists last_attempt_at timestamptz;

create index if not exists email_outbox_failed_idx on email_outbox (status) where status = 'failed';

-- 2. Subscribable calendar feeds. Only a sha256 of the token is stored: the
--    feed URL is a bearer credential, and a database read must not yield one.
create table if not exists calendar_tokens (
  id uuid primary key default gen_random_uuid(),
  consultant_id uuid not null references consultants(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists calendar_tokens_consultant_idx on calendar_tokens (consultant_id);

alter table calendar_tokens enable row level security;

drop policy if exists calendar_tokens_own_read on calendar_tokens;
create policy calendar_tokens_own_read on calendar_tokens
  for select to authenticated using (consultant_id = auth.uid());

drop policy if exists calendar_tokens_own_insert on calendar_tokens;
create policy calendar_tokens_own_insert on calendar_tokens
  for insert to authenticated with check (consultant_id = auth.uid() and revoked_at is null);

drop policy if exists calendar_tokens_own_revoke on calendar_tokens;
create policy calendar_tokens_own_revoke on calendar_tokens
  for update to authenticated
  using (consultant_id = auth.uid())
  with check (consultant_id = auth.uid() and revoked_at is not null);

-- A revoked token stays revoked, and the hash cannot be swapped under a row.
create or replace function public.calendar_token_immutable()
returns trigger language plpgsql
set search_path = public
as $$
begin
  if new.token_hash <> old.token_hash or new.consultant_id <> old.consultant_id
     or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception 'a calendar token can only be revoked';
  end if;
  return new;
end;
$$;

drop trigger if exists calendar_tokens_immutable on calendar_tokens;
create trigger calendar_tokens_immutable before update on calendar_tokens
  for each row execute function public.calendar_token_immutable();

-- 3. Per-tenant chat webhook. tenants is readable by anyone (branding lookup),
--    and a webhook URL is a credential, so browser roles lose table-wide SELECT
--    and get every column except this one back.
alter table tenants add column if not exists alert_webhook_url text
  check (alert_webhook_url is null or alert_webhook_url ~ '^https://');

revoke select on tenants from anon, authenticated;
grant select (id, slug, name, subdomain, branding, created_at) on tenants to anon, authenticated;
revoke update, insert, delete on tenants from anon, authenticated;

create or replace function public.set_tenant_alert_webhook(target_tenant_id uuid, webhook_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from tenant_members
     where tenant_id = target_tenant_id and user_id = auth.uid() and role in ('owner', 'admin')
  ) then
    raise exception 'only a tenant owner or admin can change its alert webhook'
      using errcode = '42501';
  end if;
  update tenants set alert_webhook_url = nullif(trim(webhook_url), '') where id = target_tenant_id;
end;
$$;

-- Members may know whether alerts go to chat, never where.
create or replace function public.tenant_has_alert_webhook(target_tenant_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select belongs_to_tenant(target_tenant_id)
     and exists (select 1 from tenants where id = target_tenant_id and alert_webhook_url is not null);
$$;

revoke execute on function public.set_tenant_alert_webhook(uuid, text) from public, anon;
grant execute on function public.set_tenant_alert_webhook(uuid, text) to authenticated;
revoke execute on function public.tenant_has_alert_webhook(uuid) from public, anon;
grant execute on function public.tenant_has_alert_webhook(uuid) to authenticated;
