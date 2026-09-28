# Phases and Definition of Done

Vertical slices: every phase ends with something a user can do end to end, and
nothing is "done" until it is proven by a test that would fail without it.

**Gate for every phase:** `bun run verify` green — lint, typecheck, unit tests,
build — plus the phase's own end-to-end proof. No phase starts before the
previous one's gate passes.

---

## Phase 0 — Foundation

Repo, tooling, isolated stack, schema, auth with per-client isolation.

- Own folder, own port (**app :5180**), own database instance
  (**Postgres :15532, gateway :15535**) — nothing shared with the predecessor.
- `bun run verify` wired: lint + typecheck + test + build.
- Schema v1 with RLS, so a consultant can only ever read their own clients.
- ADR log started.

**Done when:** the stack comes up from cold on its own ports, `verify` is green,
and a test proves one consultant cannot read another's client row.

---

## Phase 1 — A client profile in ten minutes

The riskiest assumption in the whole product, so it goes first.

- Create a client; paste a URL or upload prior documents.
- Extract sectors, jurisdictions, stage, budget, capabilities into a profile.
- Show profile completeness and what is missing, in the consultant's terms.

**Done when:** from a real organization's public page, the extracted profile is
good enough to run matching, and a test asserts the required fields are
populated. If this cannot be made to work, the plan changes here rather than
after five more phases.

---

## Phase 2 — Catalog and honest coverage

- Source registry: each source is an adapter declaring cadence and market.
- Port the three proven importers (Grants.gov, Innovation Canada, CRA T3010).
- Freshness SLA per source; coverage per market surfaced in the UI as
  automatic / partial / directory-only.

**Done when:** grants are ingested from at least two sources, re-running an
importer is idempotent, and the UI states coverage per market truthfully.

---

## Phase 3 — Verified matches

- Retrieval: `tsvector` + GIN and pgvector, fused with RRF (k=60).
- Deterministic eligibility gates per jurisdiction; every rule result persisted.
- `matches` carries verdict + reasons; ineligible results are collapsed, not hidden.
- A labelled evaluation set with precision measured against a keyword baseline.

**Done when:** the eval set runs in CI and reports precision, and a test proves a
grant restricted to a jurisdiction the client is not in comes back ineligible
with a stated reason.

**Closed.** `bun run eval:match` runs in CI and exits non-zero if hybrid
retrieval fails to beat the keyword baseline. Measured on the labelled corpus:
precision@5 24% → 60% (the corpus ceiling), recall 33% → 100%, lexical traps in
the top 5 six → one. Four verdict tests in `tests/integration/match-verdicts`
prove a grant restricted elsewhere comes back ineligible with the rule and both
jurisdictions named. See ADR-0004.

Two things changed shape while building it. Rules return pass/fail/**unknown**
rather than a boolean, because "the funder did not publish enough to decide" is
the answer this product most needs to be able to give. And the profile became
editable by hand — the gap prompt was asking a question the UI gave no way to
answer, and extraction alone leaves the consultant stranded whenever a website
does not cooperate.

Deferred until measured on our own corpus, not adopted on benchmark reputation:
cross-encoder reranking (large reported gains but on unrelated domains, and it
costs a forward pass per candidate) and real BM25 via a Postgres extension
(needs a custom image — see ADR-0003).

---

## Phase 4 — Requirement-driven drafting

- Parse the call document into requirements, sections and evaluation criteria.
- Draft against those requirements, not a generic template.
- Answer library: reusable per-client responses, because a consultant writes the
  same organizational history dozens of times.

**Done when:** a proposal drafts end to end against a real call's requirements
and reused answers appear in the draft.

**Closed.** `bun run eval:drafting` measures the properties that matter without
a judge, by checking the text itself: 100% of drafts retrieved the stored
answer, kept its distinctive fact, stayed inside the funder's word limit, and
contained no number that did not trace back to a supplied fact. Reuse is by
meaning, not by label — an answer stored as "Track record and past projects" is
found when the funder asks for "Organizational Capacity", which a text match
never would.

Two findings changed the design. Most catalog call URLs are JavaScript shells —
fetching a Grants.gov opportunity page returns none of its own requirements —
while the full description came down through the API during ingestion and is
already in our table, so requirements are read from held text first and the URL
only as a fallback. And funders publish their conditions on the web but keep the
section list in the application form, so the consultant can add a heading by
hand; without that the page is correct and useless.

---

## Phase 5 — Submit and track

- Submit gate with explicit human-review confirmation.
- Track status; show who won this grant before.

**Done when:** the full lifecycle passes in one e2e run and a submission is
recorded.

**Closed.** `tests/e2e/lifecycle.spec.ts` runs the whole product in one pass:
sign up, add a client, fill the profile, match, read the call, draft against it,
keep the answer, look up prior winners, clear the gate, record the submission,
and see it on the desk.

The gate returns named blockers rather than a readiness score, because a
consultant needs to know what is unfinished, not that it is 78% done. Hard
blockers cannot be overridden; soft ones can, and what the consultant was told
is stored on the submission so "did we know?" stays answerable. The human
confirmation is always the last outstanding item and is never satisfied
automatically.

"Who won this before" is answered from USAspending, keyed on the Assistance
Listing number the call itself carries — 1661 of 1702 US calls now have one. For
a Canadian call it says it does not know, rather than showing an empty list: no
comparable award data is published there, and an empty list reads as "nobody has
ever won this".

---

---

## Phase 6 — Subdomain Multi-Tenancy, 24/7 Discovery & Deduplicated Alerts

- Subdomain routing (`iial.grantdesk.app`, `acme.grantdesk.ca`, and dev fallback) with live branding.
- Database RLS multi-tenant isolation via migration 0025 (`public.belongs_to_tenant(tenant_id)`).
- Continuous 24/7 grant discovery daemon (`scripts/daemon-continuous-discovery.ts`) with SHA-256 `sourceHash` ensuring zero duplicates.
- Email outbox with daily deduplication index (`email_outbox_daily_dedup_idx`) and urgent deadline reminders (14d, 7d, 3d, 1d).

**Done when:** RLS isolation tests prove tenant data is completely invisible to other tenants, discovery cycles run idempotently with 0 duplicate grant rows, and `bun run verify` passes 100%.

**Closed.**
- `tests/integration/tenant-isolation.test.ts` verified RLS isolation.
- `tests/integration/continuous-discovery.test.ts` verified 0 duplicate growth on re-runs.
- `src/server/notifications.test.ts` verified high-fidelity responsive email templates.
- `bun run verify` passed 100% (ESLint 0 errors, `tsc` 0 errors, Vitest 253 unit tests, 11 integration tests, Vite production build).

## Working method

- **Spec first** — behaviour is written down before code.
- **Tests first** where the behaviour is decidable; tests must fail before they pass.
- **ADRs** for choices that are expensive to reverse.
- **Evals** for anything a model decides, because tests cannot pin a distribution.
- **Conventional commits**, real messages. No 15-second auto-commit bot.
