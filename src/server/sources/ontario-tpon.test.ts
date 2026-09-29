import { describe, expect, it } from "vitest";
import { parseAmounts, parseDeadline, parseOntarioPage, programUrl } from "./ontario-tpon";

// Trimmed from the live page's own markup (2026-09-29).
const PAGE = `<div class="body-field"><h2>Overview</h2><p>You can apply for funding.</p>
<h2>Child Victims of Gun and Gang Violence Grant Program 2026–28</h2>
<div><a class="button" href="/page/get-funding-ontario-government">Apply for funding</a></div>
<p>Status: <span class="badge badge--default-heavy">OPEN</span></p>
<p>Ministry of the Attorney General</p>
<h3>Deadline</h3><p>Submit your application by October 5, 2026 at 5:00 p.m. <abbr>EDT</abbr>.</p>
<h3>Description</h3><p>Funding to eligible community-based agencies.</p>
<ul><li>Maximum funding is <strong>$200,000 per project</strong>.</li></ul>
<h3>Eligibility</h3><p>Organizations that can apply to the program:</p><ul><li>family service agencies</li><li>community legal clinics</li></ul>
<h3>Program guidelines</h3><ul><li><a href="https://forms.mgcs.gov.on.ca/en/dataset/on00967">Application Guidelines</a></li></ul>
<h3>Contacts</h3><p>Contact <a href="mailto:OVS-Proposals@ontario.ca">OVS-Proposals@ontario.ca</a>&nbsp;</p>
<h2>Winter Roads Program</h2>
<p>Status: <span class="badge">CLOSED</span></p>
<p>The types of support available include:</p>
<h3>Description</h3><p>Grants range from $5,000 to $50,000.</p>
</div>`;

describe("Ontario funding opportunities page", () => {
  const programs = parseOntarioPage(PAGE);

  it("reads one program per heading and skips the overview", () => {
    expect(programs.map((p) => p.title)).toEqual([
      "Child Victims of Gun and Gang Violence Grant Program 2026–28",
      "Winter Roads Program",
    ]);
  });

  it("keeps every screening field the funder publishes", () => {
    const p = programs[0]!;
    expect(p.status).toBe("open");
    expect(p.ministry).toBe("Ministry of the Attorney General");
    expect(p.deadline).toBe("2026-10-05");
    expect(p.amountMax).toBe(200000);
    expect(p.eligibility).toContain("community legal clinics");
    expect(p.documents).toEqual([
      { label: "Application Guidelines", url: "https://forms.mgcs.gov.on.ca/en/dataset/on00967" },
    ]);
    expect(p.contact).toContain("OVS-Proposals@ontario.ca");
  });

  it("marks closed programs and never takes an intro sentence for a ministry", () => {
    const p = programs[1]!;
    expect(p.status).toBe("closed");
    expect(p.ministry).toBeNull();
    expect(p.amountMin).toBe(5000);
    expect(p.amountMax).toBe(50000);
  });

  it("links to the program's own heading", () => {
    expect(programUrl("Winter Roads Program")).toContain("#:~:text=Winter%20Roads%20Program");
  });
});

describe("amount and deadline parsing", () => {
  it("does not read a program's total envelope as an award ceiling", () => {
    expect(
      parseAmounts("The CSRIF is a $500 million program that provides funding").max,
    ).toBeNull();
  });

  it("reads a ceiling stated in millions", () => {
    expect(parseAmounts("The maximum amount of funding for eligible costs is $5 million").max).toBe(
      5_000_000,
    );
  });

  it("takes the last date in the deadline text and reports none when there is none", () => {
    expect(parseDeadline("Opens June 1, 2026; closes November 6, 2026.")).toBe("2026-11-06");
    expect(parseDeadline("Applications are accepted on an ongoing basis.")).toBeNull();
  });
});
