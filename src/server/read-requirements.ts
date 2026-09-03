import type { SupabaseClient } from "@supabase/supabase-js";
import { extractRequirementsFromText, extractRequirementsFromUrl } from "./extract-requirements";

/**
 * Read a call's own requirements and store them against the grant.
 *
 * Idempotent by heading: re-reading an updated call revises what it asks for
 * rather than producing a second copy of every section.
 *
 * Pulled out of proposal.functions.ts's createServerFn handler so it can be
 * called directly in a test — a createServerFn export only runs inside
 * TanStack Start's own request context (it throws "No Start context found"
 * anywhere else), which meant this had never been tested against a real call
 * and the empty-extraction case shipped broken for a while before anyone
 * noticed by clicking through the app.
 */
export async function readRequirementsForGrant(supabase: SupabaseClient, grantId: string) {
  const { data: grant, error } = await supabase
    .from("grants")
    .select("id, url, title, summary, eligibility_note")
    .eq("id", grantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!grant) throw new Error("That call is no longer in the catalog.");

  const row = grant as {
    url: string;
    title: string;
    summary: string | null;
    eligibility_note: string | null;
  };

  // Prefer the text ingestion already captured. Many funders publish their
  // detail page as a JavaScript shell — fetching a Grants.gov opportunity
  // URL returns a page containing none of its own requirements — while the
  // same call's full description came down through the API and is sitting
  // in our own table. Re-fetching to read text we already hold would be
  // slower, more fragile and worse.
  const held = [row.summary, row.eligibility_note].filter(Boolean).join("\n\n");
  const { requirements, provenance, readText, concerns } =
    held.trim().length >= 400
      ? await extractRequirementsFromText(held, row.url, row.title)
      : await extractRequirementsFromUrl(row.url);

  // Real text was read — enough of it to try extraction — but nothing
  // structured came out of it. That is not the same failure as never having
  // reached the page at all, and it should not read like one: the consultant
  // gets what was actually read, in the app, rather than a dead end pointing
  // them back to the source to find out for themselves what this system
  // already looked at.
  if (requirements.length === 0) {
    return { found: false as const, count: 0, provenance, readText, concerns };
  }

  // Replace what a previous read extracted, rather than merging into it.
  //
  // The upsert keys on the exact label and a model does not produce the same
  // wording twice: re-reading one call turned six conditions into nineteen —
  // "Applicant Status", "Nonprofit Status" and "Applicant 501(c)(3) Status"
  // all describing one rule. A consultant reading that list cannot tell
  // which are real.
  //
  // Done in the database rather than here, because the safety check has to
  // see across every consultant. Requirements are shared reference data, and
  // reading proposal_sections from this client only ever shows the caller's
  // own — so this code used to delete requirements another consultant had
  // already drafted against, silently unlinking their work.
  await supabase.rpc("replace_extracted_requirements", { target_grant: grantId });

  const { error: writeError } = await supabase.from("requirements").upsert(
    requirements.map((r) => ({
      grant_id: grantId,
      label: r.label,
      detail: r.detail,
      kind: r.kind,
      word_limit: r.wordLimit,
      evaluation_note: r.evaluationNote,
      source_quote: r.sourceQuote,
      is_critical: r.isCritical,
      sort_order: r.sortOrder,
      extracted_at: provenance.extractedAt,
      extracted_from: provenance.source,
    })),
    { onConflict: "grant_id, label" },
  );
  if (writeError) throw new Error(writeError.message);

  // Returned even on a real, structured read — not only the empty case. A
  // call can publish its conditions clearly and its section list nowhere at
  // all (most funders keep that in the application form or a PDF), and the
  // consultant then has to guess the headings for "Add a section" blind. The
  // raw text was already read to get here; handing it over costs nothing
  // extra and turns that guess into something they can actually check against.
  // The critic's remaining doubts, if any, travel with the result rather
  // than being resolved or discarded here — a consultant reading "the page
  // also mentions a required financial statement" can check the source in
  // ten seconds; this function has no way to judge whether that's real.
  return { found: true as const, count: requirements.length, provenance, readText, concerns };
}
