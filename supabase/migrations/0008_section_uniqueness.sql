-- One section per requirement, per proposal.
--
-- Re-drafting is an ordinary action — a consultant will do it several times per
-- section — and without this it appends a second copy each time instead of
-- replacing the first. The upsert in proposal.functions.ts needs a conflict
-- target to aim at, and without one it fails outright rather than duplicating,
-- so this is what makes "Draft again" work at all.
--
-- Not partial, deliberately. A partial index cannot be inferred as an
-- ON CONFLICT target unless the caller repeats its WHERE clause, and PostgREST
-- sends column names only — so the partial version failed exactly the same way
-- as having no index at all. It is not needed anyway: nulls are distinct in a
-- unique index, so sections written from scratch, with no requirement behind
-- them, still never collide with each other.
create unique index if not exists proposal_sections_requirement_idx
  on proposal_sections (proposal_id, requirement_id);

-- The same problem, one table over. 0007 made requirements unique on
-- (grant_id, lower(label)), which is the right uniqueness rule but the wrong
-- shape: Postgres cannot infer an ON CONFLICT target from an expression index,
-- so re-reading a call failed outright with "no unique or exclusion constraint
-- matching the ON CONFLICT specification".
--
-- Indexing the plain column instead. The case-insensitive intent is not lost:
-- parseRequirements already collapses headings that differ only in case within
-- a single reading, which is where that actually happens.
drop index if exists requirements_grant_label_idx;
create unique index if not exists requirements_grant_label_idx
  on requirements (grant_id, label);
