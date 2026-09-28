# ADR-0005 — Relevance and eligibility are two answers, never one score

Status: accepted

## Context

The competitive picture, checked rather than assumed:

**Submittable** is funder-side software — form builders, review workflows,
disbursement. It is not a competitor to this product; a consultant helping
organizations _apply_ is not its user, and reviewers say so plainly. Its pricing
($1k–$10k+/year) is for running a grant program, not seeking one.

**Instrumentl** ($179–$899/month) is the real comparison. It does exactly what
Phase 3 does: take an organization's profile and return ranked opportunities
with a **match score**. It is explicitly recommended for "a consultant with
multiple funded clients", which is this product's user.

Two things in its reviews matter more than its feature list.

The first is what its own users say about the score. They describe spending
"quite a bit of time diving into potential matches to filter out funders that
don't match all of their research criteria", and wishing they "could refine
matches more accurately". That is the work the score existed to remove. A score
a consultant has to re-verify by hand is worth less than no score: it costs a
click and buys nothing but a false sense of having been helped.

The second is multi-client handling. Reviewers report finding it "confusing that
they could select funders for more than one project" and wishing "their core
users weren't able to see each other's projects". For a consultant, a client's
material leaking into another client's view is not a UX annoyance, it is the end
of a business relationship.

## Decision

**Never merge relevance and eligibility into a single number.**

A match answers two independent questions and states them separately:

- **May this client apply?** Decided by rules, with the deciding rule quoted.
  Already the design (ADR-0004).
- **Is this worth an hour?** Answered as the client's own words found in the
  funder's own text — "This funder's own text mentions 'environment' and
  'community'" — or, when there are none, as a plain admission that the match
  came from meaning rather than wording.

Both claims are small enough for a consultant to check against the call in
seconds. That is the property a score does not have and cannot be given: a
number cannot be wrong in a way you can see, so it has to be re-verified in
full or trusted blindly, and consultants sensibly do the former.

The vector-only case is stated rather than hidden. A call titled "Urban Climate
Resilience" that shares no word with a profile saying "environment" is the most
valuable result the system can produce and the easiest to distrust, so it says
what it is instead of dressing itself up as a 87% match.

**Client isolation stays a database property, not a UI one.** Row-level security
already makes one consultant's clients unreachable from another's session, and
`tests/integration/rls-isolation` proves it rather than asserting it. Every
screen is scoped to one client by its route. The incumbent's reported confusion
here is a design that shows several clients at once; this product does not have
that surface to get wrong.

## Consequences

- Matched terms are computed at match time and **stored** on the match, not
  recomputed for display. A profile can be edited after a verdict was decided,
  and a stated reason that silently rewrites itself to fit the current profile
  is not a reason.
- Term matching is on word boundaries with a small plural allowance, never
  substrings. The predecessor let "nsf" match "tra**nsf**er"; one visible false
  claim like that costs the consultant's trust in every other result on the
  page.
- We give up the one thing a score is good for: sorting. Ordering still comes
  from the RRF score, which is honest about being a ranking rather than a
  judgement, and is never shown as a percentage.

## Sources

- https://www.capterra.com/p/233384/Instrumentl/reviews/
- https://www.fundrobin.com/articles/how-to-guide/ai-tools-for-nonprofits/grant-software-instrumentl-alternatives-2026/
- https://www.softwareadvice.com/nonprofit/instrumentl-profile/reviews/
