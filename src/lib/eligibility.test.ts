import { describe, expect, it } from "vitest";
import {
  decideEligibility,
  detectCostSharePercent,
  detectInKindCapPercent,
  statesForeignEligibility,
  type EligibilityInput,
} from "./eligibility";

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

describe("federal notice wording (audit 2026-09-29)", () => {
  it("reads the NIH list form of foreign eligibility, and still honours its negation", () => {
    expect(
      statesForeignEligibility(
        "Other Eligible Applicants include the following: Alaska Native Corporations; Non-domestic (non-U.S.) Entities (Foreign Organizations); Regional Organizations.",
      ),
    ).toBe(true);
    expect(
      statesForeignEligibility(
        "Non-domestic (non-U.S.) Entities (Foreign Organizations) are not eligible to apply.",
      ),
    ).toBe(false);
  });

  it("never treats a forecast as open, and says when the estimate has passed", () => {
    const upcoming = decideEligibility(
      input({ grant: { status: "forecasted", deadline: null, estimatedDeadline: "2026-11-25" } }),
    );
    expect(upcoming.verdict).toBe("needs_input");
    expect(check(upcoming, "deadline").detail).toMatch(/Forecast only.*2026-11-25/);

    const stale = decideEligibility(
      input({ grant: { status: "forecasted", deadline: null, estimatedDeadline: "2025-11-25" } }),
    );
    expect(check(stale, "deadline").detail).toMatch(/has passed without the call opening/);
  });

  it("uses the source's structured cost-share flag when the prose states no share", () => {
    const decision = decideEligibility(input({ grant: { costSharingRequired: true } }));
    expect(check(decision, "cost_share").status).toBe("fail");
    expect(check(decision, "cost_share").detail).toMatch(/requiring cost sharing/);
  });
});

describe("provincial programs (senior consultant audit)", () => {
  it("rules a Quebec client out of a Saskatchewan program and names both provinces", () => {
    const decision = decideEligibility(
      input({ grant: { region: "CA-SK" }, client: { jurisdictions: ["CA", "CA-QC"] } }),
    );
    expect(decision.verdict).toBe("ineligible");
    expect(check(decision, "jurisdiction").detail).toMatch(/Saskatchewan.*Quebec/);
  });

  it("passes the client's own province and asks when the profile names none", () => {
    expect(
      check(
        decideEligibility(
          input({ grant: { region: "CA-ON" }, client: { jurisdictions: ["CA-ON"] } }),
        ),
        "jurisdiction",
      ).status,
    ).toBe("pass");
    expect(
      check(
        decideEligibility(input({ grant: { region: "CA-ON" }, client: { jurisdictions: ["CA"] } })),
        "jurisdiction",
      ).status,
    ).toBe("unknown");
  });

  it("leaves federal and US department jurisdictions to the country rule", () => {
    for (const region of ["CA-Federal", "US-HHS", null]) {
      expect(
        check(
          decideEligibility(
            input({ grant: { region }, client: { jurisdictions: ["CA", "CA-QC"] } }),
          ),
          "jurisdiction",
        ).status,
      ).toBe("pass");
    }
  });
});

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

  describe("a US call that says foreign applicants may apply", () => {
    // Real grants.gov synopses distinguish "US federal money" from "US
    // applicants only", and the two get conflated by the one field we store.
    // Getting this right matters more than usual: a false "eligible" sends a
    // consultant to draft against a call that will bounce them, so a hit
    // downgrades the hard fail to a question rather than clearing it outright.
    it("turns a hard fail into a question, quoting the funder", () => {
      const decision = decideEligibility(
        input({
          grant: {
            country: "US",
            eligibilityNote: "Foreign entities are eligible to apply for this opportunity.",
          },
        }),
      );
      expect(decision.verdict).toBe("needs_input");
      const rule = check(decision, "jurisdiction");
      expect(rule.status).toBe("unknown");
      expect(rule.detail).toContain("foreign applicants are eligible");
    });

    it("recognizes the phrasing however it's worded", () => {
      expect(statesForeignEligibility("International organizations are eligible.")).toBe(true);
      expect(
        statesForeignEligibility("Non-U.S. entities are eligible to apply for this program."),
      ).toBe(true);
      expect(statesForeignEligibility("Applicants outside the United States may apply.")).toBe(
        true,
      );
    });

    it("never overrides an explicit restriction, even nearby wording", () => {
      expect(
        statesForeignEligibility("Foreign entities are not eligible to apply for this program."),
      ).toBe(false);
      expect(
        statesForeignEligibility("This program is restricted to foreign applicants only."),
      ).toBe(false);
      expect(statesForeignEligibility("US-based nonprofits are eligible.")).toBe(false);
    });

    it("stays a hard fail when the call says nothing about nationality", () => {
      const decision = decideEligibility(
        input({ grant: { country: "US", eligibilityNote: "Applications are due quarterly." } }),
      );
      expect(decision.verdict).toBe("ineligible");
    });
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
    // Past a certain ratio, "a stretch" undersells it — this is well past.
    expect(rule.detail).toContain("likely beyond what it can manage");
  });

  it("calls a smaller multiple a stretch, not a likely impossibility", () => {
    const decision = decideEligibility(
      input({
        grant: { amountMin: 500_000, currency: "CAD" },
        client: { annualBudget: 200_000 },
      }),
    );
    const rule = check(decision, "scale");
    expect(rule.status).toBe("fail");
    expect(rule.detail).toContain("stretch");
    expect(rule.detail).not.toContain("likely beyond");
  });

  it("flags an award too small to be worth the application effort, without failing it", () => {
    const decision = decideEligibility(
      input({
        grant: { amountMin: 1_000, amountMax: 3_000, currency: "CAD" },
        client: { annualBudget: 1_000_000 },
      }),
    );
    const rule = check(decision, "scale");
    expect(rule.status).toBe("pass");
    expect(rule.detail).toContain("under 2%");
  });

  it("says nothing is wrong for an award that is neither a stretch nor too small", () => {
    const decision = decideEligibility(
      input({
        grant: { amountMin: 50_000, amountMax: 100_000, currency: "CAD" },
        client: { annualBudget: 400_000 },
      }),
    );
    const rule = check(decision, "scale");
    expect(rule.status).toBe("pass");
    expect(rule.detail).toBe("Award size fits an organization of this client's scale.");
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
        grant: {
          eligibleApplicantTypes: ["nonprofit"],
          amountMin: 50_000,
          // Stated, so the cost-share check has something to decide. Left out,
          // it reports "the call does not say" — honest, but then not
          // *everything* checkable was checked.
          eligibilityNote: "This program funds 100% of eligible costs.",
        },
        client: { stage: "nonprofit", annualBudget: 400_000 },
      }),
    );
    expect(decision.verdict).toBe("eligible");
    expect(decision.headline).toBe("Meets every published requirement.");
  });

  it("admits what it could not check rather than implying it checked everything", () => {
    // Most funders say nothing about a cost share, and silence is not "no
    // contribution required". A consultant told "meets everything" who then
    // finds a 30% match stops trusting every other verdict too.
    const decision = decideEligibility(
      input({
        grant: { eligibleApplicantTypes: ["nonprofit"], amountMin: 50_000 },
        client: { stage: "nonprofit", annualBudget: 400_000 },
      }),
    );
    expect(decision.verdict).toBe("eligible");
    expect(decision.headline).toMatch(/we can check/);
  });
});

