import { describe, expect, it } from "vitest";
import {
  assignmentSuffix,
  dueGroup,
  memberName,
  nextAssignment,
  unsignedChecks,
  type Assignment,
} from "./assignments";

const TODAY = new Date("2026-09-29T16:00:00Z");

const a = (over: Partial<Assignment>): Assignment => ({
  requirementId: "r",
  ownerId: null,
  dueOn: null,
  doneAt: null,
  ...over,
});

describe("dueGroup", () => {
  it("puts a call whose deadline passed under closed, whatever the internal date", () => {
    expect(dueGroup("2026-09-01", "2026-10-30", TODAY)).toBe("closed");
  });
  it("calls a slipped internal date overdue even when the funder is weeks away", () => {
    expect(dueGroup("2026-11-30", "2026-09-20", TODAY)).toBe("overdue");
  });
  it("uses the nearer of the two dates for this week", () => {
    expect(dueGroup("2026-11-30", "2026-10-02", TODAY)).toBe("this_week");
    expect(dueGroup("2026-10-03", null, TODAY)).toBe("this_week");
  });
  it("leaves undated and distant work under later", () => {
    expect(dueGroup(null, null, TODAY)).toBe("later");
    expect(dueGroup("2026-12-01", "2026-11-01", TODAY)).toBe("later");
  });
});

describe("nextAssignment", () => {
  const list = [
    a({ requirementId: "1", ownerId: "maria", dueOn: "2026-10-10" }),
    a({ requirementId: "2", ownerId: "sam", dueOn: "2026-10-05" }),
    a({ requirementId: "3", ownerId: "sam", dueOn: "2026-10-01", doneAt: "2026-09-28" }),
    a({ requirementId: "4", ownerId: "maria", dueOn: null }),
  ];
  it("skips done and undated work", () => {
    expect(nextAssignment(list)?.requirementId).toBe("2");
  });
  it("can be narrowed to one owner", () => {
    expect(nextAssignment(list, "maria")?.requirementId).toBe("1");
    expect(nextAssignment(list, "nobody")).toBeNull();
  });
});

describe("assignmentSuffix", () => {
  it("names owner and date", () => {
    expect(assignmentSuffix("Maria", "2026-10-03")).toBe(" (owner Maria, due 2026-10-03)");
  });
  it("says what is missing when only one is set", () => {
    expect(assignmentSuffix(null, "2026-10-03")).toBe(" (no owner, due 2026-10-03)");
    expect(assignmentSuffix("Maria", null)).toBe(" (owner Maria, no internal due date)");
  });
  it("adds nothing when nothing is assigned", () => {
    expect(assignmentSuffix(null, null)).toBe("");
  });
});

describe("memberName", () => {
  it("prefers a display name and falls back to the email", () => {
    expect(memberName({ email: "m@x.ca", displayName: "Maria" })).toBe("Maria");
    expect(memberName({ email: "m@x.ca", displayName: "  " })).toBe("m@x.ca");
  });
});

describe("unsignedChecks", () => {
  it("refuses a verification date with nobody behind it", () => {
    expect(
      unsignedChecks({
        "cash match": [null, "2026-09-20"],
        capacity: ["Dana", "2026-09-21"],
        other: [null, null],
      }),
    ).toEqual(["cash match"]);
  });
});
