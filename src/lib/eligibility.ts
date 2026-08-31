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
    /** The funder's own prose, where a cost share is usually stated. */
    eligibilityNote?: string | null;
    summary?: string | null;
  };
  client: {
    jurisdictions?: readonly string[] | null;
    stage?: string | null;
    annualBudget?: number | null;
    currency?: string | null;
    /**
     * Working weeks this consultant needs to put a credible application
     * together. A call that is technically open and closes on Friday is not
     * an opportunity, and the predecessor learned this the expensive way.
     */
    leadTimeWeeks?: number | null;
  };
  /** Injected so the verdict is reproducible in tests and in the past. */
  today: Date;
};

/** Multilateral funders are not bound to one country's applicants. */
const BORDERLESS = new Set(["INTL", "GLOBAL", "WORLD"]);

/**
 * "Foreign entities are eligible to apply" — read from the funder's own text,
 * never guessed from the absence of a restriction.
 *
 * The country field we store is the funder's country, not a nationality
 * restriction, and the two get conflated for exactly one source today: a
 * US federal call is stored as `country: "US"` whether or not its actual
 * synopsis restricts applicants to US entities — many explicitly do not. A
 * consultant serving a Canadian client never sees that distinction, and the
 * jurisdiction rule would hard-fail every one of those calls the same way it
 * fails a genuinely domestic one.
 *
 * Getting this wrong in either direction is costly, so the bar is deliberately
 * narrow: only the canonical, unambiguous phrasing federal synopses actually
 * use, and never when a negation ("not eligible", "except foreign entities")
 * sits nearby. A hit downgrades a hard fail to a question, never straight to
 * a pass — the funder's own words are quoted so the consultant can judge it
 * in ten seconds instead of rereading the full synopsis themselves.
 */
