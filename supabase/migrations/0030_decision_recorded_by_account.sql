-- "Approved by" is typed, so on its own it proves nothing about who unlocked
-- drafting. The database stamps the signed-in account that recorded each
-- decision change, and the client cannot supply or forge it.
alter table opportunity_decisions
  add column if not exists decided_by_user uuid;

do $$ begin
  alter table opportunity_decisions
    add constraint opportunity_decisions_decided_by_user_fkey
    foreign key (decided_by_user) references consultants(id) on delete set null;
exception when duplicate_object then null; end $$;

create or replace function public.stamp_decision_recorder()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.decided_by_user := case when new.decision <> 'pending' then auth.uid() end;
  elsif new.decision is distinct from old.decision
     or new.decided_by is distinct from old.decided_by
     or new.condition_met is distinct from old.condition_met then
    new.decided_by_user := case when new.decision <> 'pending' then auth.uid() end;
  else
    new.decided_by_user := old.decided_by_user;
  end if;
  return new;
end $$;

drop trigger if exists opportunity_decisions_stamp on opportunity_decisions;
create trigger opportunity_decisions_stamp
  before insert or update on opportunity_decisions
  for each row execute function public.stamp_decision_recorder();
