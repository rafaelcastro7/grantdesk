-- A draft's own fabrication check (src/lib/fabrication.ts) was proven against
-- offline eval fixtures only — nothing in production ever ran a real
-- consultant's draft through it, so nobody ever saw a real fabricated number
-- or invented person until they submitted it. Storing what the checker found
-- alongside the section means a consultant sees it every time they reopen the
-- proposal, not only in the one response right after drafting.
alter table proposal_sections add column if not exists fabrication_concerns jsonb
  not null default '[]';
