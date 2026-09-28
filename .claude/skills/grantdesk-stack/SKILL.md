---
name: grantdesk-stack
description: Work on the GrantDesk app — its self-hosted Supabase stack, hybrid retrieval, deterministic eligibility rules, drafting, and its test/eval split. Load before writing migrations, server functions, Playwright specs, or evals in this repo, and before debugging a failure that looks like infrastructure rather than code.
---

# GrantDesk — stack, gates, and the failures that cost time

Every item below was hit for real while building this app. Skip to whichever
symptom matches.

## The split everything else follows from

Retrieval is fuzzy; verdicts are not. Ranking is tsvector + pgvector fused by
RRF. Eligibility is four deterministic rules in `src/lib/eligibility.ts`, and
each returns **pass, fail, or unknown** — never a boolean. Before adding a rule,
decide what it says when the funder published nothing. If the answer is not
"unknown", the rule is wrong.

Ineligible matches are stored and shown collapsed, never filtered out. A result
that silently disappears is indistinguishable from one that was never found, and
only one of those means the consultant should keep looking.

## Which harness does this behaviour belong in?

- **Unit test** — decidable and pure: rules, query builders, parsers, gates.
- **Integration test** — needs the live database: RLS, upsert conflict targets,
  idempotency, "does the row survive".
- **Eval** — anything a model decides. One live round-trip is a sample, not a
  verdict: a Phase 1 e2e asserted a good profile from a single extraction,
  passed, then failed on an identical build.
- **e2e** — the contract that holds every run. Write it read-and-branch: either
  the thing happened and says where it came from, or an error explains itself.
  Assert-and-wait burns the whole timeout and reports only "waiting for
  locator", which names no cause.

Evals here check the **text**, not a judge's opinion of it. `eval:match` scores
a hand-labelled corpus built around vocabulary gaps and deliberate lexical
traps; `eval:drafting` checks that every number in a draft traces back to a fact
we supplied. A model-judged eval moves when the judge changes and nobody can
tell why.

## Running tests

Playwright must go through real Node, never `bunx` — the driver handshake never
completes under Bun's runtime and the run hangs forever. `package.json` already
does this; use `bun run test:e2e`.

`bun run verify` is hermetic: lint, typecheck, unit tests, build, no network.
Keep it that way. A gate that fails for reasons that are not the code's fault is
a gate people learn to re-run.

## "every provider failed" from a request that plainly works

A dev server left running from an earlier session. It answered with an empty
provider chain for a request that worked perfectly against a fresh one, and a
whole suite run went into reporting a defect that did not exist.
`playwright.config.ts` sets `reuseExistingServer: false` for exactly this. If a
dev server is already up, Playwright says so plainly — kill it and re-run.

## A bare 404 on a table that exists

PostgREST caches the schema at startup. `scripts/migrate.mjs` always reloads it
after applying; running SQL by hand through `docker exec … psql` and skipping
that leaves the cache behind the database. Prefer `bun run db:migrate`.

## "no unique or exclusion constraint matching the ON CONFLICT specification"

Postgres cannot infer an ON CONFLICT target from either an **expression** index
or a **partial** index, and PostgREST sends bare column names. Both of these
looked right and failed:

```sql
create unique index … on requirements (grant_id, lower(label));                      -- expression
create unique index … on proposal_sections (…) where requirement_id is not null;     -- partial
```

Index the plain columns. Nulls are distinct in a unique index anyway, so the
partial predicate bought nothing.

## "An invalid response was received from the upstream server"

Kong's header buffer, not a server error. A PostgREST `in.(…)` list travels in
the query string, and a few hundred UUIDs overflow it. Chunk at 50.

## Kong CORS

Do **not** enumerate allowed headers in `supabase/kong.yml`. Each new
Supabase-js version adds one (`x-supabase-api-version`, `accept-profile`,
`x-retry-count`) and each is a fresh preflight rejection. With no `headers`
list, Kong echoes the preflight and it stops happening.

## React effects and the database

- **An effect can run twice before either pass commits.** Select-then-insert
  raced itself: both saw no row, both inserted, and the consultant got a raw
  unique-constraint error. Upsert with a conflict target; let the constraint
  arbitrate.
- **Do not reload after a successful optimistic update.** The reload returns a
  snapshot taken before the write landed — ticking several checkboxes quickly
  un-ticked the earlier ones on screen while every write had succeeded.
