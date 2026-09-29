import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  cleanDraft,
  countWords,
  languageInstruction,
  type DraftClient,
} from "./draft";

describe("cleanDraft", () => {
  it("removes the preamble models add despite being told not to", () => {
    // The preamble ends up in the funder's form otherwise.
    expect(cleanDraft("Here is the section:\n\nOur organization has run…")).toBe(
      "Our organization has run…",
    );
    expect(cleanDraft("Sure! Let me help.\n\nSince 2011 we have…")).toBe("Since 2011 we have…");
    expect(cleanDraft("Voici la section demandée :\n\nDepuis 2011, nous…")).toBe(
      "Depuis 2011, nous…",
    );
  });

  it("keeps French prose that merely starts with Voici", () => {
    const prose = "Voici comment nous rejoignons 400 élèves.\nDepuis 2011…";
    expect(cleanDraft(prose)).toBe(prose);
  });

  it("removes code fences", () => {
    expect(cleanDraft("```\nOur programs reach 400 students.\n```")).toBe(
      "Our programs reach 400 students.",
    );
  });

  it("leaves prose that starts with a real sentence alone", () => {
    const prose = "Here we serve 400 students a year, across six schools.";
    // "Here we serve…" is the draft, not a preamble — a greedier rule would eat it.
    expect(cleanDraft(prose)).toBe(prose);
  });

  it("keeps the gap markers, which are the point of them", () => {
    const draft = "We served [NEED: number] participants in [NEED: year].";
    expect(cleanDraft(draft)).toBe(draft);
  });
});

describe("languageInstruction", () => {
  it("asks for Canadian French and keeps the gap marker a machine token", () => {
    const fr = languageInstruction("fr");
    expect(fr).toMatch(/Canadian French/);
    expect(fr).toContain("[NEED: ...]");
    expect(fr).toMatch(/Every rule above still applies/);
  });

  it("asks for English by default", () => {
    expect(languageInstruction("en")).toBe("Write the section in English.");
  });
});

describe("buildPrompt language", () => {
  const client: DraftClient = {
    id: "c1",
    name: "Centre communautaire",
    sectors: null,
    jurisdictions: null,
    stage: null,
    annualBudget: null,
    capabilities: null,
    beneficiaries: null,
  };
  const requirement = {
    id: "r1",
    label: "Description du projet",
    detail: null,
    wordLimit: 500,
    evaluationNote: null,
    sourceQuote: null,
  };

  it("asks for French when the client drafts in French", () => {
    const prompt = buildPrompt(requirement, { ...client, draftLanguage: "fr" }, []);
    expect(prompt).toContain(languageInstruction("fr"));
    expect(prompt).not.toContain("Write the section in English.");
  });

  it("defaults to English when no draft language is set", () => {
    const prompt = buildPrompt(requirement, client, []);
    expect(prompt).toContain("Write the section in English.");
    expect(prompt).not.toContain("Canadian French");
  });
});

describe("countWords", () => {
  it("counts words the way a funder's limit means them", () => {
    expect(countWords("Our organization has served this community since 2011.")).toBe(8);
  });

  it("is zero for nothing, rather than one", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n  ")).toBe(0);
  });
});
