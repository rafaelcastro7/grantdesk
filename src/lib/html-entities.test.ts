import { describe, expect, it } from "vitest";
import { decodeEntities } from "./html-entities";

describe("decodeEntities", () => {
  it("decodes the entities feeds leave in titles", () => {
    expect(decodeEntities("Health &amp; Safety&nbsp;Fund")).toBe("Health & Safety Fund");
    expect(decodeEntities("Programme d&#39;aide &eacute;conomique")).toBe(
      "Programme d'aide économique",
    );
    expect(decodeEntities("A &#x2013; B")).toBe("A – B");
  });

  it("leaves unknown entities and plain text alone", () => {
    expect(decodeEntities("R&D &bogus; fund")).toBe("R&D &bogus; fund");
  });
});