- **On failure, revert only the one thing that failed.** Re-reading the whole
  set to recover clobbers the optimistic state of the writes still in flight
  beside it: one failed acknowledgement silently dropped its neighbours, and the
  submit gate then refused for a condition the consultant could see was ticked.
  Three bugs on that one screen have been this shape — a read returning a
  snapshot older than the writes around it.
- **Clear derived state synchronously, on the event.** Clearing it after an
  await let a slow write wipe the result of a newer request the user had already
  asked for.
- **SSR markup is clickable before React binds handlers.** A controlled form
  submitted its empty initial state and the server answered about the wrong
  thing entirely. Use uncontrolled forms plus FormData, and wait on
  `html[data-hydrated='true']` in specs.
- **Key an uncontrolled input on its stored value** (`key={defaultValue}`), or a
  fresh extraction never replaces what the field shows, and the stale text gets
  saved back over the new profile.

## The embedder is multilingual on purpose

`bge-m3`, 1024 dimensions. It started as `nomic-embed-text` (768d) and the eval
refuted the assumption behind that choice: an English model rated a relevant
French call 0.5537 and an irrelevant one 0.4699 — a 0.084 gap that does not
survive thousands of English documents competing for the same ranking. bge-m3
separates them by 0.226. Cross-language recall went from 33% to what the eval
now reports.

Changing embedder changes the vector width, which means a migration and a full
re-embed. Stored vectors are dropped rather than converted: there is no
meaningful conversion between two models' spaces, and a half-migrated index
returns confident nonsense instead of an error.

## Ingestion and external data

- **Grants.gov Search2 returns titles only.** Descriptions, award ranges and
  structured applicant types need `fetchOpportunity`, one call per opportunity,
  bounded by a small worker pool.
- **Forecasted opportunities publish under `forecast`, not `synopsis`.** Reading
  only the latter silently dropped a third of the feed's descriptions.
- **Detail _pages_ are JavaScript shells.** Fetching a Grants.gov opportunity
  URL returns a document containing none of its own requirements. Read from the
  text ingestion already captured; fall back to the URL only when we hold
  nothing.
- **Never infer structured eligibility from prose.** A false positive there
  creates a _hard gate_ that wrongly rules a client out. Innovation Canada's
  workbook publishes no applicant list, so Canadian calls report applicant type
  as unverified — an honest asymmetry, surfaced rather than smoothed over.
- **Prior winners come from USAspending**, keyed on the Assistance Listing
  number the call itself carries. Where a market publishes nothing comparable,
  say so: an empty list reads as "nobody has ever won this".
- **Integration fixtures must clean up after themselves.** Their rows land in
  the shared catalog and get counted on the coverage page as real grants — the
  exact overstatement this product exists to stop making.

## Reasoning models need budget to think, not just to write

`gpt-oss-120b` spends about 700 tokens working out what to say before emitting
a character. Below a ~1500-token ceiling it returns `finish_reason: "length"`
with **zero visible content** — a perfectly valid HTTP 200 containing nothing.

Sizing `max_tokens` from the desired output length is therefore a trap: a
150-word section at `wordLimit * 3` is 450 tokens, which is a guaranteed empty
response, which the chain then reads as a provider failure and answers from the
local floor instead. Drafts were arriving from the small local model for that
reason alone, and nothing said so.

Budget for the thinking as well: `REASONING_HEADROOM + words * 3`. An
over-budget request costs nothing when the model stops on its own; an
under-budget one costs the whole call.

## Provider order is a measurement, not an opinion

`bun run benchmark` probes every provider on every role with representative
calls and prints a suggested order with the date. `order()` in
`src/server/llm.ts` carries that table and that date.

Do not reason about which model is "bigger" or "faster" from memory — the
rationale that lived there described models that had since been retired, which
reads like a decision while being none. And do not over-fit to the benchmark's
own load: nine calls in a few seconds provokes a 429 that says nothing about
the provider.

## One token budget, shared by everything

This account's hosted models allow ~8000 tokens a minute, and it is the binding
constraint on anything that drafts. Measured consequences:

- A draft costs ~650 tokens with `reasoning_effort: "low"`, ~1950 without. Groq
  bills the **requested** `max_tokens`, not the emitted ones, so headroom
  nobody uses is drafts nobody gets.
