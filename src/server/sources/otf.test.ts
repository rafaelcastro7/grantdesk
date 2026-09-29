import { describe, expect, it } from "vitest";
import { parseOtfDeadlines, parseOtfStreamPage } from "./otf";

// Trimmed from otf.ca's own Grant Application Deadlines table (2026-09-29).
const TABLE = `<table><tbody>
<tr><td><h4><a href="/our-grants/community-investments-grants/seed-grant">Seed grant</a></h4></td>
<td><ul><li><span>Application period is from July 22, 2026 to&nbsp;August 19, 2026, at 5:00 p.m. ET. </span><span class="highlight">Closed</span></li></ul></td></tr>
<tr><td><h4><a href="/our-grants/community-investments-grants/grow-grant">Grow grant</a></h4></td>
<td><ul><li><span>Application period is from October 7, 2026 to November 4, 2026, at 5:00 p.m. ET.</span></li></ul></td></tr>
<tr><td><h4><a href="/our-grants/youth-opportunities-fund">Youth Opportunities Fund</a></h4></td>
<td><h5><strong>System Innovations grant</strong></h5><ul><li>Application period opens: October 14, 2026</li><li>Application deadline: March 10, 2027, at 5:00 p.m. ET.</li></ul>
<h5><strong>Organizational Mentor application period</strong></h5><ul><li>January 7, 2026 to June 19, 2026. <span class="highlight">Closed</span></li></ul></td></tr>
</tbody></table>`;

describe("OTF deadlines table", () => {
  const streams = parseOtfDeadlines(TABLE);

  it("reads one stream per row and one per sub-heading, skipping volunteer roles", () => {
    expect(streams.map((s) => s.title)).toEqual([
      "Ontario Trillium Foundation — Seed grant",
      "Ontario Trillium Foundation — Grow grant",
      "Youth Opportunities Fund — System Innovations grant",
    ]);
  });

  it("takes the closing date and the funder's own Closed marker", () => {
    expect(streams[0]).toMatchObject({ deadline: "2026-08-19", status: "closed" });
    expect(streams[1]).toMatchObject({ deadline: "2026-11-04", status: "open" });
    expect(streams[2]).toMatchObject({ deadline: "2027-03-10", status: "open" });
    expect(streams[1]!.url).toBe(
      "https://www.otf.ca/our-grants/community-investments-grants/grow-grant",
    );
  });
});

describe("OTF stream page", () => {
  it("reads the award range and eligibility wording", () => {
    const page =
      parseOtfStreamPage(`<meta name="description" content="OTF&#039;s Seed grants test new ideas.">
      <h3>Amount awarded and grant term</h3><p>$10,000 to $100,000, for 6 or 12 months</p>
      <h2>Organization requirements</h2><p>Applicants must be non-profit organizations.</p>
      <h2>What we fund</h2><p>Priorities.</p>`);
    expect(page.amountMin).toBe(10000);
    expect(page.amountMax).toBe(100000);
    expect(page.summary).toContain("OTF's Seed grants");
    expect(page.eligibility).toContain("non-profit organizations");
    expect(page.eligibility).not.toContain("Priorities");
  });
});
