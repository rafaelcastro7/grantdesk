-- A heading a consultant types for one client's application belongs to that
-- client. It used to be written into the shared per-grant list, where every
-- other tenant saw it and could overwrite its word limit. Extracted
-- requirements stay shared (client_id null) and are written only by the
-- server; consultants write only their own client's sections.
alter table requirements
  add column if not exists client_id uuid references clients(id) on delete cascade;

drop index if exists requirements_grant_label_idx;
create unique index if not exists requirements_grant_label_client_idx
  on requirements (grant_id, label, client_id) nulls not distinct;

drop policy if exists requirements_read on requirements;
drop policy if exists requirements_write on requirements;
drop policy if exists requirements_update on requirements;

create policy requirements_read on requirements
  for select to authenticated
  using (client_id is null or public.owns_client(client_id));

create policy requirements_insert_own on requirements
  for insert to authenticated
  with check (client_id is not null and public.owns_client(client_id));

create policy requirements_update_own on requirements
  for update to authenticated
  using (client_id is not null and public.owns_client(client_id))
  with check (client_id is not null and public.owns_client(client_id));
