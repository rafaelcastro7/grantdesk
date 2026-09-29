import { describe, expect, it } from "vitest";
import { briefDocument, briefFilename, briefMarkdown, type BriefFields } from "./brief-export";

const call = {
  title: "Community Futures Fund",
  funder: "Prairie Foundation",
  country: "CA",
  deadline: "2026-11-30",
  amountMin: 10000,
  amountMax: 50000,
  currency: "CAD",
  url: "https://example.org/call",
};

const brief: BriefFields = {
  role: "lead",
  role_other: null,
  intake: "fixed",
  application_structure: null,
  strategic_angle: "Extends the youth programme",
  mandatory_components: "• Budget\n• Letters of support",
  request_amount: 40000,
  net_revenue: null,
  match_required: null,
  in_kind_cap: null,
  cash_match_confirmed: false,
  risks: null,
  recommendation: "go",
  recommendation_reason: "Strong fit",
  condition: null,
  decision: "go",
  condition_met: false,
  decided_by: "A. Director",
  decision_reason: null,
  decided_at: "2026-09-20T15:00:00Z",
  recorderEmail: "consultant@example.org",
};

function row(doc: ReturnType<typeof briefDocument>, heading: string, label: string) {
  return doc.sections.find((s) => s.heading === heading)?.rows.find(([l]) => l === label)?.[1];
}

describe("briefDocument", () => {
  const doc = briefDocument(call, brief, true);

  it("carries the call facts in the funder's currency", () => {
    expect(row(doc, "The call", "Funder")).toBe("Prairie Foundation");
    expect(row(doc, "The call", "Award")).toMatch(/CAD.*10,000.*CAD.*50,000/);
    expect(row(doc, "Brief", "Request amount")).toMatch(/CAD.*40,000/);
  });

  it("writes an unanswered field as not stated instead of dropping it", () => {
    expect(row(doc, "Brief", "Match required")).toBe("Not stated");
    expect(row(doc, "Brief", "Application structure")).toBe("Not stated");
  });

  it("keeps the decision record with approver, date and recorder", () => {
    expect(row(doc, "Decision record", "Decision")).toBe("GO");
    expect(row(doc, "Decision record", "Approved by")).toBe("A. Director");
    expect(row(doc, "Decision record", "Decided on")).toBe("2026-09-20");
    expect(row(doc, "Decision record", "Recorded by")).toBe("consultant@example.org");
  });

  it("says when the award is not published", () => {
    const none = briefDocument({ ...call, amountMin: null, amountMax: null }, brief, true);
    expect(row(none, "The call", "Award")).toBe("Not published by the funder");
  });
});

describe("briefMarkdown", () => {
  it("renders headings, list rows and multi-line blocks", () => {
    const md = briefMarkdown(briefDocument(call, brief, true));
    expect(md).toContain("# Opportunity Brief — Community Futures Fund");
    expect(md).toContain("## Decision record");
    expect(md).toContain("- **Approved by:** A. Director");
    expect(md).toContain("**Mandatory components:**\n\n• Budget\n• Letters of support");
    expect(md).not.toContain("Draft:");
  });

  it("marks an unsaved, pre-filled brief as a draft", () => {
    expect(briefMarkdown(briefDocument(call, brief, false))).toContain("_Draft:");
  });
});

describe("briefFilename", () => {
  it("slugs accents and punctuation", () => {
    expect(briefFilename("Fonds d'Économie Sociale: 2026")).toBe(
      "opportunity-brief-fonds-d-economie-sociale-2026.md",
    );
  });
});
