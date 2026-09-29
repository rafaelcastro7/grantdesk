import { describe, expect, it } from "vitest";
import { documentStatus, effectiveExpiry } from "./client-documents";

const TODAY = new Date("2026-09-29T12:00:00Z");

describe("effective expiry", () => {
  it("treats financial statements as stale 18 months after issue", () => {
    expect(
      effectiveExpiry({ kind: "financial_statements", issued_on: "2025-03-31", expires_on: null }),
    ).toBe("2026-09-30");
  });

  it("gives insurance twelve months", () => {
    expect(
      effectiveExpiry({ kind: "insurance_certificate", issued_on: "2025-10-15", expires_on: null }),
    ).toBe("2026-10-15");
  });

  it("lets a typed expiry override the default", () => {
    expect(
      effectiveExpiry({
        kind: "insurance_certificate",
        issued_on: "2020-01-01",
        expires_on: "2027-06-30",
      }),
    ).toBe("2027-06-30");
  });

  it("clamps to the end of a shorter month", () => {
    expect(
      effectiveExpiry({ kind: "annual_report", issued_on: "2024-08-31", expires_on: null }),
    ).toBe("2026-02-28");
  });
});

describe("status", () => {
  it("is expired past its expiry", () => {
    expect(
      documentStatus(
        { kind: "financial_statements", issued_on: "2024-12-31", expires_on: null },
        TODAY,
      ),
    ).toBe("expired");
  });

  it("is expiring within 60 days", () => {
    expect(
      documentStatus(
        { kind: "insurance_certificate", issued_on: null, expires_on: "2026-11-20" },
        TODAY,
      ),
    ).toBe("expiring");
  });

  it("is current beyond 60 days", () => {
    expect(
      documentStatus({ kind: "board_list", issued_on: "2026-09-01", expires_on: null }, TODAY),
    ).toBe("current");
  });

  it("is current for a dated kind that does not age", () => {
    expect(
      documentStatus({ kind: "incorporation", issued_on: "1998-05-01", expires_on: null }, TODAY),
    ).toBe("current");
  });

  it("is undated when nothing dates it, rather than claiming current", () => {
    expect(
      documentStatus({ kind: "financial_statements", issued_on: null, expires_on: null }, TODAY),
    ).toBe("undated");
    expect(
      documentStatus({ kind: "incorporation", issued_on: null, expires_on: null }, TODAY),
    ).toBe("undated");
  });
});
