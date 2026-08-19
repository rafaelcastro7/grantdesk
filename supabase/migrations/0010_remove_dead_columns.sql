-- Technical debt, removed rather than documented.
--
-- Every column here was written by the app and read by nothing, which is worse
-- than useless: a future reader has to work out which of two timestamps is the
-- real one, and a future writer will eventually update one and not the other.

-- Two timestamps for a single event. `matched_at` is the one runMatch sets;
-- `decided_at` was a default that has never been read.
alter table matches drop column if exists decided_at;

-- `status` superseded this in 0005 because a boolean cannot express "the funder
-- did not publish enough to decide". Both have been written since, and the
-- boolean silently collapses `unknown` into `false` — exactly the
-- misrepresentation the third state exists to prevent.
alter table eligibility_checks drop column if exists passed;

-- The second source of truth for "was this sent". The submissions row is the
-- record — it carries who confirmed, when, and what they were warned about —
-- while this column was set to 'submitted' alongside it and read by nobody.
-- Two places to look is how they end up disagreeing.
alter table proposals drop column if exists status;
