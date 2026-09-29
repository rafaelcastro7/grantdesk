# ADR-0006 — A client's own screening SOP, without a seventh screen

Status: accepted · 2026-09-29

## Context

IIAL, a client run through this desk, has a written grant-finding SOP
(`docs/SOP_GR_1.DOC`): six fast-screening filters (F1–F6), deep qualification,
a one-page Opportunity Brief, and a leadership go / no-go that must be recorded
before any writing starts. The rules engine already covered F1 and F5 in part,
and nothing covered F2, F4, or Stages 3–4.

## Decision

**Filters become rules, in the existing engine, with the existing pass / fail /
unknown contract.**

| SOP | Rule key | Gate | Notes |
| --- | --- | --- | --- |
| F1 legal eligibility | `applicant_type` | hard | A call closed to the client's legal form but open to public bodies becomes `unknown` (a partner question) when the client works as a funded partner |
| F2 role | `role` | soft | lead / funded partner / none, derived from the funder's applicant list and the profile's `funded_partner_pathway` |
| F3 money math | `cost_share` | soft | Names who carries the share (the lead, in a partner role), reads an in-kind cap from prose, and always says to confirm any cash match |
| F4 strategic fit | `strategic_fit` | soft | Word-boundary match of the profile's `capability_domains` against the funder's text. Never fails: absent wording is not evidence of misfit (ADR-0005) |
| F5 runway | `runway` | soft | `lead_time_weeks` as lead (default 3), `partner_lead_time_weeks` as partner (default 8) |
| F6 effort vs reward | — | — | A judgement by the SOP's own words; stays with the prioritisation matrix and the brief's recommendation |

**Stages 3–4 are a section of the proposal screen, not a screen.** The brief
answers "what does this call require of us, and are we doing it", which is
that screen's question 3 in `docs/SPEC.md`, so ADR-0002's page budget is not
touched. Decisions live in `opportunity_decisions`, one per client and call,
with no delete policy: the SOP requires no-goes to be kept.

**The go / no-go lock is a client policy** (`requires_go_decision`), enforced in
`draftProposalSection` on the server, not only by a disabled button. A client
without a sign-off step is never blocked by one. A go-conditional opens drafting
only once its condition is marked met; a decision needs a named approver.

## Consequences

- Funded-partner detection only recognises public bodies as leads. That matches
  the SOP's proven pathway (municipalities); a broader rule would turn every
  closed call into a question.
- `strategic_fit` is only as good as the domains a consultant writes down; an
  empty list reports `unknown` rather than guessing.
- Stage 2 (reading documents, partner pitch, budget, current-state checks) stays
  human work; the brief records its results rather than automating it.
