# ADR-0002 — An explicit scope boundary, with an exception process

**Status:** accepted · 2026-08-16

## Context

The predecessor reached 39 authenticated pages, 59 database tables and 67,025
lines in `src`. None of that was careless: a compliance calendar, financial
tracking, impact measurement and renewal prediction were each somebody's real
need. It grew because there was never a written rule for what does _not_ belong.

Proposing "six screens instead of thirty-nine" without that rule just schedules
the same outcome for six months from now.

## Decision

A change ships in v1 only if it serves one of the five questions in
`docs/SPEC.md`:

1. What is due across all my clients?
2. What is worth this client's money — and what is not, and why?
3. What does this call require?
4. Draft it, reusing what I already wrote.
5. Is it ready to send?

Anything else is **out**, including ideas that are obviously good. Out does not
mean bad; it means later.

## Exception process

To add a surface that serves none of the five:

1. Write the user sentence it answers, in the consultant's words.
2. Name which of the five it competes with for attention, and why it wins.
3. State what gets removed to make room. The page budget is fixed at six; a
   seventh requires deleting one.

Recorded as a new ADR. No exception is granted in a commit message.

## Consequences

- Real needs get refused, and refusing them is the point.
- The budget is a forcing function: "what do we delete" is a better question
  than "can we fit this in".
- If the exception process is used more than twice before v1 ships, the scope
  was wrong and the spec — not the boundary — is what should change.
