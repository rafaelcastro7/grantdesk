import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-message";

describe("errorMessage", () => {
  it("reads an Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("reads a Supabase rejection, which is a plain object", () => {
    // The real shape that rendered as "[object Object]" on screen while the
    // server had said exactly what was wrong.
    const postgrestError = {
      code: "23502",
      details: null,
      hint: null,
      message: 'null value in column "currency" violates not-null constraint',
    };
    expect(errorMessage(postgrestError)).toContain("not-null constraint");
  });

  it("falls back to other conventional fields", () => {
    expect(errorMessage({ error_description: "token expired" })).toBe("token expired");
    expect(errorMessage({ details: "row not found" })).toBe("row not found");
  });

  it("passes a string straight through", () => {
    expect(errorMessage("plain")).toBe("plain");
  });

  it("never renders [object Object]", () => {
    expect(errorMessage({ weird: true })).not.toContain("[object Object]");
    expect(errorMessage(null)).not.toContain("[object Object]");
    expect(errorMessage(undefined)).not.toContain("[object Object]");
  });

  it("says something honest when there is nothing to report", () => {
    expect(errorMessage(null)).toMatch(/not reported/i);
  });
});
