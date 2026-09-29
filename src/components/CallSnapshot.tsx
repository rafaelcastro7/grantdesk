import { detectCostSharePercent, detectInKindCapPercent } from "@/lib/eligibility";
import { daysUntilDeadline } from "@/lib/deadline";
import { formatMoney } from "@/lib/money";

export type CallSnapshotGrant = {
  title: string;
  url: string;
  deadline: string | null;
  summary: string | null;
  eligibility_note: string | null;
  status: string | null;
  currency: string | null;
  amount_min: number | null;
  amount_max: number | null;
  country: string;
  documents: Array<{ label: string; url: string }> | null;
  contact: string | null;
  source_key: string | null;
  last_seen_at: string | null;
  funders: { name: string; website: string | null } | null;
};

const SOURCE_LABEL: Record<string, string> = {
  "grants-gov": "Grants.gov",
  "business-benefits-finder": "Innovation Canada",
  "cra-foundations": "CRA charities data",
  "ontario-tpon": "Ontario — Transfer Payment Ontario",
  otf: "Ontario Trillium Foundation",
};

/**
 * Everything the catalog holds about one call, in the funder's own words, so
 * the Opportunity Brief can be filled without leaving the app. Every field
 * says "not published" rather than being left out: a missing amount and a
 * hidden one look identical otherwise.
 */
export function CallSnapshot({ grant }: { grant: CallSnapshotGrant }) {
  const days = grant.deadline ? daysUntilDeadline(grant.deadline, new Date()) : null;
  const prose = [grant.eligibility_note, grant.summary].filter(Boolean).join(" ");
  const share = detectCostSharePercent(prose);
  const inKind = detectInKindCapPercent(prose);
  const amount =
    grant.amount_min && grant.amount_max
      ? `${formatMoney(grant.amount_min, grant.currency)} – ${formatMoney(grant.amount_max, grant.currency)}`
      : grant.amount_max
        ? `Up to ${formatMoney(grant.amount_max, grant.currency)}`
        : grant.amount_min
          ? `From ${formatMoney(grant.amount_min, grant.currency)}`
          : "Not published";
  const closed = grant.status && grant.status !== "open";

  const facts: Array<[string, React.ReactNode]> = [
    ["Funder", grant.funders?.name ?? "Not published"],
    [
      "Status",
      closed ? (
        <span className="text-[var(--color-ineligible)]">{grant.status}</span>
      ) : days !== null && days < 0 ? (
        <span className="text-[var(--color-ineligible)]">Deadline passed</span>
      ) : grant.status === "open" ? (
        "Open"
      ) : (
        "Not published"
      ),
    ],
    ["Award", amount],
    [
      "Deadline",
      grant.deadline
        ? `${grant.deadline}${days !== null && days >= 0 ? ` · ${days} day${days === 1 ? "" : "s"} left` : ""}`
        : "None published — rolling or continuous intake",
    ],
    ["Intake", grant.deadline ? "Fixed deadline" : "Rolling"],
    [
      "Cost share",
      share === null
        ? "Not stated in the funder's text"
        : share === 0
          ? "Funder covers the full cost"
          : `Applicant carries about ${share}%${inKind !== null ? ` · in-kind at most ${inKind}%` : ""}`,
    ],
    ["Country", grant.country],
    ["Contact", grant.contact ?? "Not published"],
  ];

  return (
    <section
      data-testid="call-snapshot"
      className="mt-4 rounded-md border border-[var(--color-rule)] bg-[var(--color-surface)]"
    >
      <dl className="grid gap-px bg-[var(--color-rule)] sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div key={label} className="bg-[var(--color-surface)] px-4 py-2.5">
            <dt className="text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">
              {label}
            </dt>
            <dd className="mt-0.5 text-sm break-words">{value}</dd>
          </div>
        ))}
      </dl>

      {grant.summary && (
        <details className="border-t border-[var(--color-rule)] px-4 py-3" open>
          <summary className="cursor-pointer text-sm font-semibold">Description</summary>
          <p className="mt-2 whitespace-pre-line text-sm">{grant.summary}</p>
        </details>
      )}
      {grant.eligibility_note && (
        <details className="border-t border-[var(--color-rule)] px-4 py-3" open>
          <summary className="cursor-pointer text-sm font-semibold">
            Who can apply — the funder's words
          </summary>
          <p className="mt-2 whitespace-pre-line text-sm">{grant.eligibility_note}</p>
        </details>
      )}

      <div className="border-t border-[var(--color-rule)] px-4 py-3 text-sm">
        <p className="font-semibold">Guidelines and forms</p>
        {grant.documents && grant.documents.length > 0 ? (
          <ul className="mt-1 flex flex-col gap-1">
            {grant.documents.map((d) => (
              <li key={d.url}>
                <a
                  href={d.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--color-accent)]"
                >
                  {d.label}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[var(--color-ink-soft)]">
            The source lists none — check the call's page for an application guide.
          </p>
        )}
        <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
          From {SOURCE_LABEL[grant.source_key ?? ""] ?? grant.source_key ?? "an unknown source"}
          {grant.last_seen_at
            ? `, last confirmed at the source on ${grant.last_seen_at.slice(0, 10)}`
            : ""}
          .{" "}
          <a
            href={grant.url}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-accent)]"
          >
            Open the call
          </a>
          {grant.funders?.website && grant.funders.website !== grant.url && (
            <>
              {" · "}
              <a
                href={grant.funders.website}
                target="_blank"
                rel="noreferrer"
                className="text-[var(--color-accent)]"
              >
                Funder's site
              </a>
            </>
          )}
        </p>
      </div>
    </section>
  );
}
