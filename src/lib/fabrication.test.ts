import { describe, expect, it } from "vitest";
import { fabrications, frenchPhraseValue } from "./fabrication";

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
  it("ignores a French-localised gap marker too", () => {
    expect(
      fabrications("Dirigé par [BESOIN : 15 ans d'expérience du responsable].", FACTS),
    ).toEqual([]);
  });

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

describe("digits and words are the same claim", () => {
  it("allows a supplied digit restated as a word", () => {
    // The false positive that made the measured fabrication rate meaningless:
    // the facts say "six sites", a draft says "six sites", and the first
    // version flagged it because the two spellings never met.
    expect(fabrications("We work across six sites.", FACTS)).toEqual([]);
  });

  it("allows a supplied word restated as a digit", () => {
    expect(fabrications("There are 6 sites.", ["We work across six sites."])).toEqual([]);
  });

  it("still catches a spelled number nobody supplied", () => {
    expect(fabrications("She has fifteen years of experience.", FACTS)).toHaveLength(1);
  });
});

describe("French number words", () => {
  const FR_FACTS = [
    "Fondé en 2011, l'organisme gère six sites et 312 bénévoles.",
    "Budget annuel : 450 000 $.",
  ];
  const frKinds = (draft: string, facts = FR_FACTS) =>
    fabrications(draft, facts).map((f) => `${f.kind}:${f.text}`);

  it("catches every value from 1 to 90 spelled out", () => {
    const words = [
      "deux",
      "trois",
      "quatre",
      "cinq",
      "sept",
      "huit",
      "dix",
      "onze",
      "douze",
      "treize",
      "quatorze",
      "quinze",
      "seize",
      "dix-sept",
      "dix-huit",
      "dix-neuf",
      "vingt",
      "vingt et un",
      "vingt-deux",
      "trente",
      "trente-cinq",
      "quarante",
      "cinquante",
      "soixante",
      "soixante-dix",
      "soixante et onze",
      "soixante-dix-neuf",
      "quatre-vingts",
      "quatre-vingt-un",
      "quatre-vingt-dix",
    ];
    for (const word of words) {
      expect(frKinds(`L'équipe compte ${word} employés.`), word).toHaveLength(1);
    }
  });

  it("reads compounds as one value", () => {
    expect(frenchPhraseValue(["quatre", "vingt", "dix"])).toBe(90);
    expect(frenchPhraseValue(["soixante", "onze"])).toBe(71);
    expect(frenchPhraseValue(["deux", "cent", "mille"])).toBe(200_000);
    expect(frenchPhraseValue(["trois", "millions"])).toBe(3_000_000);
    expect(frKinds("Nous servons quatre-vingt-dix familles.")).toEqual([
      "spelled-number:quatre vingt dix",
    ]);
  });

  it("catches cent, mille and million", () => {
    expect(frKinds("Plus de cent participants.")).toEqual(["spelled-number:cent"]);
    expect(frKinds("Environ mille visiteurs.")).toEqual(["spelled-number:mille"]);
    expect(frKinds("Un budget de deux millions de dollars.")).toEqual([
      "spelled-number:deux millions",
    ]);
  });

  it("allows a French word for a supplied figure, and a supplied figure as a word", () => {
    expect(
      fabrications("Nous gérons six sites avec trois cent douze bénévoles.", FR_FACTS),
    ).toEqual([]);
    expect(fabrications("There are 26 sites.", ["vingt-six sites"])).toEqual([]);
    expect(fabrications("Nous gérons vingt-six sites.", ["26 sites"])).toEqual([]);
  });

  it("treats French thousands grouping as one number", () => {
    expect(fabrications("Notre budget est de 450 000 $.", FR_FACTS)).toEqual([]);
    expect(frKinds("Nous demandons 120 000 $.")).toEqual(["number:120 000"]);
  });

  it("does not read ordinary words as figures", () => {
    // "un"/"une" is the article; "neuf" is "new"; "pour cent" is percent.
    expect(
      fabrications("Un organisme ouvre une nouvelle salle dans un bâtiment neuf.", FR_FACTS),
    ).toEqual([]);
    expect(frKinds("Neuf employés.")).toEqual(["spelled-number:neuf"]);
    expect(frKinds("Hausse de 6 pour cent.", ["6"])).toEqual([]);
    expect(fabrications("Due Sept. 30.", ["30"])).toEqual([]);
  });
});
