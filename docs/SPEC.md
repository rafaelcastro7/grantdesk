# GrantDesk — product specification

## What this is

A grant desk for **consultants who manage several client organizations** across the
Americas. One person, many clients, billable time.

## The thesis

**Fewer results, verified, with the receipts.**

The market leader's most-cited weakness is match quality: its algorithm
"flags grant opportunities based on keyword matches and organizational profile
data, but the matches often include clearly non-applicable funders (geographic
mismatches, program area mismatches) that require manual filtering", and it
"doesn't tell you who won past grants, what those organizations looked like, or
what your odds are".

We do not compete on database size — Candid wins that and always will. We
compete on **every result carrying a verdict and its evidence**, so a consultant
never spends billable time reading a call their client cannot win.

## Non-negotiables

1. **The deterministic rules decide eligibility, not the model.** Structured
   output modes guarantee the schema, not the quality — measured value accuracy
   tops out near 83% on text. The LLM adds nuance and language; a rule engine
   decides pass/fail, and every rule result is stored so the explanation is
   queryable data rather than regenerated prose.
2. **Never claim coverage we do not have.** Each market declares whether its
   ingestion is automatic, partial, or directory-only, and the UI shows it.
   The previous system advertised "100% local, 0 cloud tokens" while running
   cloud-first, and listed 83 funders that search could not reach. Not again.
3. **Silent degradation is a defect.** Every dependency (models, providers,
   sources) is checked on startup and fails loudly.

## The user's day

A consultant opens the app and asks, in order:

1. What is due across **all** my clients this week?
2. For this client, what is worth their money right now — and what is not, and why?
3. What does this specific call actually require of us?
4. Draft it, reusing what I already wrote for this client.
5. Is it ready to send?

Six screens, one per question plus the client switcher. Anything that does not
serve one of these five questions does not ship in v1 (see
`docs/adr/0002-scope-boundary.md`).

## The hard problem, stated honestly

The verification engine needs a rich, current profile per client. Research on
the incumbent shows people configure a profile once and never update it, and
matching "drifts irrelevant over time". A consultant with 8 clients has 8× that
burden — **we picked the persona with the least time per profile for an engine
that depends on profile quality.**

So profile creation is not a settings form; it is the first product surface we
build. If a consultant cannot get a usable client profile in ~10 minutes from
documents they already have, nothing downstream matters. Phase 1 exists to prove
or disprove exactly that, before any matching UI is built.

## What we are not building in v1

Compliance calendars, financial tracking against budgets, impact measurement,
renewal prediction, approval workflows, multi-expert review panels. Each was a
real need in the predecessor and each is a reason it grew to 39 pages. They
return only through the exception process in ADR-0002.

## Success criteria

- A consultant onboards a new client in ≤10 minutes and gets matches they judge
  worth reading.
- On a labelled evaluation set, we surface fewer false positives than a
  keyword-plus-profile baseline — measured, not asserted.
- The full lifecycle (match → verify → draft → submit) runs end to end in tests.
