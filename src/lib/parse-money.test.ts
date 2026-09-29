import { describe, expect, it } from "vitest";
import { parseMoney } from "./parse-money";

describe("parseMoney", () => {
  it("reads the ways a consultant writes an amount", () => {
    expect(parseMoney("50000")).toBe(50000);
    expect(parseMoney("$50,000")).toBe(50000);
    expect(parseMoney("CAD 75,000")).toBe(75000);
    expect(parseMoney("50k")).toBe(50000);
    expect(parseMoney("1.5M")).toBe(1_500_000);
    expect(parseMoney("12500.50")).toBe(12500.5);
  });

  it("treats an empty field as no value", () => {
    expect(parseMoney("  ")).toBeNull();
  });

  it("refuses what it cannot read rather than guessing", () => {
    expect(parseMoney("1.000,50")).toBeNaN();
    expect(parseMoney("about fifty")).toBeNaN();
    expect(parseMoney("5,00")).toBeNaN();
  });
});
