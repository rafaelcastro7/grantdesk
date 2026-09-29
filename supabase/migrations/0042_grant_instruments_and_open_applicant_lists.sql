-- Grants.gov publishes two structured facts we were dropping.
--
-- 1. Applicant code 25 ("Others - see the text field") alongside the listed
--    codes. The listed types are definitely eligible; an unlisted type may be
--    too. Without this flag the rules engine read "not listed" as "excluded"
--    and failed clients the funder never ruled out.
-- 2. The funding instrument (grant, cooperative agreement, procurement
--    contract), which changes the post-award relationship a consultant is
--    signing the client up for.
--
-- Both are catalog columns on `grants`; the table's existing RLS policies
-- (catalog readable by signed-in users, written only by the service role)
-- already cover them, so no policy changes are needed.
alter table grants add column if not exists applicant_types_open_ended boolean;
alter table grants add column if not exists funding_instruments text[] not null default '{}';

comment on column grants.applicant_types_open_ended is
  'True when the structured applicant list also admits "others" described in prose (Grants.gov code 25): an unlisted type is unknown, not excluded.';
comment on column grants.funding_instruments is
  'How the money is given, as the source states it: grant, cooperative agreement, procurement contract, other.';
