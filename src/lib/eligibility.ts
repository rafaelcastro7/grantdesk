import { fromClientStage, listApplicantTypes, type ApplicantType } from "./applicant-types";

/**
 * Eligibility is decided by rules, never by a model.
 *
 * A model may later *explain* a verdict, but it may not produce one. Two
 * reasons: a consultant staking a client relationship on "you can apply for
 * this" needs the same answer every time they load the page, and a wrong
 * verdict has to be traceable to a rule someone can read and fix.
 *
 * Every rule returns one of three answers, and the third one is the point of
 * the design. "Unknown" means the funder did not publish enough to decide.
 * Folding that into a pass would claim verification we did not do; folding it
 * into a fail would invent a restriction the funder never stated. So it stays
 * a third answer, and it is what separates a verified match from a plausible
 * one.
 */

export type RuleStatus = "pass" | "fail" | "unknown";

export type RuleResult = {
  key: string;
  status: RuleStatus;
  /**
   * A hard gate decides the verdict. A soft check is shown to the consultant
   * and never rules anything out — funders do not forbid a small charity from
   * applying to a large call, they just rarely fund one.
   */
  isHardGate: boolean;
  /** One sentence, addressed to the consultant, stating the actual finding. */
  detail: string;
};

export type Verdict = "eligible" | "ineligible" | "needs_input";

export type EligibilityInput = {
  grant: {
    country: string;
    deadline?: string | null;
    status?: string | null;
    eligibleApplicantTypes?: readonly string[] | null;
    amountMin?: number | null;
    amountMax?: number | null;
    currency?: string | null;
  };
  client: {
    jurisdictions?: readonly string[] | null;
    stage?: string | null;
    annualBudget?: number | null;
    currency?: string | null;
  };
  /** Injected so the verdict is reproducible in tests and in the past. */
  today: Date;
};

/** Multilateral funders are not bound to one country's applicants. */
const BORDERLESS = new Set(["INTL", "GLOBAL", "WORLD"]);

function jurisdictionRule(input: EligibilityInput): RuleResult {
  const grantCountry = input.grant.country?.trim().toUpperCase() ?? "";
  const clientPlaces = (input.client.jurisdictions ?? []).map((j) => j.trim().toUpperCase());

  if (BORDERLESS.has(grantCountry)) {
    return {
      key: "jurisdiction",
      status: "pass",
      isHardGate: true,
      detail: "This funder is multilateral and does not restrict applicants to one country.",
    };
  }
  if (clientPlaces.length === 0) {
    return {
      key: "jurisdiction",
      status: "unknown",
      isHardGate: true,
      detail: "We do not know where this client operates, so we cannot check where it may apply.",
    };
  }
  // A client operating in a province also operates in its country: "ON" and
  // "CA-ON" both satisfy a grant open to Canada.
  const countries = new Set(clientPlaces.map((place) => place.split("-")[0]));
  if (countries.has(grantCountry)) {
    return {
      key: "jurisdiction",
      status: "pass",
      isHardGate: true,
      detail: `Open to applicants in ${grantCountry}, where this client operates.`,
    };
  }
  return {
    key: "jurisdiction",
    status: "fail",
    isHardGate: true,
    detail: `Restricted to ${grantCountry}; this client operates in ${clientPlaces.join(", ")}.`,
  };
}

function deadlineRule(input: EligibilityInput): RuleResult {
  const { deadline, status } = input.grant;
  if (status && status !== "open") {
    return {
      key: "deadline",
      status: "fail",
      isHardGate: true,
      detail: `This call is ${status}, so it is no longer accepting applications.`,
    };
  }
  if (!deadline) {
    return {
      key: "deadline",
      status: "pass",
      isHardGate: true,
      detail: "No closing date published — this funder accepts applications continuously.",
    };
  }
  const closes = new Date(`${deadline}T23:59:59Z`);
  if (Number.isNaN(closes.getTime())) {
    return {
      key: "deadline",
      status: "unknown",
      isHardGate: true,
      detail: `We could not read the published closing date (${deadline}).`,
    };
  }
  if (closes.getTime() < input.today.getTime()) {
    return {
      key: "deadline",
      status: "fail",
      isHardGate: true,
      detail: `Closed on ${deadline}.`,
    };
  }
  const days = Math.ceil((closes.getTime() - input.today.getTime()) / 86_400_000);
  return {
    key: "deadline",
    status: "pass",
    isHardGate: true,
    detail: days <= 14 ? `Closes on ${deadline} — ${days} days left.` : `Closes on ${deadline}.`,
  };
}

