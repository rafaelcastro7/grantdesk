import { describe, expect, it } from "vitest";
import { DICTIONARIES, detectLanguage, localeFor, translate } from "./i18n";

describe("detectLanguage", () => {
  it("honours ?lang= first", () => {
    expect(detectLanguage({ search: "?lang=fr", stored: "en", browser: ["en-CA"] })).toBe("fr");
  });

  it("then a choice stored on this browser, then the browser language", () => {
    expect(detectLanguage({ stored: "fr", browser: ["en-US"] })).toBe("fr");
    expect(detectLanguage({ browser: ["fr-CA", "en"] })).toBe("fr");
    expect(detectLanguage({ browser: ["es-MX", "fr"] })).toBe("fr");
  });

  it("falls back to English for anything else", () => {
    expect(detectLanguage({ search: "?lang=de", browser: ["de-DE"] })).toBe("en");
    expect(detectLanguage({})).toBe("en");
  });
});

describe("translate", () => {
  it("fills placeholders", () => {
    expect(translate("en", "nav.workspace", { name: "IIAL" })).toBe("IIAL Workspace");
    expect(translate("fr", "nav.workspace", { name: "IIAL" })).toBe("Espace IIAL");
  });

  it("keeps the English navigation labels the e2e suite navigates by", () => {
    expect(translate("en", "nav.due")).toBe("What is due");
    expect(translate("en", "nav.clients")).toBe("Clients");
    expect(translate("en", "nav.coverage")).toBe("Funder Coverage");
  });

  it("has a non-empty French string for every key", () => {
    for (const [key, value] of Object.entries(DICTIONARIES.fr)) {
      expect(value.trim(), key).not.toBe("");
    }
    expect(Object.keys(DICTIONARIES.fr).sort()).toEqual(Object.keys(DICTIONARIES.en).sort());
  });

  it("keeps placeholders identical across languages", () => {
    const names = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
    for (const key of Object.keys(DICTIONARIES.en) as Array<keyof typeof DICTIONARIES.en>) {
      expect(names(DICTIONARIES.fr[key]), key).toBe(names(DICTIONARIES.en[key]));
    }
  });
});

describe("missing translations", () => {
  it("fall back to English rather than showing a raw key", () => {
    const fr = DICTIONARIES.fr as Record<string, string>;
    const saved = fr["nav.signOut"];
    delete fr["nav.signOut"];
    try {
      expect(translate("fr", "nav.signOut")).toBe("Sign out");
    } finally {
      fr["nav.signOut"] = saved!;
    }
  });
});

describe("localeFor", () => {
  it("uses Canadian conventions in both languages", () => {
    expect(localeFor("en")).toBe("en-CA");
    expect(localeFor("fr")).toBe("fr-CA");
  });
});
