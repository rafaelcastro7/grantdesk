import { describe, expect, it } from "vitest";
import { decideEligibility, type EligibilityInput } from "./eligibility";

const TODAY = new Date("2026-08-16T12:00:00Z");

function input(over: {
  grant?: Partial<EligibilityInput["grant"]>;
  client?: Partial<EligibilityInput["client"]>;
}): EligibilityInput {
  return {
    grant: { country: "CA", deadline: "2026-12-01", status: "open", ...over.grant },
    client: { jurisdictions: ["CA"], stage: "nonprofit", ...over.client },
    today: TODAY,
  };
}

function check(decision: ReturnType<typeof decideEligibility>, key: string) {
  const found = decision.checks.find((c) => c.key === key);
  if (!found) throw new Error(`no ${key} check was produced`);
  return found;
}

describe("jurisdiction", () => {
  it("rules out a grant restricted to a country the client is not in, and says which", () => {
    const decision = decideEligibility(input({ grant: { country: "US" } }));

    expect(decision.verdict).toBe("ineligible");
    expect(check(decision, "jurisdiction").status).toBe("fail");
    // The reason has to name both sides, or the consultant cannot tell whether
    // the grant is wrong or the profile is.
    expect(decision.headline).toContain("US");
    expect(decision.headline).toContain("CA");
  });

  it("treats a province as being inside its country", () => {
    const decision = decideEligibility(input({ client: { jurisdictions: ["CA-ON"] } }));
    expect(decision.verdict).toBe("eligible");
  });

  it("lets a multilateral funder through regardless of where the client is", () => {
    const decision = decideEligibility(
      input({ grant: { country: "INTL" }, client: { jurisdictions: ["MX"] } }),
    );
    expect(check(decision, "jurisdiction").status).toBe("pass");
  });

  it("asks rather than guesses when the client's location is unknown", () => {
    const decision = decideEligibility(input({ client: { jurisdictions: [] } }));
    expect(decision.verdict).toBe("needs_input");
  });
});

describe("deadline", () => {
  it("rules out a closed call", () => {
    const decision = decideEligibility(input({ grant: { deadline: "2026-01-05" } }));
    expect(decision.verdict).toBe("ineligible");
    expect(decision.headline).toContain("2026-01-05");
  });

  it("passes a call with no published closing date instead of discarding it", () => {
    const decision = decideEligibility(input({ grant: { deadline: null } }));
    expect(check(decision, "deadline").status).toBe("pass");
    expect(decision.verdict).toBe("eligible");
  });

  it("warns when a deadline is close enough to change the consultant's week", () => {
    const decision = decideEligibility(input({ grant: { deadline: "2026-08-22" } }));
    expect(check(decision, "deadline").detail).toMatch(/days left/);
  });

  it("does not silently pass a call whose status is no longer open", () => {
    const decision = decideEligibility(input({ grant: { status: "closed" } }));
    expect(decision.verdict).toBe("ineligible");
  });
});

describe("applicant type", () => {
  it("rules out a client whose legal form is not on the funder's list", () => {
    const decision = decideEligibility(
      input({
        grant: { eligibleApplicantTypes: ["academic", "government"] },
        client: { stage: "nonprofit" },
      }),
    );
    expect(decision.verdict).toBe("ineligible");
    expect(decision.headline).toContain("universities");
  });

  it("clears a registered charity against a list that names nonprofits", () => {
    const decision = decideEligibility(
      input({ grant: { eligibleApplicantTypes: ["nonprofit"] }, client: { stage: "charity" } }),
    );
    expect(decision.verdict).toBe("eligible");
  });

  it("does not invent a restriction when the funder published no applicant list", () => {
    const decision = decideEligibility(input({ grant: { eligibleApplicantTypes: [] } }));

    // Unverified, but not a gate — an unpublished list is the funder's silence,
    // not a rule against this client.
    const rule = check(decision, "applicant_type");
    expect(rule.status).toBe("unknown");
    expect(rule.isHardGate).toBe(false);
    expect(decision.verdict).toBe("eligible");
    // ...and the verdict must admit what it did not check.
    expect(decision.headline).toMatch(/read their terms/);
  });

  it("asks for the client's legal form when the funder does restrict by it", () => {
    const decision = decideEligibility(
      input({ grant: { eligibleApplicantTypes: ["nonprofit"] }, client: { stage: null } }),
    );
    expect(decision.verdict).toBe("needs_input");
  });
});

describe("scale", () => {
  it("flags an award far beyond the client's budget without ruling it out", () => {
    const decision = decideEligibility(
      input({
        grant: { amountMin: 5_000_000, currency: "CAD" },
        client: { annualBudget: 200_000 },
      }),
    );

    const rule = check(decision, "scale");
    expect(rule.status).toBe("fail");
    expect(rule.isHardGate).toBe(false);
    expect(decision.verdict).toBe("eligible");
  });
});

describe("verdict precedence", () => {
  it("reports a hard failure ahead of a missing answer", () => {
    const decision = decideEligibility(
      input({ grant: { country: "US" }, client: { jurisdictions: ["CA"], stage: null } }),
    );
    expect(decision.verdict).toBe("ineligible");
  });

  it("says plainly when everything checkable passed", () => {
    const decision = decideEligibility(
      input({
        grant: { eligibleApplicantTypes: ["nonprofit"], amountMin: 50_000 },
        client: { stage: "nonprofit", annualBudget: 400_000 },
      }),
    );
    expect(decision.verdict).toBe("eligible");
    expect(decision.headline).toBe("Meets every published requirement.");
  });
});
