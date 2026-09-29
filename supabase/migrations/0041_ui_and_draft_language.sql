-- Bilingual work for Canadian calls (federal, Quebec, francophone Ontario).
-- Two separate languages on purpose: the consultant's interface language is a
-- personal preference, while the language a proposal is drafted in belongs to
-- the client — a bilingual consultant routinely writes French proposals for one
-- client and English for the next.
--
-- Idempotent (if not exists / drop constraint if exists). No new policies: the
-- existing row policies already cover new columns -- consultants_self_write
-- lets a consultant update only their own row (0002), and
-- client_profiles_own_all is scoped by owns_client().
alter table consultants add column if not exists ui_language text not null default 'en';
alter table consultants drop constraint if exists consultants_ui_language_check;
alter table consultants add constraint consultants_ui_language_check
  check (ui_language in ('en', 'fr'));

alter table client_profiles add column if not exists draft_language text not null default 'en';
alter table client_profiles drop constraint if exists client_profiles_draft_language_check;
alter table client_profiles add constraint client_profiles_draft_language_check
  check (draft_language in ('en', 'fr'));

comment on column consultants.ui_language is
  'Interface language for this consultant. Does not affect what drafts are written in.';
comment on column client_profiles.draft_language is
  'Language proposal sections are drafted in for this client.';
