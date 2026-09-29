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

## Follow-up after a critical walkthrough (same day)

- **Ontario Transfer Payment Ontario** is a source (`ontario-tpon`, 24h): status,
  deadline, eligibility prose, guideline links and contacts per program. GMF/FCM
  refuses automated reads (HTTP 403) and is not ingested; it stays a manual check.
- Grants carry `documents` and `contact`; the proposal screen shows a call
  snapshot with every field, saying "not published" rather than omitting one.
- The brief pre-fills role (from the stored `role` rule), intake, amount,
  mandatory components (critical requirements) and risks (missing fields).
  The database stamps the signed-in account behind every decision
  (`decided_by_user`), because the typed approver name proves nothing.
- Manual section headings belong to a client (`requirements.client_id`); they
  used to be written into the shared per-grant list, visible to every tenant.
- Deadlines end at 23:59 America/Toronto, not UTC (`src/lib/deadline.ts`).
- Pasted URLs are fetched through `safeFetch`, which refuses private and local
  addresses; profile extraction requires a signed-in caller.
- Alerts only fire on an `eligible` verdict computed with every field; reminders
  skip submitted and no-go work. Nothing sends `email_outbox` yet.
- Removed as fabricated: the keyword "AI" chat, the budget planner and ROI
  matrix sample data, the pipeline board, the approval workflow stub, the
  exporter fed an empty list, the relevance-percentage scorecard, the
  design-token route, and the "Live" badge.

## Second audit (same day)

- **Ontario Trillium Foundation** is a source (`otf`, 24h), read from its own
  deadlines table (streams, intake dates, "Closed" markers) and stream pages
  (award range, eligibility).
- Clients always belong to a tenant (a trigger assigns the creator's; the
  column is NOT NULL) and `belongs_to_tenant(NULL)` is false. The UI had been
  creating every client outside tenant isolation.
- Queued email is readable by the client's team or its recipient, not the
  whole tenant. `replace_extracted_requirements` is service-role only;
  `find_consultant_by_email` is closed to anon and scoped to shared tenants.
- The daemon alerts on grants first seen this cycle (not re-read ones, no cap
  of ten), expires by Toronto date, and ingestion never reopens a passed call.
- 3,592 alerts queued by the old logic were marked `failed` with a reason,
  not sent. Every self sign-up still joins the IIAL tenant (`handle_new_user`)
  — a deployment choice to revisit before other tenants onboard.

## Third audit (same day)

- Server functions that take a client, proposal and requirement verify the
  three describe one application (`assertOneApplication`); mixing ids had
  bypassed the go / no-go lock and drafted one client's facts into another's
  proposal. Submission also blocks without a required go.
- Re-reading a call keeps any requirement another tenant has acknowledged or
  assessed; the migration log is no longer writable through the API; a
  client's tenant is pinned like its owner; migrations apply atomically.
- Funder, website and answer text reaches models only inside `<untrusted>`
  fences with a rule that it is data (`src/server/prompt-safety.ts`).
- One time budget per model call across the whole provider chain; query
  embeds wait 20 s, not 5 min; catalog reads are paged.
- UI: saving never discards an edit on failure; a redraft over unsaved edits
  asks first; the brief waits for the call to be read before it can be typed
  in; the profile is locked while a site is read; money fields refuse what they
  cannot parse; amounts are filtered and sorted only within one currency;
  signed-out visitors are sent to sign in; there is a sign-out.
- Debt: four unused dependencies removed, the undeclared build dependency
  declared (its transitive packages were missing from the lockfile), dead
  exports deleted.

## Consequences

- Funded-partner detection only recognises public bodies as leads. That matches
  the SOP's proven pathway (municipalities); a broader rule would turn every
  closed call into a question.
- `strategic_fit` is only as good as the domains a consultant writes down; an
  empty list reports `unknown` rather than guessing.
- Stage 2 (reading documents, partner pitch, budget, current-state checks) stays
  human work; the brief records its results rather than automating it.
