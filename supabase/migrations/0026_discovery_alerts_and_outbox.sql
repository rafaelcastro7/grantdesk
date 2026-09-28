-- 0026_discovery_alerts_and_outbox.sql
-- Outbox and Deduplication for Continuous Discovery & Email Alerts

create table if not exists email_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade default '11111111-1111-1111-1111-111111111111'::uuid,
  recipient_email text not null,
  subject text not null,
  body_html text not null,
  kind text not null check (kind in ('new_grant_match', 'deadline_reminder', 'system_alert')),
  grant_id uuid references grants(id) on delete cascade,
  client_id uuid references clients(id) on delete cascade,
  status text not null check (status in ('pending', 'sent', 'failed')) default 'pending',
  error text,
  sent_at timestamptz,
  created_date date not null default current_date,
  created_at timestamptz not null default now()
);

-- Unique index to prevent duplicate alerts to the same recipient for the same grant on the same calendar day
create unique index if not exists email_outbox_daily_dedup_idx on email_outbox (
  recipient_email,
  kind,
  coalesce(grant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid),
  created_date
);

create index if not exists email_outbox_pending_idx on email_outbox (status) where status = 'pending';
create index if not exists email_outbox_tenant_idx on email_outbox (tenant_id);

-- RLS
alter table email_outbox enable row level security;

drop policy if exists email_outbox_read on email_outbox;
create policy email_outbox_read on email_outbox
  for select to authenticated
  using (public.belongs_to_tenant(tenant_id));
