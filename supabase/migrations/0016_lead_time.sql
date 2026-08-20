-- How long this client actually needs to write an application.
--
-- The deadline rule answers whether a call is open. That is a different
-- question from whether there is time to write it, and the predecessor treated
-- them separately for good reason: a call that closes on Friday is open and
-- undeliverable, and telling a consultant it is "eligible" wastes exactly the
-- week they do not have.
--
-- Nullable with a sensible default in code rather than a NOT NULL here: a
-- profile that has never been asked should get a reasonable answer, not a
-- number somebody invented at the database level.
alter table client_profiles add column if not exists lead_time_weeks integer
  check (lead_time_weeks is null or (lead_time_weeks >= 0 and lead_time_weeks <= 52));

comment on column client_profiles.lead_time_weeks is
  'Working weeks this client needs to produce a credible application. Feeds the runway rule.';
