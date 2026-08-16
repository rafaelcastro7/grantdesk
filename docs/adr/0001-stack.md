# ADR-0001 — Stack, and what we deliberately reuse

**Status:** accepted · 2026-08-16

## Context

GrantDesk replaces a system whose *engine* was sound and whose *surface* was not.
An audit of the predecessor proved the pipeline end to end: 452 unit tests, 39
e2e specs, a real proposal drafted and submitted, 3,014 ingested grants. The
problems were organizational — two parallel UIs, documentation that contradicted
the code, silent degradation — not a failure of the core technology.

Rewriting a working engine is the classic mistake. Carrying a confused surface
forward is the other one.

## Decision

**Keep the stack that was proven:**

- React + TanStack Start (file routes, SSR, server functions)
- Self-hosted Supabase: Postgres + RLS + pgvector
- Tailwind + shadcn/ui (owned components, not a dependency)
- Vitest for units, Playwright for e2e — invoked through real Node, never `bunx`
- Cloud LLM chain with local Ollama as the floor

**Port by extraction, not rewrite.** Proven modules move across with their tests
attached: hybrid retrieval, the F1–F5 rule engine, jurisdiction fit, agent
traces, the submit gate, the three open-data importers, startup validation.

**Rebuild the surface.** Six screens against a written scope boundary
(ADR-0002).

## Consequences

- "Port ~8 modules" understates it: those modules depend on schema, profile and
  migration shape, so extraction pulls a wider graph than the file count
  suggests. Budget for that; do not pretend otherwise.
- If extraction stalls, the honest fallback is to consolidate the predecessor in
  place rather than to keep a half-built parallel system alive. That decision
  gets a date, not a vibe.
- Total isolation from the predecessor is required so both can run at once:
  separate folder, app on **:5180**, Postgres on **:15532**, gateway on
  **:15535**, distinct docker compose project name.
