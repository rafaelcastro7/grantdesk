import { z } from "zod";
import { htmlToText, htmlTitle } from "@/lib/html-text";
import { callLlm } from "./llm";
import { readTextCapped, safeFetch } from "./safe-fetch";
import { UNTRUSTED_RULE, untrusted } from "./prompt-safety";
import type { ProfileFields } from "@/lib/profile-completeness";
import {
  normalizeBudget,
  normalizeJurisdictions,
  normalizeProse,
  normalizeSectors,
  normalizeStage,
  type Stage,
} from "@/lib/normalize-profile";

/**
 * Turn a public page into a client profile good enough to match against.
 *
 * This is the riskiest assumption in the product: a consultant with eight
 * clients will not hand-fill eight profiles, and matching quality is exactly
 * as good as the profile behind it. Phase 1 exists to prove or disprove that
 * this can be done in minutes from material the consultant already has.
 *
 * Every field carries where it came from. A profile that cannot say why it
 * claims "Ontario" is one a consultant cannot trust or correct.
 */

/**
 * Deliberately permissive at the boundary, canonical after it.
 *
 * The first version of this schema demanded ISO codes, a fixed stage enum and
 * prose strings — and every provider failed it on real pages, because they
 * reasonably answered `["Canada","North America"]`, `"seed-stage"` and a list
 * of capabilities. Rejecting a good reading of the page because of its shape
 * is a defect in the schema, not the model, so shape is normalized rather than
 * enforced (see normalize-profile.ts, which is where the real rules live).
 */
export const ExtractedProfileSchema = z.object({
  sectors: z.unknown().optional(),
  jurisdictions: z.unknown().optional(),
  stage: z.unknown().optional(),
  annualBudget: z.unknown().optional(),
  currency: z.string().nullable().optional(),
  capabilities: z.unknown().optional(),
  beneficiaries: z.unknown().optional(),
  confidence: z.coerce.number().min(0).max(1).default(0.5),
});

export type ExtractionResult = {
  profile: ProfileFields & NormalizedProfile;
  provenance: { source: string; title: string | null; extractedAt: string; model: string };
};

const SYSTEM = `You read an organization's own web page and record what it says about itself.

Rules:
- Only record what the page states or plainly implies. Never infer a budget from
  the size of the building or the tone of the copy.
- jurisdictions: ISO-like codes for where the organization OPERATES — country
  codes plus subnational where stated, e.g. ["CA","ON"] or ["US","US-CA"].
- sectors: short lowercase slugs, e.g. ["technology","clean-tech","education"].
- If the page does not say, leave the field empty or null. An empty field is
  correct; an invented one is a defect.
- confidence reflects how much of this the page actually supported.

Reply with a single JSON object and nothing else.

${UNTRUSTED_RULE}`;

function buildUserPrompt(text: string, sourceUrl: string, title: string | null): string {
  return [
    `Source: ${sourceUrl}`,
    title ? `Page title: ${title}` : null,
    "",
    "Page text:",
    untrusted(sourceUrl, text),
    "",
    'Return: {"sectors":[],"jurisdictions":[],"stage":"","annualBudget":null,"currency":null,"capabilities":null,"beneficiaries":null,"confidence":0}',
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export type NormalizedProfile = {
  sectors: string[];
  jurisdictions: string[];
  stage: Stage;
  annualBudget: number | null;
  currency: string | null;
  capabilities: string | null;
  beneficiaries: string | null;
  confidence: number;
};

/** Strips the code fence some models add despite being told not to. */
export function parseExtraction(raw: string): NormalizedProfile {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const loose = ExtractedProfileSchema.parse(JSON.parse(cleaned));

  return {
    sectors: normalizeSectors(loose.sectors),
    jurisdictions: normalizeJurisdictions(loose.jurisdictions),
    stage: normalizeStage(loose.stage),
    annualBudget: normalizeBudget(loose.annualBudget),
    currency: typeof loose.currency === "string" ? loose.currency.toUpperCase().slice(0, 3) : null,
    capabilities: normalizeProse(loose.capabilities, 1200),
    beneficiaries: normalizeProse(loose.beneficiaries, 600),
    confidence: loose.confidence,
  };
}

export async function extractProfileFromHtml(
  html: string,
  sourceUrl: string,
): Promise<ExtractionResult> {
  const text = htmlToText(html);
  if (text.length < 120) {
    throw new Error(
      `not enough readable text at ${sourceUrl} (${text.length} chars) — the page may be script-rendered`,
    );
  }
  const title = htmlTitle(html);

  const response = await callLlm({
    role: "extract",
    json: true,
    temperature: 0.1,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: buildUserPrompt(text, sourceUrl, title) },
    ],
    // Schema validity is not answer quality, but it is the floor: a provider
    // that returns unparseable output should hand off rather than be retried.
    validate: (candidate) => {
      try {
        parseExtraction(candidate);
        return true;
      } catch {
        return false;
      }
    },
  });

  const parsed = parseExtraction(response.text);

  return {
    profile: parsed,
    provenance: {
      source: sourceUrl,
      title,
      extractedAt: new Date().toISOString(),
      model: `${response.provider}/${response.model}`,
    },
  };
}

export async function extractProfileFromUrl(sourceUrl: string): Promise<ExtractionResult> {
  const response = await safeFetch(sourceUrl, {
    headers: { "User-Agent": "IIAL-GrantDesk/1.0 (+https://iial.ca; reads public pages)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`fetch ${sourceUrl} returned HTTP ${response.status}`);
  return extractProfileFromHtml(await readTextCapped(response), sourceUrl);
}