- The lifecycle e2e drafts every section a call asks for, so it takes about
  five minutes and is the heaviest thing in the suite.
- **Do not run `eval:drafting` and the e2e suite at the same time.** They share
  the ceiling; the loser falls through to the local model, and then one is
  measuring the other's load rather than the product. A twenty-draft eval run
  followed immediately by the e2e made the lifecycle time out, and re-running it
  alone passed unchanged.

A consultant drafting a full proposal hits the same ceiling. That is a real
product limitation on this tier, not a test artefact.

## Never edit files with PowerShell

`Set-Content -Encoding utf8` writes BOMs and mojibakes accented characters. It
has broken a build (BOM in `package.json`), a French export test, and an eval
file's dashes. Use the editing tools. To put a literal invisible character in a
regex, build it from ASCII:

```ts
const INVISIBLES = new RegExp(["\\uFEFF", "\\u200B", "\\u200C"].join("|"), "g");
```

## This machine has no GPU, and that decides the local model

An i7-6700HQ from 2015, four physical cores, 48 GB of RAM, Intel HD 530
integrated graphics. Everything runs on CPU, so a model's size _is_ its speed
and speed is a quality attribute rather than a comfort: a draft nobody waits
for was not produced.

Measured (`bun run benchmark:local`):

- `phi4-mini` (3.8B Q4): 4.6 tok/s generating. A 250-word section is ~350
  tokens, so about 76 seconds.
- `dolphin3` (8B Q4): 1.5 tok/s. Not usable for drafting here.

This is why a lifecycle e2e run that falls through to the local model takes
five minutes. It is physics, not a defect.

Two things that are _not_ the model:

- **Load time was half the cost.** A cold load is 6.9s before a single token;
  warm is 0.8s. Ollama unloads after five minutes idle, which is exactly the
  rhythm of drafting one section at a time — so nearly every fallback call paid
  it. `keep_alive: "30m"` on the request fixes it.
- **Thread tuning does nothing here.** 4, 6 and 8 threads measured within noise
  of each other on this hyperthreaded 4-core, despite the usual advice that
  physical-core count wins. Tested because it was free, reported because it was
  my hypothesis and it did not hold.

Check sizes against the registry rather than an article: a 2026 comparison
described Gemma 4 E2B as "fits in 2 GB at Q4", and the actual
`gemma4:e2b-it-q4_K_M` tag is 7.2 GB. `gemma4:e2b-it-qat` is the compact one at
4.3 GB.

## Never write a regex escape through a Python or shell heredoc

`"\b"` in a non-raw Python string is a **backspace byte**, not the regex
word-boundary escape. It looks correct in an editor and in `sed` output, and it
silently matches nothing.

This has now happened twice in this repo. The first time, a circuit breaker
never fired for a week's worth of requests and was only caught by measuring
latency across repeated calls. The second time, `TPD` was dead inside a
working alternation — the other branches carried it, so every test passed.

Two defences, both cheap:

- `no-control-regex` is on in eslint and catches exactly this. It found the
  second one before I did.
- Build patterns from ASCII when a script is writing them:
  `new RegExp(["\bTPD\b", "per day"].join("|"), "i")`, or just edit the
  file with the editing tools instead.

## Migrations are history

Once applied anywhere, a migration is history — add a new one rather than
editing it, or the file disagrees with every database that ran it.
`bun run db:migrate` will not re-run an applied file, so an edit simply never
takes effect.

## Subdomain Multi-Tenancy & Email Outbox Deduplication

- **Subdomain Routing**: `src/lib/tenant.ts` extracts tenant slug from hostname (`iial.grantdesk.app`, `iial.localhost:5180`), search param (`?tenant=iial`), or header (`x-tenant-slug`).
- **Tenant RLS Guard**: Postgres migration `0025_tenants_and_subdomains.sql` implements `public.belongs_to_tenant(tenant_id)` as `security definer` avoiding recursion.
- **Continuous 24/7 Discovery**: `scripts/daemon-continuous-discovery.ts` runs periodic loops. Grants are deduplicated via deterministic SHA-256 `sourceHash(sourceKey, externalId)`.
- **Email Deduplication**: `0026_discovery_alerts_and_outbox.sql` creates `email_outbox` with unique index on `(recipient_email, kind, grant_id, client_id, created_date)`. Avoid casting `(created_at::date)` inside Postgres index definitions.
