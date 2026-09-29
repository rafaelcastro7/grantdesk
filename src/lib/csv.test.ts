import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";

describe("csvCell", () => {
  it.each(["=HYPERLINK(1)", "+1", "-2", "@SUM(A1)", "\tx", "\rx"])(
    "neutralises a leading formula character in %j",
    (value) => {
      expect(csvCell(value)).toBe(`"'${value}"`);
    },
  );

  it("quotes and escapes embedded quotes", () => {
    expect(csvCell('Say "hi", then go')).toBe('"Say ""hi"", then go"');
  });

  it("writes null and undefined as empty, numbers as text", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(50000)).toBe('"50000"');
  });

  it("leaves a formula character that is not leading alone", () => {
    expect(csvCell("a=b")).toBe('"a=b"');
  });
});

describe("toCsv", () => {
  it("joins cells with commas and rows with newlines", () => {
    expect(
      toCsv([
        ["a", "b"],
        ["=c", 1],
      ]),
    ).toBe('"a","b"\n"\'=c","1"');
  });
});
