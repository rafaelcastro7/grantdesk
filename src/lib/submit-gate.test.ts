import { describe, expect, it } from "vitest";
import { assessSubmission, countGaps, type SubmitCandidate } from "./submit-gate";

const TODAY = new Date("2026-08-16T12:00:00Z");

function candidate(over: Partial<SubmitCandidate> = {}): SubmitCandidate {
  return {
    verdict: "eligible",
    verdictAt: "2026-08-01T00:00:00Z",
    profileUpdatedAt: "2026-07-01T00:00:00Z",
    deadline: "2026-12-01",
    sections: [
      { label: "Project Description", content: "A complete answer.", wordLimit: 500, wordCount: 3 },
    ],
    conditions: [],
    humanReviewed: true,
    alreadySubmitted: false,
    today: TODAY,
    ...over,
  };
}

const keys = (c: SubmitCandidate) => assessSubmission(c).blockers.map((b) => b.key);

describe("a ready application", () => {
  it("has nothing blocking it", () => {
    const result = assessSubmission(candidate());
    expect(result.blockers).toEqual([]);
    expect(result.canSubmit).toBe(true);
  });
});

describe("hard blockers", () => {
  it("refuses a call the rules ruled this client out of", () => {
    const result = assessSubmission(candidate({ verdict: "ineligible" }));
    expect(result.canSubmit).toBe(false);
    expect(result.canOverride).toBe(false);
  });

  it("refuses a closed call", () => {
    expect(keys(candidate({ deadline: "2026-01-01" }))).toContain("closed");
  });

  it("names the section that has not been written", () => {
    const result = assessSubmission(
      candidate({
        sections: [{ label: "Budget Narrative", content: "   ", wordLimit: null, wordCount: 0 }],
      }),
    );
    expect(result.blockers[0]!.detail).toContain("Budget Narrative");
  });

  it("refuses a draft that still admits a missing fact", () => {
    // Otherwise "[NEED: number of participants]" reaches the funder verbatim.
    const result = assessSubmission(
      candidate({
        sections: [
          {
            label: "Impact",
            content: "We served [NEED: how many] people in [NEED: which year].",
            wordLimit: null,
            wordCount: 8,
          },
        ],
      }),
    );
    expect(result.canSubmit).toBe(false);
    expect(result.blockers.find((b) => b.key === "unfilled_gaps")!.detail).toContain(
      "2 marked gaps",
    );
  });

  it("refuses when a condition the call rejects without is unconfirmed", () => {
    const result = assessSubmission(
      candidate({
        conditions: [
          { label: "Audited financial statements", isCritical: true, acknowledged: false },
        ],
      }),
    );
    expect(result.blockers.find((b) => b.key === "unmet_conditions")!.detail).toContain(
      "Audited financial statements",
    );
  });

  it("ignores a non-critical condition", () => {
    expect(
      keys(
        candidate({
          conditions: [{ label: "Optional letter", isCritical: false, acknowledged: false }],
        }),
      ),
    ).not.toContain("unmet_conditions");
  });

  it("never lets a machine decide the application was reviewed", () => {
    // This is the line where a person takes responsibility for everything above.
    const result = assessSubmission(candidate({ humanReviewed: false }));
    expect(result.canSubmit).toBe(false);
    expect(result.canOverride).toBe(false);
    expect(result.blockers.find((b) => b.key === "not_reviewed")).toBeTruthy();
  });

  it("refuses to record a second submission for the same application", () => {
    expect(keys(candidate({ alreadySubmitted: true }))).toContain("already_submitted");
  });
});

