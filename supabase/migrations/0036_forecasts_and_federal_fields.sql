-- Forecasted federal notices are not open calls: nobody can apply yet. They
-- were stored as status 'open' with no deadline, which the rules then read as
-- "accepts applications continuously" — about a third of the US catalog.
-- They now carry their own status and the funder's *estimated* dates, stored
-- apart from the real deadline so an estimate is never mistaken for one.
alter table grants add column if not exists estimated_deadline date;
alter table grants add column if not exists cost_sharing_required boolean;
alter table grants add column if not exists deadline_note text;
alter table grants add column if not exists opportunity_number text;

comment on column grants.estimated_deadline is
  'Funder-estimated application date for a forecast. Never a deadline.';
comment on column grants.cost_sharing_required is
  'Structured cost-share flag where the source publishes one (Grants.gov costSharing).';
comment on column grants.deadline_note is
  'The funder''s own wording about dates: LOIs, multiple due dates, local-time rules.';
