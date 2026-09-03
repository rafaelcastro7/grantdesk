import { describe, expect, it } from "vitest";
import { htmlToText, htmlTitle, relatedLinks } from "./html-text";

describe("htmlToText", () => {
  it("keeps prose and drops markup", () => {
    const text = htmlToText("<p>We build <b>AI software</b> for small businesses.</p>");
    expect(text).toBe("We build AI software for small businesses.");
  });

  it("removes the chrome that would otherwise dominate the prompt", () => {
    // Navigation, scripts and cookie forms are the bulk of a real page and
    // none of it describes the organization.
    const html = `
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <script>window.analytics = 1;</script>
      <style>.x { color: red }</style>
      <p>We fund clean technology in Ontario.</p>
      <form><input name="email"/></form>
      <footer>© 2026</footer>`;
    const text = htmlToText(html);
    expect(text).toBe("We fund clean technology in Ontario.");
  });

  it("turns block boundaries into line breaks so paragraphs stay separate", () => {
    const text = htmlToText("<h1>Our work</h1><p>First.</p><p>Second.</p>");
    expect(text.split("\n")).toEqual(["Our work", "First.", "Second."]);
  });

  it("decodes the entities that appear in real copy", () => {
    expect(htmlToText("<p>R&amp;D &mdash; caf&#233; &nbsp;work</p>")).toBe("R&D — café work");
  });

  it("collapses runs of whitespace", () => {
    expect(htmlToText("<p>a     b\t\tc</p>")).toBe("a b c");
  });

  it("truncates to the budget on a paragraph edge", () => {
    const html = `<p>${"a".repeat(400)}</p><p>${"b".repeat(400)}</p>`;
    const text = htmlToText(html, { maxChars: 500 });
    expect(text.length).toBeLessThanOrEqual(500);
    // Cut at the break rather than mid-sentence: the first paragraph survives
    // whole and the second is dropped entirely.
    expect(text).toBe("a".repeat(400));
  });

  it("still truncates when there is no usable break", () => {
    const text = htmlToText(`<p>${"a".repeat(1000)}</p>`, { maxChars: 100 });
    expect(text).toHaveLength(100);
  });

  it("returns empty string for markup with no text", () => {
    expect(htmlToText("<div><script>x=1</script></div>")).toBe("");
  });
});

describe("htmlTitle", () => {
  it("reads and cleans the title", () => {
    expect(htmlTitle("<html><head><title>  Acme &amp; Co  </title></head></html>")).toBe(
      "Acme & Co",
    );
  });

  it("returns null when absent or empty", () => {
    expect(htmlTitle("<html></html>")).toBeNull();
    expect(htmlTitle("<title>   </title>")).toBeNull();
  });
});

describe("relatedLinks", () => {
  const BASE = "https://example.gov/programs/regional-innovation";

  it("follows a link whose own text says it is the application page", () => {
    const html = `<a href="/programs/how-to-apply">How to Apply</a>`;
    expect(relatedLinks(html, BASE)).toEqual(["https://example.gov/programs/how-to-apply"]);
  });

  it("ignores navigation links with no reason to think they matter", () => {
    const html = `
      <a href="/contact">Contact Us</a>
      <a href="/privacy">Privacy Policy</a>
      <a href="/about">About the Agency</a>
    `;
    expect(relatedLinks(html, BASE)).toEqual([]);
  });

  it("never follows off the funder's own site, even if the words match", () => {
    // A link this tempting to a domain we do not control is exactly the case
    // worth refusing automatically.
    const html = `<a href="https://totally-unrelated.example/how-to-apply">How to Apply</a>`;
    expect(relatedLinks(html, BASE)).toEqual([]);
  });

  it("resolves relative links against the page's own URL", () => {
    const html = `<a href="eligibility-criteria.html">Eligibility Criteria</a>`;
    expect(relatedLinks(html, BASE)).toEqual([
      "https://example.gov/programs/eligibility-criteria.html",
    ]);
  });

  it("does not point back at the same page it started from", () => {
    const html = `<a href="${BASE}">Application Guidelines</a>`;
    expect(relatedLinks(html, BASE)).toEqual([]);
  });

  it("de-duplicates and stops at the limit", () => {
    const html = `
      <a href="/apply">Apply Now</a>
      <a href="/apply">Application Form</a>
      <a href="/eligibility">Eligibility</a>
      <a href="/guidelines">Guidelines</a>
    `;
    expect(relatedLinks(html, BASE, { limit: 2 })).toHaveLength(2);
  });

  it("never re-suggests a link already read in an earlier pass", () => {
    const html = `
      <a href="/eligibility">Eligibility</a>
      <a href="/guidelines">Guidelines</a>
    `;
    const already = new Set(["https://example.gov/eligibility"]);
    expect(relatedLinks(html, BASE, { exclude: already })).toEqual([
      "https://example.gov/guidelines",
    ]);
  });

  it("only widens to the loose wording bar when asked for it", () => {
    const html = `<a href="/program-details">Program Details</a>`;
    expect(relatedLinks(html, BASE)).toEqual([]);
    expect(relatedLinks(html, BASE, { broad: true })).toEqual([
      "https://example.gov/program-details",
    ]);
  });

  it("still refuses an off-site link on the loose pass", () => {
    // The wording bar is the only thing a second pass relaxes — the
    // same-origin boundary is not up for negotiation at any pass.
    const html = `<a href="https://elsewhere.example/full-guidelines">Full Guidelines</a>`;
    expect(relatedLinks(html, BASE, { broad: true })).toEqual([]);
  });
});