describe("cost share", () => {
  it("reads the applicant's share when the funder states its own", () => {
    // "covers up to 75%" means the applicant finds the other 25%.
    expect(detectCostSharePercent("This program covers up to 75% of eligible costs.")).toBe(25);
    expect(detectCostSharePercent("Projects are funded at 60% of total cost.")).toBe(40);
  });

  it("reads the applicant's share when it is stated directly", () => {
    expect(detectCostSharePercent("A 25% cost share is required.")).toBe(25);
    expect(detectCostSharePercent("Applicants must provide a 20% match.")).toBe(20);
  });

  it("says nothing when the call says nothing", () => {
    expect(detectCostSharePercent("Applications are reviewed quarterly.")).toBeNull();
    expect(detectCostSharePercent(null)).toBeNull();
  });

  it("flags a required contribution without ruling the call out", () => {
    // Whether the organisation can carry 30% is a finance decision, and
    // nothing in this system is entitled to make it for them.
    const decision = decideEligibility(
      input({ grant: { eligibilityNote: "The funder covers up to 70% of project costs." } }),
    );
    const rule = decision.checks.find((c) => c.key === "cost_share");
    expect(rule?.status).toBe("fail");
    expect(rule?.isHardGate).toBe(false);
    expect(rule?.detail).toContain("30%");
    expect(decision.verdict).toBe("eligible");
  });
});

describe("runway", () => {
  it("says there is no time when the deadline is inside the lead time", () => {
    // Open and undeliverable are different things, and calling the second one
    // "eligible" wastes exactly the week the consultant does not have.
    const decision = decideEligibility(
      input({ grant: { deadline: "2026-08-20" }, client: { leadTimeWeeks: 3 } }),
    );
    const rule = decision.checks.find((c) => c.key === "runway");
    expect(rule?.status).toBe("fail");
    expect(rule?.detail).toContain("3 weeks");
  });

  it("leaves the verdict alone, because a rushed application is their call", () => {
    const decision = decideEligibility(
      input({ grant: { deadline: "2026-08-20" }, client: { leadTimeWeeks: 3 } }),
    );
    expect(decision.verdict).toBe("eligible");
    expect(decision.checks.find((c) => c.key === "runway")?.isHardGate).toBe(false);
  });

  it("passes a call with real time left", () => {
    expect(
      decideEligibility(input({ grant: { deadline: "2026-12-01" } })).checks.find(
        (c) => c.key === "runway",
      )?.status,
    ).toBe("pass");
  });

  it("has no deadline to race when the funder publishes none", () => {
    expect(
      decideEligibility(input({ grant: { deadline: null } })).checks.find((c) => c.key === "runway")
        ?.status,
    ).toBe("pass");
  });
});