function applicantTypeRule(input: EligibilityInput): RuleResult {
  const declared = (input.grant.eligibleApplicantTypes ?? []).filter(Boolean) as ApplicantType[];
  const clientTypes = fromClientStage(input.client.stage);

  // The funder published no machine-readable applicant list. That is not a
  // restriction, so it cannot fail — but it is also not a check we performed,
  // so it does not gate the verdict either. It is reported as unverified.
  if (declared.length === 0) {
    return {
      key: "applicant_type",
      status: "unknown",
      isHardGate: false,
      detail: "This funder does not publish a machine-readable applicant list — read their terms.",
    };
  }
  if (clientTypes.length === 0) {
    return {
      key: "applicant_type",
      status: "unknown",
      isHardGate: true,
      detail: `Open to ${listApplicantTypes(declared)}. We do not know this client's legal form.`,
    };
  }
  const overlap = clientTypes.filter((type) => declared.includes(type));
  if (overlap.length > 0) {
    return {
      key: "applicant_type",
      status: "pass",
      isHardGate: true,
      detail: `Open to ${listApplicantTypes(overlap)}, which is what this client is.`,
    };
  }
  return {
    key: "applicant_type",
    status: "fail",
    isHardGate: true,
    detail: `Open to ${listApplicantTypes(declared)} only; this client is ${listApplicantTypes(clientTypes)}.`,
  };
}

/**
 * Soft, and deliberately so. A funder whose smallest award dwarfs the client's
 * whole annual budget is a poor use of a week, but it is a judgement about
 * odds, not a rule about permission — plenty of small organizations win large
 * awards. Saying "ineligible" here would hide real opportunities.
 */
function scaleRule(input: EligibilityInput): RuleResult {
  const { amountMin, currency } = input.grant;
  const budget = input.client.annualBudget;
  if (!amountMin || !budget) {
    return {
      key: "scale",
      status: "unknown",
      isHardGate: false,
      detail: "Not enough figures published to compare this award against the client's budget.",
    };
  }
  const unit = currency ?? input.client.currency ?? "";
  if (amountMin > budget * 2) {
    return {
      key: "scale",
      status: "fail",
      isHardGate: false,
      detail: `The smallest award here (${unit} ${amountMin.toLocaleString()}) is more than twice this client's annual budget — winnable, but a stretch.`,
    };
  }
  return {
    key: "scale",
    status: "pass",
    isHardGate: false,
    detail: `Award size fits an organization of this client's scale.`,
  };
}

const RULES = [jurisdictionRule, deadlineRule, applicantTypeRule, scaleRule];

export type EligibilityDecision = {
  verdict: Verdict;
  checks: RuleResult[];
  /** The single sentence that explains the verdict, for the results list. */
  headline: string;
};

export function decideEligibility(input: EligibilityInput): EligibilityDecision {
  const checks = RULES.map((rule) => rule(input));
  const gates = checks.filter((c) => c.isHardGate);

  const failed = gates.find((c) => c.status === "fail");
  if (failed) return { verdict: "ineligible", checks, headline: failed.detail };

  const undecided = gates.find((c) => c.status === "unknown");
  if (undecided) return { verdict: "needs_input", checks, headline: undecided.detail };

  // Eligible, but say what we could not verify rather than implying we checked
  // everything. A consultant who is told "eligible" and later finds an
  // unpublished restriction stops trusting every other verdict too.
  const unverified = checks.find((c) => !c.isHardGate && c.status === "unknown");
  const headline = unverified
    ? `Meets every published requirement we can check. ${unverified.detail}`
    : "Meets every published requirement.";
  return { verdict: "eligible", checks, headline };
}
