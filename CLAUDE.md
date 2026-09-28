# GrantDesk — working notes

A grant desk for consultants running several client organizations.
**Fewer results, verified, with the receipts.**

Read `docs/SPEC.md` for what the product is, `docs/PHASES.md` for what shipped
and what each gate proved, and `docs/adr/` for the choices that are expensive to
reverse. This file is the short version of how to work in here.

## Run it

```bash
bun run db:up          # Postgres 15532 · gateway 15535 · project "grantdesk"
bun run db:migrate     # applies migrations AND reloads PostgREST's schema cache
bun run dev            # app on 5180
bun run refresh        # read whatever is due by its own cadence, then embed. Hourly-safe.
bun run ingest         # every source now, ignoring cadence
bun run embed          # brings embeddings up to date (only re-embeds changed text)
bun run scripts/daemon-continuous-discovery.ts        # 24/7 continuous discovery + email alert daemon
bun run scripts/daemon-continuous-discovery.ts --once # single discovery pass and exit
```

Prefer `refresh` — it is the one that leaves the catalog _searchable_. Ingestion
and embedding used to be separate commands, so a freshly ingested call was
invisible to meaning-based search until someone ran the second one, and the
eval shows the vector side is what finds vocabulary gaps and cross-language
matches at all. The newest calls, whose deadlines are closest, were the least
findable in the product.

To stop depending on anyone remembering:
`powershell -ExecutionPolicy Bypass -File scripts\install-schedule.ps1`
registers it hourly. `refresh` decides what is due and exits in under a second
when nothing is, so the schedule stays fixed while cadences live with the
adapters that own them.

Nothing is shared with the predecessor at `e:/dev/iial-grants` — different
folder, different ports, different database, different JWT secret.

## The gates

```bash
bun run verify           # lint + typecheck + unit tests + build. Hermetic; keep it that way.
bun run test:integration # needs the live stack
bun run test:e2e         # needs the live stack + a dev server it starts itself
bun run eval:match       # retrieval precision vs the keyword baseline; exits non-zero if it loses
bun run eval:drafting    # reuse, word limits, and no fabricated numbers
bun run eval:profile     # extraction quality across real pages
bun run doctor           # is any of this actually working right now?
bun run benchmark        # which provider should lead each role, measured today
```

`doctor` exists because the answer was no for weeks and nothing said so: Groq
retired a model, Cerebras ran out of quota, and every call fell through to the
small local model while every screen reported an ordinary success. It probes
with real calls — listing a model is not evidence it can be called — and
separates _broken_ from _degraded_, exiting non-zero only for the first. A
check that cries wolf gets run with `|| true` within a week.

`verify` must never depend on the network. A gate people learn to re-run is not
a gate.

## The one idea everything follows from

**Retrieval is allowed to be fuzzy. Verdicts are not.**

Ranking uses tsvector + pgvector fused by RRF, because recall is what finds a
call whose words the client never uses. But nothing probabilistic touches
whether a consultant is told they may apply — that is four deterministic rules
in `src/lib/eligibility.ts`, and every rule result is persisted, not just the
deciding one.

The corollary that shapes half the code: **a rule returns pass, fail, or
unknown.** "The funder did not publish enough to decide" is a real answer.
Folding it into a pass claims verification we did not do; folding it into a fail
invents a restriction no funder stated. Same reasoning gives ineligible matches
their own collapsed group instead of being filtered away — a result that
silently disappears is indistinguishable from one we never found.

## Tests, evals, and which is which

- **Test** anything decidable: a rule, a query builder, an upsert conflict
  target, an RLS policy.
- **Eval** anything a model decides. A single live round-trip is a sample from a
  distribution, not a pass/fail — asserting on one made a Phase 1 e2e pass, then
  fail, on an identical build.
- Evals here check the **text**, not a judge's opinion of it. A model-judged
  eval moves when the judge changes and nobody can tell why. Hand-written
  labels and property checks (does this number trace back to a supplied fact?)
  move only when the thing under test moves.
- An e2e defends the contract that holds every run: the app either does the
  thing and says where it came from, or explains what went wrong. **Silence is
  the only unacceptable outcome.**

## Things that cost real time here

- **Playwright must run through real Node**, never `bunx` — the driver
  handshake never completes under Bun. `package.json` already does this.
- **Never reuse a dev server the test run did not start.** A stale one reported
  "every provider failed" for a request that worked perfectly against a fresh
  one. `reuseExistingServer: false` is deliberate.
- **PostgREST caches the schema.** `scripts/migrate.mjs` always reloads it;
  applying SQL by hand and skipping that produces a bare 404 on a table that
  exists.
- **`ON CONFLICT` cannot infer an expression index or a partial index.**
  PostgREST sends column names only, so `unique (grant_id, lower(label))` and
  `unique (…) where x is not null` both fail with "no unique or exclusion
  constraint matching the ON CONFLICT specification".
- **Chunk `.in("id", […])`.** A few hundred UUIDs overflow Kong's header buffer
  and come back as "an invalid response was received from the upstream server",
  which says nothing about length.
- **Never edit files with PowerShell.** `Set-Content -Encoding utf8` writes BOMs
  and mojibakes accented characters; it has broken this repo's builds and tests
  more than once. Use the editing tools.
- **An effect can run twice before either pass commits.** Select-then-insert
  raced itself and showed the consultant a raw unique-constraint error; upsert
  and let the constraint arbitrate.
- **Do not reload after an optimistic update succeeds.** The reload returns a
  snapshot taken before the write landed, and ticking several checkboxes quickly
  un-ticked the earlier ones in front of the user.
- **On failure, revert only what failed.** Re-reading everything to recover from
  one failed write clobbers the optimistic state of the writes still in flight
  beside it. Three separate bugs on the proposal screen were this same shape: a
  read returning a snapshot older than the writes around it.

- **Postgres unique index expressions must be strictly IMMUTABLE.**
  Casting `(created_at::date)` in a unique index throws
  "functions in index expression must be marked IMMUTABLE". Use an explicit
  column such as `created_date date not null default current_date` and index
  the plain column.
- **Deduplicate alerts at the outbox layer.**
  A continuous 24/7 discovery daemon re-evaluating matches can easily spam
  consultants. An `email_outbox` table with a daily deduplication index
  `(recipient_email, kind, grant_id, client_id, created_date)` prevents
  repetitive notifications on identical days.
- **Tenant subdomains and RLS.**
  Subdomains (`iial.grantdesk.app`, `acme.grantdesk.ca`) route into
  `src/lib/tenant.ts` and map to tenant isolation in PostgreSQL via
  `public.belongs_to_tenant(tenant_id)`. Never let a query bypass tenant
  scoping.

## House style

Migrations are history: once applied, add a new one rather than editing it.
Conventional commits with real messages — say what changed and why it was worth
changing. Adding a seventh screen means deleting one (ADR-0002).
