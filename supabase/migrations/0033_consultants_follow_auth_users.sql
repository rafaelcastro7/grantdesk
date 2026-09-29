-- A consultant is an auth user. Nothing tied the two, so deleting an account
-- left its consultants row — and, through it, the clients, memberships and
-- queued mail it owned — behind with no one able to sign in as it. Found by the
-- synthetic agents' own cleanup: 7 orphaned consultants at the time of writing.
delete from public.consultants c
 where not exists (select 1 from auth.users u where u.id = c.id);

alter table public.consultants
  add constraint consultants_id_auth_users_fkey
  foreign key (id) references auth.users(id) on delete cascade;
