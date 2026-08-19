import { describe, expect, it } from "vitest";
import { fabrications } from "./fabrication";

/** What the model was shown. Everything else in a draft is its own invention. */
const FACTS = [
  "Ravine Keepers restores urban ravines. Founded in 2011, six sites.",
  "Annual budget CAD 450,000.",
  "The Wentworth Ravine restoration was completed with 312 volunteers.",
];

const kinds = (draft: string) => fabrications(draft, FACTS).map((f) => `${f.kind}:${f.text}`);

describe("numbers", () => {
  it("passes a figure that was supplied", () => {
    expect(fabrications("We have worked across six sites since 2011.", FACTS)).toEqual([]);
    expect(fabrications("Our budget is CAD 450,000.", FACTS)).toEqual([]);
  });

  it("catches a figure that was not", () => {
    expect(kinds("We served 4,200 residents last year.")).toContain("number:4,200");
  });

  it("catches a spelled-out figure", () => {
    // The failure that slipped past the first checker: a model wrote
    // "over fifteen years of experience" and no digit appeared anywhere.
    expect(kinds("She brings over fifteen years of experience.")).toContain(
      "spelled-number:fifteen",
    );
  });

  it("allows a spelled figure that was supplied", () => {
    expect(fabrications("We work across six sites.", FACTS)).toEqual([]);
  });
});

describe("people", () => {
  it("catches an invented named person with a title", () => {
    // Measured from a real local-model draft: "Dr. Elena Rossi, an
    // environmental scientist with over fifteen years".
    expect(kinds("The lead is Dr. Elena Rossi, an environmental scientist.")).toContain(
      "person:Dr. Elena Rossi",
    );
  });

  it("catches an invented person introduced by their role", () => {
    // Also real: "John Smith, Project Manager - MBA, 10 years of experience".
    expect(kinds("John Smith, Project Manager, will lead delivery.")).toContain(
      "person:John Smith",
    );
  });

  it("does not flag the organization or the places it was given", () => {
    // A rule loose enough to catch every possible invented name would flag
    // these on every draft, and then nobody reads its output.
    expect(fabrications("Ravine Keepers will deliver this at Wentworth Ravine.", FACTS)).toEqual(
      [],
    );
  });
});

describe("what is not a claim", () => {
  it("ignores anything inside a marked gap", () => {
    // A gap the model marked rather than filled is the correct behaviour, and
    // whatever it names inside is a description of what is missing.
    expect(
      fabrications(
        "Led by [NEED: name of the project lead] with [NEED: 15 years experience].",
        FACTS,
      ),
    ).toEqual([]);
  });

  it("ignores list markers", () => {
    expect(fabrications("1. Staffing\n2. Materials\n3. Reporting", FACTS)).toEqual([]);
  });

  it("reports a repeated invention once", () => {
    // Three mentions of one wrong figure is one thing to fix.
    expect(fabrications("We served 4,200 people. All 4,200 of them.", FACTS)).toHaveLength(1);
  });
});
