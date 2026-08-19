import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  append,
  describe as describeRate,
  rateOf,
  read,
  variantOf,
  verdictFor,
} from "./sample-log";
import type { Sample } from "./sample-log";

const dir = mkdtempSync(join(tmpdir(), "grantdesk-samples-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sample = (variant: string, ok: boolean): Sample => ({
  variant,
  at: "2026-08-19T00:00:00.000Z",
  case: "budget",
  outcomes: { clean: ok },
});

describe("variantOf", () => {
  it("is stable for the same prompt and model", () => {
    expect(variantOf(["prompt", "model"])).toBe(variantOf(["prompt", "model"]));
  });

  it("changes when the prompt changes", () => {
    // The whole safety property: editing a prompt must start a fresh sample
    // rather than averaging the old behaviour into the new. Pooling across an
    // edit would make every change look like a small improvement.
    expect(variantOf(["prompt a", "model"])).not.toBe(variantOf(["prompt b", "model"]));
  });

  it("changes when the model changes", () => {
    expect(variantOf(["prompt", "model a"])).not.toBe(variantOf(["prompt", "model b"]));
  });
});

describe("read", () => {
  it("returns only samples from the variant asked for", () => {
    const path = join(dir, "mixed.jsonl");
    append(path, sample("aaa", true));
    append(path, sample("bbb", false));
    append(path, sample("aaa", false));

    const mine = read(path, "aaa");
    expect(mine).toHaveLength(2);
    expect(mine.every((s) => s.variant === "aaa")).toBe(true);
  });

  it("has nothing to say about a file that does not exist yet", () => {
    expect(read(join(dir, "absent.jsonl"), "aaa")).toEqual([]);
  });

  it("survives a truncated final line from an interrupted run", () => {
    const path = join(dir, "torn.jsonl");
    append(path, sample("aaa", true));
    // Simulate a run killed mid-write.
    append(path, { ...sample("aaa", true), at: "x" });
    expect(read(path, "aaa").length).toBeGreaterThanOrEqual(2);
  });
});

describe("rateOf", () => {
  it("reports the proportion and how sure it is", () => {
    const samples = [sample("v", true), sample("v", true), sample("v", false), sample("v", true)];
    const rate = rateOf(samples, "clean");
    expect(rate.ok).toBe(3);
    expect(rate.total).toBe(4);
    expect(rate.rate).toBe(0.75);
    // Four samples say almost nothing, and the interval has to admit that.
    expect(rate.high - rate.low).toBeGreaterThan(0.5);
  });

  it("narrows as the sample grows", () => {
    const few = rateOf(
      Array.from({ length: 8 }, (_, i) => sample("v", i < 6)),
      "clean",
    );
    const many = rateOf(
      Array.from({ length: 80 }, (_, i) => sample("v", i < 60)),
      "clean",
    );
    // Same 75%, very different claims.
    expect(many.rate).toBeCloseTo(few.rate, 2);
    expect(many.high - many.low).toBeLessThan(few.high - few.low);
  });

  it("ignores samples that never measured the property", () => {
    const other: Sample = { ...sample("v", true), outcomes: { somethingElse: true } };
    expect(rateOf([other], "clean").total).toBe(0);
  });
});

describe("verdictFor", () => {
  it("refuses to judge a sample too small to judge", () => {
    // Better than passing or failing by accident, which is what a bare
    // percentage from eight drafts does.
    const rate = rateOf(
      Array.from({ length: 5 }, () => sample("v", false)),
      "clean",
    );
    expect(verdictFor(rate, 0.9, 20)).toBe("unknown");
  });

  it("fails only when the whole interval sits below the floor", () => {
    const rate = rateOf(
      Array.from({ length: 40 }, (_, i) => sample("v", i < 10)),
      "clean",
    );
    expect(rate.high).toBeLessThan(0.9);
    expect(verdictFor(rate, 0.9, 20)).toBe("fail");
  });

  it("passes while the floor is still plausible", () => {
    const rate = rateOf(
      Array.from({ length: 40 }, (_, i) => sample("v", i < 38)),
      "clean",
    );
    expect(verdictFor(rate, 0.9, 20)).toBe("pass");
  });
});

describe("describe", () => {
  it("shows the count and interval, never a bare percentage", () => {
    const text = describeRate(rateOf([sample("v", true), sample("v", false)], "clean"));
    expect(text).toContain("1/2");
    expect(text).toContain("95% CI");
  });
});
