import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { catalogWriter } from "./caller";

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

/** How long a stored answer stays good. Award history moves in months. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

/** How far back "who won this before" looks. Older winners describe a different program. */
const LOOKBACK_YEARS = 5;

export async function fetchPastAwards(
  listings: string | readonly string[],
  limit = 25,
  now = new Date(),
): Promise<PastAward[]> {
  const programs = typeof listings === "string" ? [listings] : [...listings];
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - LOOKBACK_YEARS);
  const response = await fetch(SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      // Recent awards only, across every listing the notice carries: sorting
      // all-time awards by size surfaced 2006 billion-dollar grants as the
      // "prior winners" of a 2026 call.
      filters: {
        award_type_codes: ASSISTANCE_TYPES,
        program_numbers: programs,
        // new_awards_only: awards that *started* in the window. Without it the
        // window matches any award with activity in it, and a 2006 grant still
        // drawing funds came back as a recent winner (verified live).
        time_period: [
          {
            start_date: start.toISOString().slice(0, 10),
            end_date: now.toISOString().slice(0, 10),
            date_type: "new_awards_only",
          },
        ],
      },
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
    .map((row) => normalizeAward(row, programs.join("+")))
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

  // Served from our own table when it is fresh. Storing these and then
  // re-querying USAspending on every page view made past_awards a write-only
  // table: we paid for the same answer repeatedly and the stored copy did
  // nothing. A funder's award history changes on the order of months, so a day
  // is a generous freshness window.
  const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
  const { data: cached } = await supabase
    .from("past_awards")
    .select("recipient_name, amount, awarded_on, recipient_location, source_hash, fetched_at")
    .eq("assistance_listing", listing)
    .gte("fetched_at", cutoff)
    .order("amount", { ascending: false, nullsFirst: false })
    .limit(25);

  const stored = (cached ?? []) as Array<{
    recipient_name: string;
    amount: number | null;
    awarded_on: string | null;
    recipient_location: string | null;
    source_hash: string;
  }>;
  if (stored.length > 0) {
    return {
      known: true,
      listing,
      awards: stored.map((row) => ({
        recipientName: row.recipient_name,
        amount: row.amount,
        awardedOn: row.awarded_on,
        location: row.recipient_location,
        externalId: row.source_hash,
      })),
    };
  }

  const awards = await fetchPastAwards(grant.assistance_listings ?? [listing]);

  if (awards.length > 0) {
    // Shared catalog data: consultants may read it, only the server writes it.
    // Written as the caller, this upsert was silently refused by RLS, so the
    // cache above never filled and every view paid USAspending again.
    const { error: cacheError } = await catalogWriter()
      .from("past_awards")
      .upsert(
        awards.map((award) => ({
          funder_id: grant.funder_id,
          grant_id: grant.id,
          recipient_name: award.recipientName,
          amount: award.amount,
          awarded_on: award.awardedOn,
          recipient_location: award.location,
          assistance_listing: listing,
          fetched_at: new Date().toISOString(),
          source_key: SOURCE_KEY,
          source_hash: createHash("sha256")
            .update(`${SOURCE_KEY}:${award.externalId}`)
            .digest("hex"),
        })),
        { onConflict: "source_hash" },
      );
    // The answer is still correct without the cache; say so in the log.
    if (cacheError) console.warn(`past_awards cache write failed: ${cacheError.message}`);
  }

  return { known: true, listing, awards };
}
