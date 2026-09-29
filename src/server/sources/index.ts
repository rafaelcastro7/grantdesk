import type { SourceAdapter } from "./types";
import { grantsGov } from "./grants-gov";
import { businessBenefitsFinder } from "./business-benefits-finder";
import { craFoundations } from "./cra-foundations";
import { ontarioTpon } from "./ontario-tpon";
import { otf } from "./otf";
import { esdc } from "./esdc";
import { canadaCouncil } from "./canada-council";

/**
 * Every source the catalog draws on, and nothing else.
 *
 * Markets absent from this list have no automatic ingestion, and coverage.ts
 * will say exactly that rather than letting the UI imply otherwise. Adding a
 * funder by hand without a source behind it is how the predecessor ended up
 * advertising 699 funders that search could not reach.
 */
export const SOURCES: readonly SourceAdapter[] = [
  grantsGov,
  businessBenefitsFinder,
  craFoundations,
  ontarioTpon,
  otf,
  esdc,
  canadaCouncil,
];

export function sourceByKey(key: string): SourceAdapter | undefined {
  return SOURCES.find((source) => source.key === key);
}

export type { SourceAdapter, SourceGrant } from "./types";
