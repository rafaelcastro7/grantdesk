import { describe, expect, it } from "vitest";
import {
  feedEvents,
  generateCalendarToken,
  hashCalendarToken,
  isInProgress,
  isWellFormedToken,
  type FeedRow,
} from "./calendar-feed";

const base: FeedRow = {
  id: "p1",
  client_id: "c1",
  grant_id: "g1",
  clientName: "Acme",
  title: "Clean Fund",
  deadline: "2026-11-01",
  estimatedDeadline: null,
  decision: null,
  submissions: [],
  proposal_sections: [{}],
};

describe("isInProgress", () => {
  it("follows the What is due rules", () => {
    expect(isInProgress(base)).toBe(true);
    expect(isInProgress({ ...base, proposal_sections: [] })).toBe(false);
    expect(isInProgress({ ...base, proposal_sections: [], decision: "pending" })).toBe(true);
    expect(isInProgress({ ...base, decision: "no_go" })).toBe(false);
    expect(isInProgress({ ...base, submissions: [{}] })).toBe(false);
  });
});

describe("feedEvents", () => {
  it("uses the real deadline and links to the proposal", () => {
    expect(feedEvents([base], "https://x.app")).toEqual([
      {
        uid: "p1",
        title: "Clean Fund",
        client: "Acme",
        deadline: "2026-11-01",
        url: "https://x.app/clients/c1/proposals/g1",
      },
    ]);
  });

  it("labels a forecast's estimated date and never passes it off as a deadline", () => {
    const [event] = feedEvents(
      [{ ...base, deadline: null, estimatedDeadline: "2027-01-15" }],
      "https://x.app",
    );
    expect(event).toMatchObject({ title: "Clean Fund (estimate)", deadline: "2027-01-15" });
    expect(event!.note).toMatch(/Not a deadline/);
  });

  it("skips work that is not in progress or has no date", () => {
    expect(
      feedEvents(
        [
          { ...base, decision: "no_go" },
          { ...base, id: "p2", deadline: null },
        ],
        "https://x.app",
      ),
    ).toEqual([]);
  });
});

describe("tokens", () => {
  it("are 43 url-safe characters and hash to sha256 hex", async () => {
    const token = generateCalendarToken();
    expect(isWellFormedToken(token)).toBe(true);
    expect(generateCalendarToken()).not.toBe(token);
    expect(await hashCalendarToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(isWellFormedToken("../../etc")).toBe(false);
  });
});
