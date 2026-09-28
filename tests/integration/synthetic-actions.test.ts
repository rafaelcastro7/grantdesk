import { describe, expect, it } from "vitest";
import { resolveTenantSlug, getTenantBranding } from "@/lib/tenant";
import { assessProfile } from "@/lib/profile-completeness";
import { assessSubmission } from "@/lib/submit-gate";
import { fabrications } from "@/lib/fabrication";
import { decideEligibility } from "@/lib/eligibility";

describe("synthetic actions & deterministic automation", () => {
  it("determines tenant context from subdomain or host without ambiguity", () => {
    expect(resolveTenantSlug({ hostname: "iial.grantdesk.app" })).toBe("iial");
    expect(resolveTenantSlug({ hostname: "iial.localhost:5180" })).toBe("iial");
    expect(resolveTenantSlug({ hostname: "acme.grantdesk.app" })).toBe("acme");
    expect(resolveTenantSlug({ searchParams: new URLSearchParams("tenant=iial") })).toBe("iial");

    const branding = getTenantBranding("iial");
    expect(branding.name).toBe("Institute of Innovation and Advanced Learning");
    expect(branding.accentColor).toBe("#0284c7");
  });

  it("calculates profile completeness deterministically with exact next gap", () => {
    const emptyProfile = {
      sectors: [],
      jurisdictions: [],
      stage: null,
      annualBudget: null,
      capabilities: null,
      beneficiaries: null,
      leadTimeWeeks: null,
    };
    const emptyAssessment = assessProfile(emptyProfile);
    expect(emptyAssessment.canMatch).toBe(false);
    expect(emptyAssessment.score).toBeLessThan(100);
    expect(emptyAssessment.missing.some((m) => m.key === "sectors")).toBe(true);

    const completeProfile = {
      sectors: ["technology", "education"],
      jurisdictions: ["CA", "CA-ON"],
      stage: "nonprofit",
      annualBudget: 500000,
      capabilities: "AI research and workforce training",
      beneficiaries: "Post-secondary students and researchers",
      leadTimeWeeks: 4,
    };
    const fullAssessment = assessProfile(completeProfile);
    expect(fullAssessment.canMatch).toBe(true);
    expect(fullAssessment.score).toBe(100);
    expect(fullAssessment.missing).toHaveLength(0);
  });

  it("evaluates eligibility rules deterministically without hallucinations", () => {
    const grant = {
      country: "CA",
      amountMin: 10000,
      amountMax: 50000,
      deadline: "2026-12-31",
      status: "open",
    };
    const client = {
      jurisdictions: ["CA"],
      stage: "nonprofit",
      annualBudget: 250000,
      leadTimeWeeks: 4,
    };
    const result = decideEligibility({ grant, client, today: new Date("2026-09-20") });
    expect(["eligible", "ineligible", "needs_input"]).toContain(result.verdict);
    expect(result.checks.length).toBeGreaterThanOrEqual(4);
  });

  it("runs anti-fabrication scanner deterministically on proposal content", () => {
    const groundedText = "We request $50,000 to train 200 participants across 3 cohorts.";
    const sourceFacts = ["Program budget: $50,000.", "Target: 200 participants in 3 cohorts."];
    const cleanCheck = fabrications(groundedText, sourceFacts);
    expect(cleanCheck).toHaveLength(0);

    const hallucinatedText =
      "We served 15,420 beneficiaries and won $4,200,000 in previous federal funding.";
    const restrictedFacts = ["Our organization was founded in 2024 with a seed budget of $10,000."];
    const flagged = fabrications(hallucinatedText, restrictedFacts);
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.some((f) => f.kind === "number")).toBe(true);
  });

  it("strictly enforces submission gate checklist and prevents premature submits", () => {
    const unreadyCandidate = {
      verdict: "eligible" as const,
      verdictAt: "2026-09-01T00:00:00Z",
      profileUpdatedAt: "2026-09-01T00:00:00Z",
      deadline: "2026-12-31",
      sections: [{ label: "Project Summary", content: null, wordLimit: 500, wordCount: null }],
      conditions: [{ label: "Audit Statement", isCritical: true, acknowledged: false }],
      humanReviewed: false,
      alreadySubmitted: false,
      today: new Date("2026-09-20"),
    };
    const check1 = assessSubmission(unreadyCandidate);
    expect(check1.canSubmit).toBe(false);
    expect(check1.blockers.some((b) => b.key === "empty_sections")).toBe(true);
    expect(check1.blockers.some((b) => b.key === "unmet_conditions")).toBe(true);
    expect(check1.blockers.some((b) => b.key === "not_reviewed")).toBe(true);

    const readyCandidate = {
      ...unreadyCandidate,
      sections: [
        { label: "Project Summary", content: "Valid proposal text.", wordLimit: 500, wordCount: 3 },
      ],
      conditions: [{ label: "Audit Statement", isCritical: true, acknowledged: true }],
      humanReviewed: true,
    };
    const check2 = assessSubmission(readyCandidate);
    expect(check2.canSubmit).toBe(true);
    expect(check2.blockers).toHaveLength(0);
  });
});
