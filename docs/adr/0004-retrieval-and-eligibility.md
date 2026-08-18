# ADR-0004 — Fuzzy retrieval, deterministic verdicts

Status: accepted (Phase 3)

## Context

The product's claim is "fewer results, verified, with the receipts". Two
different jobs hide inside that sentence, and conflating them is how the
predecessor ended up presenting keyword hits as decisions.

**Finding** a candidate call is a recall problem. A client whose profile says
"environment" should still see a call titled "Urban Climate Resilience", and
no exact-match scheme will do that.

**Deciding** whether they may apply is not a recall problem at all. It has a
right answer, the consultant will stake a client relationship on it, and it has
to be the same answer every time the page loads.

## Decision

Retrieval is fuzzy; the verdict is not. Nothing probabilistic touches the
verdict.

### Retrieval — tsvector + pgvector, fused with RRF (k = 60)

Two rankings over the same candidate set, combined by Reciprocal Rank Fusion.
RRF is used rather than a weighted score because `ts_rank_cd` and cosine
distance are on unrelated scales; any weighting between them would be a number
we invented and could not defend.

Either half may be missing — a profile with no sectors has no lexical query, a
catalog row that arrived while the embedder was down has no vector — and the
function degrades to whichever half it has. The UI states which halves ran, so
a degraded result is visibly degraded.

Lexical indexing is per grant language (`english`, `french`, `spanish`,
`portuguese`) rather than `simple`. The original `simple` configuration did no
stemming, so "environmental" never matched "Environment Fund"; across four
languages in the Américas that was a large silent recall loss. Cross-language
matching is left to the vector side, which is what it is good at.

Embeddings are local (`nomic-embed-text`, 768d) because the catalog is tens of
thousands of rows that re-embed whenever a funder edits a description. Per-token
pricing would dominate the system's entire cost for a job that needs no cloud
judgement.

### Verdicts — rules, with a third answer

Four rules run per candidate. Three are hard gates (jurisdiction, deadline,
applicant type); one is advisory (scale). Every rule result is persisted, not
just the deciding one.

The important design choice is that a rule returns **pass, fail, or unknown**,
not a boolean. Unknown means the funder did not publish enough to decide.
Folding that into a pass would claim verification we did not perform; folding
it into a fail would invent a restriction the funder never stated. Keeping it
as a third answer is what separates a *verified* match from a plausible one,
and it is what the `needs_input` verdict is built on.

Ineligible results are stored and shown, collapsed. Filtering them out in SQL
would produce a shorter, cleaner list and destroy the product: a consultant
cannot distinguish a result that was considered and rejected from one that was
never in the catalog, and only one of those is a reason to keep looking.

## Consequences

Eligibility is only as good as the structured data behind it, and that data is
unevenly available. Grants.gov publishes machine-readable applicant types for
about 77% of its opportunities; Innovation Canada's workbook publishes none, so
Canadian calls report applicant type as unverified rather than guessed. This
asymmetry is real and is surfaced rather than smoothed over — inferring
applicant types from description prose was considered and rejected, because a
false positive there creates a *hard gate* that wrongly rules a client out.

## Measured

`bun run eval:match`, over a hand-labelled corpus built around vocabulary gaps
and deliberate lexical traps:

| arm | P@5 | recall | traps in top 5 |
|---|---|---|---|
| keyword baseline (the predecessor's `ilike` scan) | 24% | 33% | 6 |
| hybrid (this ADR) | 60% | 100% | 1 |

P@5's ceiling on that corpus is 60% — each profile has only three relevant
grants for five slots — so hybrid retrieval reaches the maximum achievable
precision while the baseline reaches 40% of it.

The trap count is the least stable of the three numbers: the corpus is loaded
into the live catalog and each arm's candidate pool is capped before results are
filtered back to it, so which non-relevant rows reach the top five shifts as the
catalog grows (1 to 3 for the hybrid arm after a re-ingestion). Precision and
recall have held. The comparison is sound because both arms face the same
catalog in the same run, but these are not fixed benchmark figures.

The corpus is hand-written rather than sampled from the live catalog, and
labelled by hand rather than by a model. A model-judged eval measures the judge
as much as the retriever: the score moves when the judge changes and nobody can
tell why. Fixed labels mean a change in the score is always a change in
retrieval. The cost of that choice is that it measures the retrieval mechanism
rather than real-world precision, which is stated here rather than glossed.

## Deferred, deliberately

- **Cross-encoder reranking.** Large reported gains (+17pp MRR@3), but measured
  on unrelated domains, and it costs a forward pass per candidate. Revisit when
  we can measure it on this corpus rather than adopt it on reputation.
- **Real BM25** via a Postgres extension. Needs a custom image; see ADR-0003.
