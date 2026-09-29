import {
  fromClientStage,
  listApplicantTypes,
  placeName,
  type ApplicantType,
} from "./applicant-types";
import { matchedTerms } from "./match-explain";
import { daysUntilDeadline, deadlineEnd } from "./deadline";

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
    title?: string | null;
    country: string;
    /** The funder's own jurisdiction, e.g. "CA-SK" for a Saskatchewan ministry. */
    region?: string | null;
    deadline?: string | null;
    status?: string | null;
    /** A forecast's estimated application date; never read as a deadline. */
    estimatedDeadline?: string | null;
    /** A structured "cost sharing required" flag, where the source has one. */
    costSharingRequired?: boolean | null;
    eligibleApplicantTypes?: readonly string[] | null;
    /** The list also admits "others, see the text": absence is not exclusion. */
    applicantListOpenEnded?: boolean | null;
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
    /**
     * The client can be written into an eligible lead's budget as the paid
     * delivery partner — usually for a municipality. A call closed to the
     * client's own legal form is then a partner question, not a rejection.
     */
    fundedPartnerPathway?: boolean | null;
    /** Weeks needed when a partner must apply as lead; its sign-off is slow. */
    partnerLeadTimeWeeks?: number | null;
    /** The client's capability domains, for the strategic-fit check. */
    capabilityDomains?: readonly string[] | null;
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
  if (affirms.test(hay)) return true;
  // The list form most NIH/federal notices use — no verb, just an entry:
  // "Other Eligible Applicants include … Non-domestic (non-U.S.) Entities
  // (Foreign Organizations)". The negation check above already ran on the
  // same text, so "…(Foreign Organizations) are not eligible" never gets here.
  return /eligible applicants include[^.]{0,400}non-domestic \(non-u\.s\.\) entities/.test(hay);
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
  // A provincial program serves its province. The province is the funder's
  // own jurisdiction (a ministry of Saskatchewan funds Saskatchewan), which
  // is structured data — never read from prose.
  const region = input.grant.region?.trim().toUpperCase() ?? "";
  if (countries.has(grantCountry) && /^CA-[A-Z]{2}$/.test(region)) {
    const provinces = clientPlaces.filter((place) => /^CA-[A-Z]{2}$/.test(place));
    if (provinces.includes(region)) {
      return {
        key: "jurisdiction",
        status: "pass",
        isHardGate: true,
        detail: `A ${placeName(region)} program, where this client operates.`,
      };
    }
    if (provinces.length === 0) {
      return {
        key: "jurisdiction",
        status: "unknown",
        isHardGate: true,
        detail: `A ${placeName(region)} program. This client's profile names no province — add where it operates.`,
      };
    }
    return {
      key: "jurisdiction",
      status: "fail",
      isHardGate: true,
      detail: `A ${placeName(region)} program; this client operates in ${provinces.map(placeName).join(", ")}.`,
    };
  }
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
  // Announced but not open: nobody can apply yet, and "no deadline" here is
  // not rolling intake. Unknown rather than a fail — it is worth watching,
  // not ruling out — with the funder's own estimate when it gave one.
  if (status === "forecasted") {
    const estimate = input.grant.estimatedDeadline;
    const stale = estimate ? daysUntilDeadline(estimate, input.today) < 0 : false;
    return {
      key: "deadline",
      status: "unknown",
      isHardGate: true,
      detail: estimate
        ? stale
          ? `Forecast only — its estimated date (${estimate}) has passed without the call opening. Check the funder before planning on it.`
          : `Forecast only — not accepting applications yet. The funder estimates applications around ${estimate}.`
        : "Forecast only — not accepting applications yet, and the funder has not estimated when.",
    };
  }
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
  const closes = new Date(deadlineEnd(deadline));
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
  const days = daysUntilDeadline(deadline, input.today);
  return {
    key: "deadline",
    status: "pass",
    isHardGate: true,
    detail: days <= 14 ? `Closes on ${deadline} — ${days} days left.` : `Closes on ${deadline}.`,
  };
}

export type ClientRole = "lead" | "funded_partner" | "none" | "unknown";

/** Lead types a client can join as a paid partner when it cannot lead itself. */
const PARTNER_LEADS: readonly ApplicantType[] = ["government"];

/**
 * In what capacity could this client take part at all?
 *
 * Lead when its own legal form is invited; funded partner when only a public
 * body may lead and the client works that way; unknown when either side of the
 * comparison was never published.
 */
