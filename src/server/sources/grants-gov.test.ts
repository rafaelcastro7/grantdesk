import { describe, expect, it } from "vitest";
import {
  departmentOf,
  parseAmount,
  parseCloseDate,
  parseDetailDate,
  readDetail,
} from "./grants-gov";

describe("parseCloseDate", () => {
  it("converts the feed's US format to ISO", () => {
    expect(parseCloseDate("11/17/2026")).toBe("2026-11-17");
  });

  it("returns null rather than guessing at anything else", () => {
    for (const raw of ["2026-11-17", "soon", "", null, undefined]) {
      expect(parseCloseDate(raw)).toBeNull();
    }
  });
});

describe("departmentOf", () => {
  it("takes the department from a dotted agency code", () => {
    expect(departmentOf("HHS-NIH11")).toBe("US-HHS");
  });

  it("falls back to a real label when the code is missing", () => {
    expect(departmentOf(null)).toBe("US-Federal");
  });
});

describe("parseAmount", () => {
  it("reads the figures this feed publishes as strings", () => {
    expect(parseAmount("500000")).toBe(500_000);
    expect(parseAmount("$1,250,000")).toBe(1_250_000);
    expect(parseAmount(75_000)).toBe(75_000);
  });

  it("treats the feed's own non-answers as no answer", () => {
    // "none" and "0" are both published, and neither is an award floor.
    for (const raw of ["none", "", "0", null, undefined, "N/A"]) {
      expect(parseAmount(raw)).toBeNull();
    }
  });
});

describe("readDetail", () => {
  it("reads a posted opportunity's synopsis", () => {
    const detail = readDetail({
      data: {
        synopsis: {
          synopsisDesc: "<p>Supports <b>community</b> health.</p>",
          applicantEligibilityDesc: "Only 501(c)(3) organizations.",
          applicantTypes: [{ id: "12" }],
          awardFloor: "25000",
          awardCeiling: "$500,000",
        },
      },
    });

    expect(detail.summary).toBe("Supports community health.");
    expect(detail.eligibleApplicantTypes).toEqual(["charity", "nonprofit"]);
    expect(detail.amountMin).toBe(25_000);
    expect(detail.amountMax).toBe(500_000);
  });

  it("reads a forecasted opportunity, which publishes the same facts under other keys", () => {
    // Reading only `synopsis` silently dropped the description and applicant
    // list for every forecasted call — a third of the feed.
    const detail = readDetail({
      data: {
        forecast: { forecastDesc: "Planned award for 2027.", applicantTypes: [{ id: "20" }] },
      },
    });

    expect(detail.summary).toBe("Planned award for 2027.");
    expect(detail.eligibleApplicantTypes).toEqual(["academic"]);
  });

  it("returns empty fields rather than throwing on a response with no detail", () => {
    expect(readDetail({ data: {} })).toEqual({
      summary: null,
      eligibilityNote: null,
      eligibleApplicantTypes: [],
      amountMin: null,
      amountMax: null,
      contact: null,
      costSharingRequired: null,
      documents: [],
      deadlineNote: null,
      estimatedDeadline: null,
    });
    expect(readDetail(null).summary).toBeNull();
  });

  it("keeps a forecast's estimated date, contact and cost-share flag (live shape, NIEHS 359970)", () => {
    const detail = readDetail({
      data: {
        forecast: {
          forecastDesc: "<p>Worker training.</p>",
          agencyContactName: "Sharon D. Beard\nNIEHS",
          agencyContactEmail: "beard1@niehs.nih.gov",
          agencyContactPhone: "984-287-3237",
          costSharing: false,
          estApplicationResponseDate: "Nov 25, 2025 12:00:00 AM EST",
        },
      },
    });
    expect(detail.estimatedDeadline).toBe("2025-11-25");
    expect(detail.contact).toBe("Sharon D. Beard NIEHS · beard1@niehs.nih.gov · 984-287-3237");
    expect(detail.costSharingRequired).toBe(false);
  });

  it("links the NOFO attachment itself (live shape, NIST 363279)", () => {
    const detail = readDetail({
      data: {
        synopsis: { costSharing: true },
        synopsisAttachmentFolders: [
          { synopsisAttachments: [{ id: 354080, fileName: "2026-NIST-MEP-02 NOFO.pdf" }] },
        ],
      },
    });
    expect(detail.costSharingRequired).toBe(true);
    expect(detail.documents).toEqual([
      {
        label: "2026-NIST-MEP-02 NOFO.pdf",
        url: "https://apply07.grants.gov/grantsws/rest/opportunity/att/download/354080",
      },
    ]);
  });
});

describe("parseDetailDate", () => {
  it("reads the detail feed's date format and nothing else", () => {
    expect(parseDetailDate("Aug 21, 2026 12:00:00 AM EDT")).toBe("2026-08-21");
    expect(parseDetailDate("")).toBeNull();
    expect(parseDetailDate("2026-08-21")).toBeNull();
  });
});
