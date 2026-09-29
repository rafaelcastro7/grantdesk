-- Per-tenant outgoing email, editable from /settings/email.
--
-- A tenant starts on whatever mailbox it has (a Gmail account with an App
-- Password) and later moves to its own (IIAL's). Changing mailbox is an edit,
-- not a redeploy, so the settings live here rather than in environment
-- variables. The env RESEND_API_KEY / EMAIL_FROM stay as the fallback for a
-- tenant that has saved nothing.
--
-- Secret handling
--   * The SMTP password / Resend key is stored only as pgp_sym_encrypt output
--     in secret_encrypted. The symmetric key is EMAIL_SETTINGS_KEY, which lives
--     only in the server environment and never in the database: a dump or a
--     backup of this table alone cannot yield the secret.
--   * Browser roles have no grant on secret_encrypted, and no write grant on
--     the table at all. The only write path is set_tenant_email_settings(),
--     which the server calls *as the signed-in user* (so auth.uid() and the
--     owner/admin check are the database's, not TypeScript's) and passes the
--     key as an argument. A null secret keeps the stored one.
--   * Decryption is get_tenant_email_transports(key), executable by
--     service_role only: the outbox sender and the "send test email" action
--     are the only readers of a plaintext secret.

create table if not exists tenant_email_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  provider text not null check (provider in ('smtp', 'resend')),
  from_name text check (from_name is null or length(from_name) <= 120),
  from_address text not null check (from_address ~* '^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$'),
  reply_to text check (reply_to is null or reply_to ~* '^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$'),
  smtp_host text,
  smtp_port integer check (smtp_port is null or smtp_port between 1 and 65535),
  smtp_secure text check (smtp_secure is null or smtp_secure in ('tls', 'starttls')),
  smtp_user text,
  secret_encrypted bytea,
  has_secret boolean generated always as (secret_encrypted is not null) stored,
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references consultants(id) on delete set null,
  last_test_at timestamptz,
  last_test_result text,
  constraint tenant_email_settings_smtp_complete check (
    provider <> 'smtp'
    or (smtp_host is not null and smtp_port is not null and smtp_secure is not null
        and smtp_user is not null)
  )
);

alter table tenant_email_settings enable row level security;

-- Owner or admin of the tenant; members do not see mail configuration.
create or replace function public.is_tenant_admin(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from tenant_members
     where tenant_id = target_tenant_id and user_id = auth.uid() and role in ('owner', 'admin')
  );
$$;

revoke execute on function public.is_tenant_admin(uuid) from public, anon;
grant execute on function public.is_tenant_admin(uuid) to authenticated;

drop policy if exists tenant_email_settings_admin_read on tenant_email_settings;
create policy tenant_email_settings_admin_read on tenant_email_settings
  for select to authenticated using (public.is_tenant_admin(tenant_id));

-- Column-level: every column except the ciphertext; no writes at all.
revoke all on tenant_email_settings from anon, authenticated;
grant select (
  tenant_id, provider, from_name, from_address, reply_to, smtp_host, smtp_port, smtp_secure,
  smtp_user, has_secret, enabled, updated_at, updated_by, last_test_at, last_test_result
) on tenant_email_settings to authenticated;

create or replace function public.set_tenant_email_settings(
  target_tenant_id uuid,
  p_provider text,
  p_from_name text,
  p_from_address text,
  p_reply_to text,
  p_smtp_host text,
  p_smtp_port integer,
  p_smtp_secure text,
  p_smtp_user text,
  p_secret text,
  p_enabled boolean,
  p_encryption_key text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  new_secret bytea;
begin
  if not public.is_tenant_admin(target_tenant_id) then
    raise exception 'only a tenant owner or admin can change its email settings'
      using errcode = '42501';
  end if;
  if nullif(trim(p_secret), '') is not null then
    if coalesce(length(p_encryption_key), 0) < 16 then
      raise exception 'EMAIL_SETTINGS_KEY is not configured on the server' using errcode = '22023';
    end if;
    new_secret := pgp_sym_encrypt(trim(p_secret), p_encryption_key);
  end if;

  insert into tenant_email_settings as s (
    tenant_id, provider, from_name, from_address, reply_to, smtp_host, smtp_port, smtp_secure,
    smtp_user, secret_encrypted, enabled, updated_at, updated_by
  ) values (
    target_tenant_id, p_provider, nullif(trim(p_from_name), ''), trim(p_from_address),
    nullif(trim(p_reply_to), ''),
    case when p_provider = 'smtp' then nullif(trim(p_smtp_host), '') end,
    case when p_provider = 'smtp' then p_smtp_port end,
    case when p_provider = 'smtp' then p_smtp_secure end,
    case when p_provider = 'smtp' then nullif(trim(p_smtp_user), '') end,
    new_secret, coalesce(p_enabled, false), now(), auth.uid()
  )
  on conflict (tenant_id) do update set
    provider = excluded.provider,
    from_name = excluded.from_name,
    from_address = excluded.from_address,
    reply_to = excluded.reply_to,
    smtp_host = excluded.smtp_host,
    smtp_port = excluded.smtp_port,
    smtp_secure = excluded.smtp_secure,
    smtp_user = excluded.smtp_user,
    -- A secret belongs to one provider: switching provider without a new one
    -- would send a Gmail password to Resend as an API key.
    secret_encrypted = case
      when new_secret is not null then new_secret
      when s.provider <> excluded.provider then null
      else s.secret_encrypted
    end,
    enabled = excluded.enabled,
    updated_at = now(),
    updated_by = auth.uid(),
    -- The last test was of a different configuration.
    last_test_at = null,
    last_test_result = null;
end;
$$;

revoke execute on function public.set_tenant_email_settings(
  uuid, text, text, text, text, text, integer, text, text, text, boolean, text
) from public, anon;
grant execute on function public.set_tenant_email_settings(
  uuid, text, text, text, text, text, integer, text, text, text, boolean, text
) to authenticated;

-- Plaintext, for the server only.
create or replace function public.get_tenant_email_transports(p_encryption_key text)
returns table (
  tenant_id uuid,
  provider text,
  from_name text,
  from_address text,
  reply_to text,
  smtp_host text,
  smtp_port integer,
  smtp_secure text,
  smtp_user text,
  secret text,
  enabled boolean
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select s.tenant_id, s.provider, s.from_name, s.from_address, s.reply_to, s.smtp_host,
         s.smtp_port, s.smtp_secure, s.smtp_user,
         case when s.secret_encrypted is not null
              then pgp_sym_decrypt(s.secret_encrypted, p_encryption_key) end,
         s.enabled
    from tenant_email_settings s;
$$;

revoke execute on function public.get_tenant_email_transports(text) from public, anon, authenticated;
grant execute on function public.get_tenant_email_transports(text) to service_role;