export function statesForeignEligibility(text: string | null | undefined): boolean {
  if (!text) return false;
  const hay = text.toLowerCase();

  const subject =
    "(foreign|international|non-u\\.s\\.|non-united states|outside the united states)";
  const negated = new RegExp(
    `\\b(not eligible|ineligible|except|excluding|only|restricted to)\\b.{0,40}${subject}` +
      `|${subject}.{0,40}\\b(not eligible|ineligible|are not|is not|may not)\\b`,
  ).test(hay);
  if (negated) return false;

  const affirms = new RegExp(
    `${subject}.{0,60}\\b(are eligible|is eligible|may apply|entities are eligible|` +
      `organi[sz]ations are eligible|applicants? (?:are|is) eligible)\\b`,
  );
  return affirms.test(hay);
}

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
  if (statesForeignEligibility(input.grant.eligibilityNote)) {
    return {
      key: "jurisdiction",
      status: "unknown",
      isHardGate: true,
      detail:
        `Based in ${grantCountry}, but its own terms say foreign applicants are eligible — ` +
        `confirm this client qualifies before drafting.`,
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
  const { amountMin, amountMax, currency } = input.grant;
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
  const ratio = amountMin / budget;

  // Two bands, not one. The predecessor's own tooling found the line between
  // "a stretch" and "likely can't co-fund or administer this at all" sits
  // well past double the budget — a single "> 2x" cutoff called both the same
  // thing, which buried the more useful warning inside the more common one.
  if (ratio > 5) {
    return {
      key: "scale",
      status: "fail",
      isHardGate: false,
      detail:
        `The smallest award here (${unit} ${amountMin.toLocaleString()}) is ` +
        `${ratio.toFixed(1)}x this client's annual budget — likely beyond what it can manage or ` +
        `co-fund, not just a stretch.`,
    };
  }
  if (ratio > 2) {
    return {
      key: "scale",
      status: "fail",
      isHardGate: false,
      detail: `The smallest award here (${unit} ${amountMin.toLocaleString()}) is more than twice this client's annual budget — winnable, but a stretch.`,
    };
  }

  // The opposite failure mode: an award small enough that the application
  // effort may not be worth it. Judged against the ceiling, not the floor —
  // the floor already cleared the stretch check above, so what is left to
  // ask is whether the best case is still a small ask.
  const ceiling = amountMax ?? amountMin;
  if (ceiling < budget * 0.02) {
    return {
      key: "scale",
      status: "pass",
      isHardGate: false,
      detail:
        `Award size fits an organization of this client's scale, though the most it pays ` +
        `(${unit} ${ceiling.toLocaleString()}) is under 2% of annual budget — weigh the ` +
        `application effort against it.`,
    };
  }
  return {
    key: "scale",
    status: "pass",
    isHardGate: false,
    detail: `Award size fits an organization of this client's scale.`,
  };
}

/**
 * A funder asking the applicant to carry part of the cost, read from their own
 * words.
 *
 * Carried over from the predecessor, where it earned its place: a call that
 * funds 60% is a call that asks the organisation to find the other 40%, and a
 * consultant who discovers that after drafting has lost the week. It is stated
 * in prose rather than in a field, so it is read from prose.
 *
 * Never a hard gate. Whether the organisation can carry a share is a finance
 * decision nobody in this system is entitled to make for them.
 */
export function detectCostSharePercent(text: string | null | undefined): number | null {
  if (!text) return null;
  const hay = text.toLowerCase();

  // "covers up to 75%" / "80% funding" — the funder states its own share.
  const funderCovers =
    /\b(?:covers?|covering|funds|funded at|up to|reimburses)\s+(\d{1,3})\s*%/.exec(hay) ??
    /\b(\d{1,3})\s*%\s*(?:funding|grant|of eligible costs)\b/.exec(hay);
  if (funderCovers?.[1]) {
    const share = Number(funderCovers[1]);
    if (share >= 0 && share <= 100) return 100 - share;
  }

  // "25% cost share" / "20% match required" — the applicant's share, directly.
  const applicantCarries =
    /\b(\d{1,3})\s*%\s*(?:cost[- ]?share|match|matching|contribution)\b/.exec(hay);
  if (applicantCarries?.[1]) {
    const share = Number(applicantCarries[1]);
    if (share >= 0 && share <= 100) return share;
  }

  return null;
}

function costShareRule(input: EligibilityInput): RuleResult {
  const text = [input.grant.eligibilityNote, input.grant.summary].filter(Boolean).join(" ");
  const share = detectCostSharePercent(text);

  if (share === null) {
    return {
      key: "cost_share",
      status: "unknown",
      isHardGate: false,
      detail: "This call does not say whether the applicant must contribute anything.",
    };
  }
  if (share === 0) {
    return {
      key: "cost_share",
      status: "pass",
      isHardGate: false,
      detail: "The funder covers the full cost.",
    };
  }
  return {
    key: "cost_share",
    status: "fail",
    isHardGate: false,
    detail: `The applicant is expected to carry about ${share}% of the cost. Confirm that before drafting.`,
  };
}

/**
 * Is there time to write this?
 *
 * The deadline rule answers whether the call is open. This answers a different
 * question the predecessor treated as separate and this system had lost: an
 * application that closes in four days is open and undeliverable, and telling a
 * consultant it is "eligible" wastes exactly the week they do not have.
 *
 * Soft, because it is their judgement — they may already have most of it
 * written, or may decide a rushed application is worth filing.
 */
const DEFAULT_LEAD_TIME_WEEKS = 3;

function runwayRule(input: EligibilityInput): RuleResult {
  const weeks = input.client.leadTimeWeeks ?? DEFAULT_LEAD_TIME_WEEKS;

  if (!input.grant.deadline) {
    return {
      key: "runway",
      status: "pass",
      isHardGate: false,
      detail: "No closing date, so there is no deadline to race.",
    };
  }
  const closes = new Date(`${input.grant.deadline}T23:59:59Z`);
  if (Number.isNaN(closes.getTime())) {
    return {
      key: "runway",
      status: "unknown",
      isHardGate: false,
      detail: "We could not read the closing date, so we cannot say whether there is time.",
    };
  }

  const days = Math.ceil((closes.getTime() - input.today.getTime()) / 86_400_000);
  if (days < 0) {
    return { key: "runway", status: "fail", isHardGate: false, detail: "This call has closed." };
  }
  const needed = weeks * 7;
  if (days < needed) {
    return {
      key: "runway",
      status: "fail",
      isHardGate: false,
      detail: `${days} day${days === 1 ? "" : "s"} left, against the ${weeks} weeks this client usually needs. Winnable only if much of it is already written.`,
    };
  }
  return {
    key: "runway",
    status: "pass",
    isHardGate: false,
    detail: `${Math.floor(days / 7)} weeks to the deadline.`,
  };
}

const RULES = [
  jurisdictionRule,
  deadlineRule,
  applicantTypeRule,
  scaleRule,
  costShareRule,
  runwayRule,
];

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
