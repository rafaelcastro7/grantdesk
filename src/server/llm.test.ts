import { describe, expect, it } from "vitest";
import { restMinutesFor } from "./llm";

/**
 * The circuit breaker's decision, tested because its first version never fired.
 *
 * The pattern ended in what looked like a word boundary and was actually a
 * literal backspace character, so it matched no message ever produced. Every
 * request kept paying a full round trip to a provider that had already
 * answered "payment required", and nothing looked wrong: the chain still
 * returned an answer, only slower.
 */
describe("restMinutesFor", () => {
  it("rests a long time on an account state, which retrying cannot fix", () => {
    // Cerebras answers this to every call until someone visits the billing tab.
    expect(
      restMinutesFor('cerebras_http_402: {"message":"Payment required to access this resource."}'),
    ).toBe(30);
    expect(restMinutesFor("groq_http_401: invalid api key")).toBe(30);
    expect(restMinutesFor("gemini_http_403: forbidden")).toBe(30);
  });

  it("rests briefly on a rate limit, which time does fix", () => {
    expect(restMinutesFor("gemini_http_429: quota exceeded for this minute")).toBe(2);
  });

  it("does not rest on a failure that might be this request's fault", () => {
    // A 500, a timeout or an empty response says nothing about the next call,
    // and skipping a working provider is worse than one wasted round trip.
    for (const message of [
      "groq_http_500: internal error",
      "groq_empty_content",
      "The operation was aborted due to timeout",
      "cerebras: failed caller validation",
    ]) {
      expect(restMinutesFor(message), message).toBe(0);
    }
  });

  it("does not match a status that merely appears in the body", () => {
    // The provider prefix is what makes this a status rather than prose.
    expect(restMinutesFor('groq_http_500: {"detail":"upstream returned 402"}')).toBe(0);
  });
});
