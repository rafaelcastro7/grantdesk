-- 0034 forbade a negative net revenue, but a project can cost the applicant
-- more than it brings in, and the brief exists to say so before a go.
alter table opportunity_decisions drop constraint if exists opportunity_decisions_amounts_sane;
alter table opportunity_decisions add constraint opportunity_decisions_amounts_sane check (
  coalesce(request_amount, 0) >= 0
  and coalesce(match_required, 0) >= 0
  and coalesce(in_kind_cap, 0) >= 0
);
