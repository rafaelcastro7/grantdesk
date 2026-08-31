-- "How to apply" is not a narrative section. A real one — ACOA's — read as
-- one sentence: "Contact your nearest ACOA office to discuss your project
-- and then complete and submit the Application for financial assistance."
-- Classified as `section`, the drafting pipeline did what a section asks:
-- wrote a paragraph elaborating on it, in first person, that says nothing
-- the funder's own sentence didn't already say. There is no persuasive case
-- to make about the mechanics of submitting a form — a consultant needs to
-- read those steps, not have prose generated from them.
--
-- `process` is for exactly that: instructions about how the call is
-- submitted, never drafted, shown as what the funder actually said.
alter table requirements drop constraint if exists requirements_kind_check;
alter table requirements
  add constraint requirements_kind_check
  check (kind in ('section', 'eligibility', 'attachment', 'criterion', 'process'));
