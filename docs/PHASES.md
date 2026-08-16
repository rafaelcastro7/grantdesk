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

---

## Phase 5 — Submit and track

- Submit gate with explicit human-review confirmation.
- Track status; show who won this grant before.

**Done when:** the full lifecycle passes in one e2e run and a submission is
recorded.

---

## Working method

- **Spec first** — behaviour is written down before code.
- **Tests first** where the behaviour is decidable; tests must fail before they pass.
- **ADRs** for choices that are expensive to reverse.
- **Evals** for anything a model decides, because tests cannot pin a distribution.
- **Conventional commits**, real messages. No 15-second auto-commit bot.
