import { describe, it, expect } from "vitest";
import { restoreQueueChoices, serializeQueueChoices, waitingByAddedDay } from "@/lib/review-queue";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const TAG = "33333333-3333-4333-8333-333333333333";

describe("waitingByAddedDay", () => {
  it("groups only pending items by the New York day they were added, newest first", () => {
    const groups = waitingByAddedDay([
      { status: "pending", createdAt: new Date("2026-10-07T19:47:00Z") },
      { status: "pending", createdAt: new Date("2026-10-29T22:56:00Z") },
      { status: "pending", createdAt: new Date("2026-10-29T22:58:00Z") },
      // 01:30 UTC on Oct 16 is still Oct 15 in New York.
      { status: "pending", createdAt: new Date("2026-10-16T01:30:00Z") },
      { status: "resolved", createdAt: new Date("2026-10-29T22:57:00Z") },
      { status: "returned", createdAt: new Date("2026-10-15T12:00:00Z") },
    ]);
    expect(groups).toEqual([
      { day: "2026-10-29", count: 2 },
      { day: "2026-10-15", count: 1 },
      { day: "2026-10-07", count: 1 },
    ]);
  });

  it("is empty when nothing is waiting", () => {
    expect(waitingByAddedDay([{ status: "resolved", createdAt: new Date() }])).toEqual([]);
  });
});

describe("restoreQueueChoices", () => {
  const items = new Set([A, B]);
  const tags = new Set([TAG]);

  it("restores valid choices for items still on the page", () => {
    const raw = JSON.stringify({ [A]: { tagId: TAG, ruleOn: true, pattern: "home depot" } });
    expect(restoreQueueChoices(raw, items, tags)).toEqual({ [A]: { tagId: TAG, ruleOn: true, pattern: "home depot" } });
  });

  it("drops items no longer on the page, unknown tags and malformed entries", () => {
    const raw = JSON.stringify({
      [A]: { tagId: "not-a-tag" },
      "99999999-9999-4999-8999-999999999999": { tagId: TAG },
      [B]: "nonsense",
    });
    expect(restoreQueueChoices(raw, items, tags)).toEqual({});
    expect(restoreQueueChoices("{not json", items, tags)).toEqual({});
    expect(restoreQueueChoices("[1,2]", items, tags)).toEqual({});
    expect(restoreQueueChoices(null, items, tags)).toEqual({});
  });

  it("defaults the rule fields and round-trips through serialize", () => {
    const restored = restoreQueueChoices(JSON.stringify({ [B]: { tagId: TAG } }), items, tags);
    expect(restored).toEqual({ [B]: { tagId: TAG, ruleOn: false, pattern: "" } });
    expect(restoreQueueChoices(serializeQueueChoices(restored), items, tags)).toEqual(restored);
    expect(serializeQueueChoices({})).toBeNull();
  });
});