describe("soft blockers", () => {
  it("warns when a section was written by the local fallback, without refusing", () => {
    // The chain falls through to a small local model when the hosted ones are
    // unreachable, and the eval measured that model inventing figures where
    // the hosted one did not. The consultant is entitled to know before it
    // reaches a funder — and entitled to send it anyway.
    const result = assessSubmission(
      candidate({
        sections: [
          {
            label: "Impact",
            content: "A complete answer.",
            wordLimit: null,
            wordCount: 3,
            draftedBy: "ollama/phi4-mini",
          },
        ],
      }),
    );

    const blocker = result.blockers.find((b) => b.key === "fallback_model");
    expect(blocker?.isHard).toBe(false);
    expect(blocker?.detail).toContain("Impact");
    expect(result.canOverride).toBe(true);
  });

  it("says nothing when the intended model wrote it", () => {
    const result = assessSubmission(
      candidate({
        sections: [
          {
            label: "Impact",
            content: "A complete answer.",
            wordLimit: null,
            wordCount: 3,
            draftedBy: "groq/openai/gpt-oss-120b",
          },
        ],
      }),
    );
    expect(result.blockers).toEqual([]);
  });

  it("lets the consultant override an unsettled eligibility verdict", () => {
    const result = assessSubmission(candidate({ verdict: null }));
    expect(result.canSubmit).toBe(false);
    // Their client, their call — but they are told what they are overriding.
    expect(result.canOverride).toBe(true);
  });

  it("says matching never ran, not that it ran and found a gap", () => {
    // A grant reached by direct link, never sent through matching, is a
    // different fact than one matching genuinely could not settle — the
    // first means "nobody has looked", the second means "the profile is
    // missing something specific". Collapsing them into one message told a
    // consultant to "fill the profile field it is waiting on" when no field
    // had ever been identified as missing.
    const never = assessSubmission(candidate({ verdict: null }));
    expect(never.blockers.map((b) => b.key)).toContain("never_matched");

    const needsInput = assessSubmission(candidate({ verdict: "needs_input" }));
    expect(needsInput.blockers.map((b) => b.key)).toContain("unverified_eligibility");
  });

  it("counts every over-limit section, not just the first", () => {
    // Naming only the first one meant fixing it just surfaced a second
    // section over the limit for the first time on the next check — the
    // same failure empty_sections and unfilled_gaps already avoid by
    // counting.
    const result = assessSubmission(
      candidate({
        sections: [
          { label: "Project Description", content: "long", wordLimit: 100, wordCount: 150 },
          { label: "Budget Narrative", content: "long", wordLimit: 100, wordCount: 120 },
        ],
      }),
    );
    const blocker = result.blockers.find((b) => b.key === "over_limit")!;
    expect(blocker.detail).toContain("2 sections");
    expect(blocker.detail).toContain("Project Description");
  });

  it("flags an eligible verdict left over from before a profile edit", () => {
    // Matching ran, found "eligible", and nothing re-ran it since — but the
    // profile it ran against is not the one that exists now. Silence here
    // would let a since-invalidated "yes" sit next to the submit button
    // looking exactly like a current one.
    const stale = candidate({
      verdictAt: "2026-08-01T00:00:00Z",
      profileUpdatedAt: "2026-08-15T00:00:00Z",
    });
    const result = assessSubmission(stale);
    expect(result.blockers.map((b) => b.key)).toContain("stale_eligibility");
    expect(result.canOverride).toBe(true);
  });

  it("does not flag an eligible verdict computed after the profile's last edit", () => {
    expect(
      keys(
        candidate({ verdictAt: "2026-08-15T00:00:00Z", profileUpdatedAt: "2026-08-01T00:00:00Z" }),
      ),
    ).not.toContain("stale_eligibility");
  });

  it("states an over-limit section without enforcing it", () => {
    // Some funders truncate and some reject; we cannot know which, so we say
    // it rather than decide it.
    const result = assessSubmission(
      candidate({
        sections: [{ label: "Summary", content: "words", wordLimit: 100, wordCount: 140 }],
      }),
    );
    expect(result.canOverride).toBe(true);
    expect(result.blockers[0]!.detail).toContain("40 words over");
  });
});

describe("countGaps", () => {
  it("counts only real markers", () => {
    expect(countGaps("We need [NEED: a number] and [NEED: a date].")).toBe(2);
    expect(countGaps("We need nothing.")).toBe(0);
    expect(countGaps(null)).toBe(0);
  });
});

describe("documents linked from the register", () => {
  const doc = (expiresOn: string | null) => ({
    requirement: "Proof of insurance",
    title: "CGL certificate 2025",
    expiresOn,
  });

  it("warns, naming the document, when a linked document has expired", () => {
    const result = assessSubmission(candidate({ linkedDocuments: [doc("2026-08-01")] }));
    const blocker = result.blockers.find((b) => b.key === "expired_document");
    expect(blocker?.isHard).toBe(false);
    expect(blocker?.detail).toContain("CGL certificate 2025");
    expect(result.canOverride).toBe(true);
  });

  it("warns when it expires before the call closes", () => {
    expect(keys(candidate({ linkedDocuments: [doc("2026-10-01")] }))).toEqual([
      "document_expires_before_deadline",
    ]);
  });

  it("says nothing when it outlasts the deadline or carries no date", () => {
    expect(keys(candidate({ linkedDocuments: [doc("2027-01-01"), doc(null)] }))).toEqual([]);
  });
});

describe("blockers name who has the work", () => {
  it("names the owner and internal due date of an empty section", () => {
    const result = assessSubmission(
      candidate({
        sections: [
          {
            label: "Budget Narrative",
            content: "",
            wordLimit: null,
            wordCount: 0,
            owner: "Maria Lopez",
            dueOn: "2026-10-03",
          },
        ],
      }),
    );
    const empty = result.blockers.find((b) => b.key === "empty_sections")!;
    expect(empty.detail).toBe(
      `"Budget Narrative" (owner Maria Lopez, due 2026-10-03) has not been written yet.`,
    );
  });

  it("names the owner of an unacknowledged condition", () => {
    const result = assessSubmission(
      candidate({
        conditions: [
          {
            label: "Audited statements",
            isCritical: true,
            acknowledged: false,
            owner: "Sam",
            dueOn: null,
          },
        ],
      }),
    );
    const unmet = result.blockers.find((b) => b.key === "unmet_conditions")!;
    expect(unmet.detail).toContain(`"Audited statements" (owner Sam, no internal due date)`);
  });

  it("says nothing extra when nothing is assigned", () => {
    const result = assessSubmission(
      candidate({
        sections: [{ label: "Impact", content: null, wordLimit: null, wordCount: 0 }],
      }),
    );
    expect(result.blockers.find((b) => b.key === "empty_sections")!.detail).toBe(
      `"Impact" has not been written yet.`,
    );
  });
});