describe("role and the funded-partner pathway", () => {
  const municipalOnly = { eligibleApplicantTypes: ["government"] };

  it("rules a nonprofit out of a municipal-only call when it has no partner pathway", () => {
    const decision = decideEligibility(input({ grant: municipalOnly }));
    expect(decision.verdict).toBe("ineligible");
    expect(check(decision, "role").status).toBe("fail");
  });

  it("turns that call into a partner question when the client works as a funded partner", () => {
    const decision = decideEligibility(
      input({ grant: municipalOnly, client: { fundedPartnerPathway: true } }),
    );
    expect(decision.verdict).toBe("needs_input");
    expect(check(decision, "applicant_type").status).toBe("unknown");
    expect(check(decision, "role").detail).toMatch(/Funded partner/);
  });

  it("names the lead as the one carrying the cost share in a partner role", () => {
    const decision = decideEligibility(
      input({
        grant: { ...municipalOnly, eligibilityNote: "Covers 80% of eligible costs." },
        client: { fundedPartnerPathway: true },
      }),
    );
    expect(check(decision, "cost_share").detail).toMatch(
      /lead applicant is expected to carry about 20%/,
    );
  });

  it("reports the lead role when the client's own legal form is invited", () => {
    const decision = decideEligibility(input({ grant: { eligibleApplicantTypes: ["nonprofit"] } }));
    expect(check(decision, "role").status).toBe("pass");
    expect(check(decision, "role").detail).toMatch(/lead applicant/);
  });

  it("needs eight weeks by default when a partner must apply as lead", () => {
    // 2026-09-20 is 35 days out: enough as lead (4 weeks), not as partner.
    const asLead = decideEligibility(
      input({
        grant: { deadline: "2026-09-20", eligibleApplicantTypes: ["nonprofit"] },
        client: { leadTimeWeeks: 4 },
      }),
    );
    expect(check(asLead, "runway").status).toBe("pass");

    const asPartner = decideEligibility(
      input({
        grant: { deadline: "2026-09-20", ...municipalOnly },
        client: { leadTimeWeeks: 4, fundedPartnerPathway: true },
      }),
    );
    expect(check(asPartner, "runway").status).toBe("fail");
    expect(check(asPartner, "runway").detail).toContain("8 weeks");
  });
});

describe("in-kind cap", () => {
  it("reads a cap on how much of the match may be in kind", () => {
    expect(detectInKindCapPercent("In-kind contributions may cover up to 50% of the match.")).toBe(
      50,
    );
    expect(detectInKindCapPercent("Matching funds are required.")).toBeNull();
  });

  it("states the cap and insists the cash match be confirmed", () => {
    const decision = decideEligibility(
      input({
        grant: {
          eligibilityNote:
            "A 50% match is required. In-kind contributions may cover no more than 50% of the match.",
        },
      }),
    );
    const detail = check(decision, "cost_share").detail;
    expect(detail).toContain("50%");
    expect(detail).toMatch(/at most 50%/);
    expect(detail).toMatch(/never assume/);
  });
});

describe("strategic fit", () => {
  it("is unknown, never a fail, when the client lists no capability domains", () => {
    const decision = decideEligibility(input({}));
    expect(check(decision, "strategic_fit").status).toBe("unknown");
    expect(check(decision, "strategic_fit").isHardGate).toBe(false);
  });

  it("names the capability domain the funder's own text mentions", () => {
    const decision = decideEligibility(
      input({
        grant: { title: "Smart Cities Challenge", summary: "Connected infrastructure pilots." },
        client: { capabilityDomains: ["smart cities", "micro-credentials"] },
      }),
    );
    expect(check(decision, "strategic_fit").status).toBe("pass");
    expect(check(decision, "strategic_fit").detail).toContain("smart cities");
  });

  it("asks for a fit decision instead of ruling out a call that names no domain", () => {
    const decision = decideEligibility(
      input({
        grant: { title: "Bridge deck repair", summary: "Structural repairs." },
        client: { capabilityDomains: ["smart cities"] },
      }),
    );
    expect(check(decision, "strategic_fit").status).toBe("unknown");
    expect(decision.verdict).toBe("eligible");
  });
});
