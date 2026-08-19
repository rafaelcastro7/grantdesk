import { describe, expect, it } from "vitest";
import { parseDuration, restMinutesFor } from "./llm";

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
    expect(restMinutesFor("groq_http_429: Rate limit reached on tokens per minute (TPM)")).toBe(2);
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

/**
 * Reading how long a rate-limited provider says to wait.
 *
 * Groq reports a token-bucket reset like "13.905s"; others use a bare number
 * of seconds or a minutes-and-seconds form. Getting this wrong is invisible in
 * the good case and expensive in the bad one: an unparsed wait means falling
 * through to the local model when waiting fourteen seconds would have produced
 * the better answer.
 */
describe("parseDuration", () => {
  it("reads the forms these providers actually send", () => {
    expect(parseDuration("13.905s")).toBe(13905);
    expect(parseDuration("2m30s")).toBe(150_000);
    expect(parseDuration("27m21.6s")).toBe(1_641_600);
    // Retry-After is plain seconds.
    expect(parseDuration("30")).toBe(30_000);
    expect(parseDuration("1.5")).toBe(1500);
  });

  it("returns null rather than guessing at anything else", () => {
    for (const raw of ["", "soon", "Wed, 21 Oct 2026 07:28:00 GMT", "abc123"]) {
      expect(parseDuration(raw), raw).toBeNull();
    }
  });
});

describe("daily exhaustion", () => {
  it("rests for an hour when the limit is a daily one", () => {
    // Retrying a spent daily allowance every two minutes is a wasted round
    // trip each time, and the message is the only thing that distinguishes it
    // from a per-minute limit that clears in seconds.
    expect(
      restMinutesFor(
        "groq_http_429: Rate limit reached for model in organization on tokens per day (TPD): Limit 200000, Used 199189",
      ),
    ).toBe(60);
    // Gemini's daily form. "quota exceeded" alone is not the tell — it says
    // that for a per-minute limit too; the billing sentence is what separates
    // an allowance that clears in seconds from one that clears tomorrow.
    expect(
      restMinutesFor(
        "gemini_http_429: You exceeded your current quota, please check your plan and billing details",
      ),
    ).toBe(60);
  });

  it("still rests only briefly for a per-minute limit", () => {
    expect(restMinutesFor("groq_http_429: Rate limit reached on tokens per minute (TPM)")).toBe(2);
  });
});