export function clientRole(input: EligibilityInput): ClientRole {
  const declared = (input.grant.eligibleApplicantTypes ?? []).filter(Boolean) as ApplicantType[];
  const clientTypes = fromClientStage(input.client.stage);
  if (declared.length === 0 || clientTypes.length === 0) return "unknown";
  if (clientTypes.some((type) => declared.includes(type))) return "lead";
  if (input.client.fundedPartnerPathway && declared.some((t) => PARTNER_LEADS.includes(t))) {
    return "funded_partner";
  }
  return "none";
}

function roleRule(input: EligibilityInput): RuleResult {
  const role = clientRole(input);
  if (role === "lead") {
    return {
      key: "role",
      status: "pass",
      isHardGate: false,
      detail: "This client can apply as the lead applicant.",
    };
  }
  if (role === "funded_partner") {
    return {
      key: "role",
      status: "pass",
      isHardGate: false,
      detail:
        "Funded partner: an eligible public body applies as lead and writes this client into " +
        "the budget as its paid delivery partner.",
    };
  }
  if (role === "none") {
    return {
      key: "role",
      status: "fail",
      isHardGate: false,
      detail:
        "No funded role for this client — only unpaid subcontracting, which needs an explicit " +
        "strategic reason to pursue.",
    };
  }
  return {
    key: "role",
    status: "unknown",
    isHardGate: false,
    detail: "We cannot tell in what role this client could take part until eligibility is known.",
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
  // Grants.gov code 25: the listed types are certain, but the funder also
  // admits others described only in prose. Unlisted is not excluded.
  if (input.grant.applicantListOpenEnded) {
    return {
      key: "applicant_type",
      status: "unknown",
      isHardGate: true,
      detail:
        `Open to ${listApplicantTypes(declared)}, and to others described in the funder's ` +
        `eligibility text — check whether ${listApplicantTypes(clientTypes)} qualifies.`,
    };
  }
  // Still a hard gate, but an open one: whether a lead will take the client on
  // is a conversation, not something the funder's list can settle.
  if (clientRole(input) === "funded_partner") {
    return {
      key: "applicant_type",
      status: "unknown",
      isHardGate: true,
      detail:
        `Open to ${listApplicantTypes(declared)} only — this client can take part as the funded ` +
        `partner of an eligible lead. Confirm a lead partner before drafting.`,
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
  // A USD award against a CAD budget is not a ratio; no rate is stored here, so
  // the honest answer is that we cannot compare them.
  const grantCurrency = currency?.toUpperCase();
  const clientCurrency = input.client.currency?.toUpperCase();
  if (grantCurrency && clientCurrency && grantCurrency !== clientCurrency) {
    return {
      key: "scale",
      status: "unknown",
      isHardGate: false,
      detail: `The award is in ${grantCurrency} and this client's budget in ${clientCurrency}, so size was not compared.`,
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

/**
 * How much of a required match may be in kind, when the funder says so —
 * "in-kind contributions may cover up to 50% of the match". A cash match the
 * client assumed it could meet in staff time is the classic late surprise.
 */
export function detectInKindCapPercent(text: string | null | undefined): number | null {
  if (!text) return null;
  const hay = text.toLowerCase();
  const found =
    /\bin[- ]kind\b[^.%]{0,60}?\b(?:up to|maximum of|max(?:imum)?|no more than|at most|limited to|cannot exceed)\s+(\d{1,3})\s*%/.exec(
      hay,
    ) ??
    /\b(?:up to|maximum of|no more than|at most)\s+(\d{1,3})\s*%[^.]{0,40}?\bin[- ]kind\b/.exec(
      hay,
    );
  if (!found?.[1]) return null;
  const cap = Number(found[1]);
  return cap >= 0 && cap <= 100 ? cap : null;
}

function costShareRule(input: EligibilityInput): RuleResult {
  const text = [input.grant.eligibilityNote, input.grant.summary].filter(Boolean).join(" ");
  const share = detectCostSharePercent(text);
  const inKindCap = detectInKindCapPercent(text);

  if (share === null) {
    // The source's own structured flag, when the prose gives no percentage.
    if (input.grant.costSharingRequired === true) {
      return {
        key: "cost_share",
        status: "fail",
        isHardGate: false,
        detail:
          "The funder marks this call as requiring cost sharing or matching; the share is in the NOFO. " +
          "Confirm with whoever controls the budget that it can be covered — never assume it.",
      };
    }
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
  // Who carries the share depends on the role: as funded partner the lead
  // pays it, which is exactly why the SOP treats that route as a real one.
  const carrier =
    clientRole(input) === "funded_partner" ? "The lead applicant is" : "The applicant is";
  const inKind =
    inKindCap === null ? "" : ` In-kind contributions may cover at most ${inKindCap}% of it.`;
  return {
    key: "cost_share",
    status: "fail",
    isHardGate: false,
    detail:
      `${carrier} expected to carry about ${share}% of the cost.${inKind} ` +
      `Confirm with whoever controls the budget that any cash match can be covered — never assume it.`,
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
/** Municipal sign-off cycles are slow and outside the client's control. */
const DEFAULT_PARTNER_LEAD_TIME_WEEKS = 8;

function runwayRule(input: EligibilityInput): RuleResult {
  const asPartner = clientRole(input) === "funded_partner";
  const weeks = asPartner
    ? (input.client.partnerLeadTimeWeeks ?? DEFAULT_PARTNER_LEAD_TIME_WEEKS)
    : (input.client.leadTimeWeeks ?? DEFAULT_LEAD_TIME_WEEKS);

  if (!input.grant.deadline) {
    return {
      key: "runway",
      status: "pass",
      isHardGate: false,
      detail: "No closing date, so there is no deadline to race.",
    };
  }
  const days = daysUntilDeadline(input.grant.deadline, input.today);
  if (Number.isNaN(days)) {
    return {
      key: "runway",
      status: "unknown",
      isHardGate: false,
      detail: "We could not read the closing date, so we cannot say whether there is time.",
    };
  }

  if (days < 0) {
    return { key: "runway", status: "fail", isHardGate: false, detail: "This call has closed." };
  }
  const needed = weeks * 7;
  if (days < needed) {
    return {
      key: "runway",
      status: "fail",
      isHardGate: false,
      detail: asPartner
        ? `${days} day${days === 1 ? "" : "s"} left, against the ${weeks} weeks needed when a partner must apply and sign off as lead.`
        : `${days} day${days === 1 ? "" : "s"} left, against the ${weeks} weeks this client usually needs. Winnable only if much of it is already written.`,
    };
  }
  return {
    key: "runway",
    status: "pass",
    isHardGate: false,
    detail: `${Math.floor(days / 7)} weeks to the deadline.`,
  };
}

/**
 * Does the funder's own text name any of this client's capability domains?
 *
 * Soft, and it never fails: absence of shared wording is not evidence of a poor
 * fit — meaning-based retrieval already surfaced the call for a reason. It says
 * which domain the funder names, or that fit is the consultant's call to make.
 */
function strategicFitRule(input: EligibilityInput): RuleResult {
  const domains = (input.client.capabilityDomains ?? []).filter(Boolean);
  if (domains.length === 0) {
    return {
      key: "strategic_fit",
      status: "unknown",
      isHardGate: false,
      detail: "This client has no capability domains on its profile, so fit was not checked.",
    };
  }
  const text = [input.grant.title, input.grant.summary, input.grant.eligibilityNote]
    .filter(Boolean)
    .join("\n");
  const hits = matchedTerms(domains, text);
  if (hits.length > 0) {
    return {
      key: "strategic_fit",
      status: "pass",
      isHardGate: false,
      detail: `Maps to this client's capability in ${hits.map((h) => `"${h}"`).join(", ")}.`,
    };
  }
  return {
    key: "strategic_fit",
    status: "unknown",
    isHardGate: false,
    detail:
      "The funder's text names none of this client's capability domains — decide whether it fits " +
      "an existing one before investing in it.",
  };
}

const RULES = [
  jurisdictionRule,
  deadlineRule,
  applicantTypeRule,
  roleRule,
  scaleRule,
  costShareRule,
  runwayRule,
  strategicFitRule,
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
  // Strategic fit is the client's judgement, not a published requirement, so it
  // never stands in for "what we could not verify".
  const unverified = checks.find(
    (c) => !c.isHardGate && c.status === "unknown" && c.key !== "strategic_fit",
  );
  const headline = unverified
    ? `Meets every published requirement we can check. ${unverified.detail}`
    : "Meets every published requirement.";
  return { verdict: "eligible", checks, headline };
}
