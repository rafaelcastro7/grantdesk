-- Financial statements, board lists, letters of support and certificates were
-- re-gathered for every application, and nothing noticed when one expired. A
-- per-client register records each document once, with the dates that decide
-- whether it can still be sent.
--
-- It records WHERE the file is (a Drive link, a folder path), not the file:
-- the self-hosted stack runs no Storage service, and the same record works
-- unchanged on hosted Supabase. Same reasoning as 0022.
create table if not exists client_documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  kind text not null check (kind in (
    'audited_financials', 'financial_statements', 'board_list', 'incorporation',
    'charity_registration', 'insurance_certificate', 'letter_of_support', 'budget',
    'annual_report', 'other'
  )),
  title text not null check (length(trim(title)) > 0),
  location text not null check (length(trim(location)) > 0),
  issued_on date,
  expires_on date,
  notes text,
  created_by uuid default auth.uid() references consultants(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (issued_on is null or expires_on is null or issued_on <= expires_on)
);
create index if not exists client_documents_client_idx on client_documents (client_id);

alter table client_documents enable row level security;
create policy client_documents_own_all on client_documents
  for all to authenticated
  using (public.owns_client(client_id))
  with check (public.owns_client(client_id));

alter table requirement_acknowledgements
  add column if not exists document_id uuid references client_documents(id) on delete set null;

-- RLS alone would let a consultant who serves two clients attach one client's
-- insurance certificate to the other's application.
create or replace function public.ack_document_same_client()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.document_id is not null and not exists (
    select 1 from client_documents d join proposals p on p.client_id = d.client_id
     where d.id = new.document_id and p.id = new.proposal_id
  ) then
    raise exception 'That document belongs to a different client.' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists requirement_acks_document_client on requirement_acknowledgements;
create trigger requirement_acks_document_client
  before insert or update of document_id on requirement_acknowledgements
  for each row execute function public.ack_document_same_client();

-- The submitted lock (0034) must still hold, but removing a document from the
-- register nulls document_id on submitted acknowledgements through the FK, and
-- the lock would then make the document undeletable forever. That one change
-- is allowed: the acknowledgement keeps its location text, which is the record
-- of what was sent.
create or replace function public.reject_if_submitted()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target uuid := coalesce(new.proposal_id, old.proposal_id);
begin
  if tg_table_name = 'requirement_acknowledgements' and tg_op = 'UPDATE'
     and new.document_id is null and old.document_id is not null
     and (to_jsonb(new) - 'document_id') = (to_jsonb(old) - 'document_id') then
    return new;
  end if;
  if exists (select 1 from submissions s where s.proposal_id = target) then
    raise exception 'This application was submitted and is locked.'
      using errcode = 'P0001', hint = 'submitted';
  end if;
  return coalesce(new, old);
end $$;
