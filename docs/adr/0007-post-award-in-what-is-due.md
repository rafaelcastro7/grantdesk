# ADR-0007 — Post-award obligations belong in "What is due"

**Status:** accepted · 2026-09-29

## Context

The desk stopped caring about an application the moment its outcome read
"Awarded". For a consultant that is when a second set of deadlines starts: an
interim report in six months, a financial report at year end, a final report
after the agreement closes, and a renewal conversation before it does. Those
lived in a spreadsheet beside the product, which is how a report goes late and
a renewal window closes unnoticed.

The predecessor built this as four screens (post-award, financial, impact,
renewal). ADR-0002 exists because of that.

## Exception process (ADR-0002)

1. **The user sentence.** "We won it — now tell me when the reports are due and
   when to start talking about the renewal, on the same list as everything
   else I owe."
2. **Which of the five it serves.** Question 1, "What is due across all my
   clients?". A report owed to a funder is due in exactly the sense an
   application is; a list that omits it answers the question wrongly. It does
   not compete with question 1 — it completes it.
3. **What gets removed.** Nothing, because no surface is added. Award terms are
   captured on the proposal screen, inside the outcome form that already
   records "Awarded". Reports and renewal windows are rows on the existing
   "What is due" list, labelled "Report due" and "Renewal window". The page
   budget of six is untouched.

The budget builder in the same change is not an exception: it lives inside the
Opportunity Brief, which ADR-0006 already placed under question 3.

## Decision

- `award_details` (one per proposal) holds amount, currency, agreement start
  and end. `award_reports` holds each reporting obligation with its kind
  (interim, final, financial, other), due date and the date it was submitted.
- Both are governed by `owns_client` through `proposals`. Neither carries the
  submitted-lock of migration 0034: an award is recorded, by definition, after
  submission, and a report is marked submitted months later.
- A report reminder uses the same outbox and the same 14 / 7 / 3 / 1-day
  thresholds as application deadlines; the outbox dedup key gains the report,
  so two reports on one grant do not suppress each other.
- The renewal window is an agreement ending within 120 days. It is a date
  comparison, not a prediction: the predecessor's "renewal likelihood" was a
  number nobody could trace, and this product does not publish those.

## Consequences

- Nothing is inferred. An award without reports entered shows no reports; the
  list does not invent a standard schedule the funder never stated.
- The first use of the exception process. ADR-0002 says a third before v1 means
  the spec, not the boundary, should change.
