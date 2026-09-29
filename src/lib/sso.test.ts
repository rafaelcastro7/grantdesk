import { describe, expect, it } from "vitest";
import { enabledSsoProviders, readSsoCallback } from "./sso";

describe("enabledSsoProviders", () => {
  it("offers nothing when no flag is set", () => {
    expect(enabledSsoProviders({})).toEqual([]);
  });

  it("offers only providers flagged exactly 1", () => {
    expect(enabledSsoProviders({ VITE_AUTH_GOOGLE: "1", VITE_AUTH_AZURE: "true" })).toEqual([
      "google",
    ]);
    expect(enabledSsoProviders({ VITE_AUTH_GOOGLE: "1", VITE_AUTH_AZURE: "1" })).toEqual([
      "google",
      "azure",
    ]);
  });
});

describe("readSsoCallback", () => {
  it("reads a PKCE code", () => {
    expect(readSsoCallback("?code=abc", "")).toEqual({ kind: "code", code: "abc" });
  });

  it("reports a provider error from the query or the hash", () => {
    expect(readSsoCallback("?error=access_denied&error_description=User+denied", "")).toEqual({
      kind: "error",
      message: "Single sign-on failed: User denied",
    });
    expect(readSsoCallback("", "#error=server_error")).toEqual({
      kind: "error",
      message: "Single sign-on failed: server_error",
    });
  });

  it("returns none on an ordinary visit", () => {
    expect(readSsoCallback("?tenant=iial", "")).toEqual({ kind: "none" });
  });
});
