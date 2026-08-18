import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Who has won this program before.
 *
 * The incumbent's most-cited gap, and the question a consultant asks first when
 * deciding whether a call is worth a week: does this funder give to
 * organizations like mine, or to hospitals and universities?
 *
 * Answered from USAspending's public award data, keyed on the Assistance
 * Listing (formerly CFDA) number that the call itself carries. Awards are
 * attributed to the *listing* rather than to one opportunity on purpose — a
 * program reissues its call every year, and last year's winners are the useful
 * answer, not the current notice's (empty) award list.
 *
 * US-only, and honestly so. Canada publishes nothing comparable at this
 * granularity, so a Canadian call reports that we do not know rather than
 * showing an empty list that reads like "nobody has ever won this".
 */

const SEARCH_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const SOURCE_KEY = "usaspending";

/** Grants, cooperative agreements, and the other assistance award types. */
const ASSISTANCE_TYPES = ["02", "03", "04", "05"];

export type PastAward = {
  recipientName: string;
  amount: number | null;
  awardedOn: string | null;
  location: string | null;
  externalId: string;
};

type ApiRow = {
  "Recipient Name"?: string;
  "Award Amount"?: number;
  "Start Date"?: string;
  generated_internal_id?: string;
  internal_id?: number;
  "Recipient Location"?: { state_code?: string; city_name?: string };
};

export function normalizeAward(row: ApiRow, listing: string): PastAward | null {
  const recipientName = (row["Recipient Name"] ?? "").trim();
  if (!recipientName) return null;

  const location = row["Recipient Location"];
  const place = [location?.city_name, location?.state_code].filter(Boolean).join(", ");

  return {
    recipientName: recipientName.slice(0, 300),
    amount: typeof row["Award Amount"] === "number" ? row["Award Amount"] : null,
    awardedOn: row["Start Date"] ?? null,
    location: place || null,
    // The award id, not the row id: USAspending's internal_id is not stable
    // across their reloads, and an unstable key would duplicate every refresh.
    externalId: `${listing}:${row.generated_internal_id ?? row.internal_id ?? recipientName}`,
  };
}

export async function fetchPastAwards(listing: string, limit = 25): Promise<PastAward[]> {
  const response = await fetch(SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filters: { award_type_codes: ASSISTANCE_TYPES, program_numbers: [listing] },
      fields: ["Recipient Name", "Award Amount", "Start Date", "Recipient Location"],
      limit,
      sort: "Award Amount",
      order: "desc",
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`usaspending HTTP ${response.status}`);

  const body = (await response.json()) as { results?: ApiRow[] };
  return (body.results ?? [])
    .map((row) => normalizeAward(row, listing))
    .filter((award): award is PastAward => award !== null);
}

export type PastAwardsResult =
  { known: true; listing: string; awards: PastAward[] } | { known: false; reason: string };

/**
 * Fetch and store prior winners for a grant, returning what a consultant sees.
 *
 * The `known: false` branch is not an error path — it is the honest answer for
 * every non-US call and for US calls whose notice omits its listing number.
 * Returning an empty array instead would read as "nobody has ever won this",
 * which is a much stronger and entirely unfounded claim.
 */
export async function loadPastAwards(
  supabase: SupabaseClient,
  grantId: string,
): Promise<PastAwardsResult> {
  const { data, error } = await supabase
    .from("grants")
    .select("id, funder_id, country, assistance_listings")
    .eq("id", grantId)
    .maybeSingle();
  if (error) throw new Error(`could not read the call: ${error.message}`);
  if (!data) throw new Error("That call is no longer in the catalog.");

  const grant = data as {
    id: string;
    funder_id: string;
    country: string;
    assistance_listings: string[] | null;
  };
  const listing = (grant.assistance_listings ?? [])[0];

  if (!listing) {
    return {
      known: false,
      reason:
        grant.country === "US"
          ? "This notice does not carry an assistance listing number, so we cannot look up who has won it."
          : `We have no award history for ${grant.country}. Only US federal awards are published at this level of detail.`,
    };
  }

  const awards = await fetchPastAwards(listing);

  if (awards.length > 0) {
    await supabase.from("past_awards").upsert(
      awards.map((award) => ({
        funder_id: grant.funder_id,
        grant_id: grant.id,
        recipient_name: award.recipientName,
        amount: award.amount,
        awarded_on: award.awardedOn,
        recipient_location: award.location,
        assistance_listing: listing,
        source_key: SOURCE_KEY,
        source_hash: createHash("sha256").update(`${SOURCE_KEY}:${award.externalId}`).digest("hex"),
      })),
      { onConflict: "source_hash" },
    );
  }

  return { known: true, listing, awards };
}
