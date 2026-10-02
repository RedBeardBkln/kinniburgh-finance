import { describe, it, expect } from "vitest";
import {
  MIN_RULE_PATTERN_ALNUM,
  batchProgress,
  classifyQueueItem,
  findSimilarItems,
  isBatchComplete,
  isUsableRulePattern,
  ruleSkippedNote,
  type QueueItemCandidate,
} from "@/lib/review-queue";

const PERSONAL = "e0000000-0000-4000-8000-000000000001";
const SV = "e0000000-0000-4000-8000-000000000002";
const EKC = "e0000000-0000-4000-8000-000000000003";
const allowed = new Set([PERSONAL, SV]);

function item(over: Partial<QueueItemCandidate> = {}): QueueItemCandidate {
  return {
    assignmentStatus: "pending",
    archivedAt: null,
    transferPairId: null,
    tagCount: 0,
    entityId: PERSONAL,
    ...over,
  };
}

describe("classifyQueueItem", () => {
  it("shows a normal pending, untagged, active item (Personal and Sudden Valley)", () => {
    expect(classifyQueueItem(item(), allowed)).toBe("show");
    expect(classifyQueueItem(item({ entityId: SV }), allowed)).toBe("show");
  });
  it("drops items that are no longer pending", () => {
    for (const s of ["resolved", "returned", "removed"]) {
      expect(classifyQueueItem(item({ assignmentStatus: s }), allowed)).toBe("not_pending");
    }
  });
  it("drops items tagged since assignment (by Eric, the auto-tag cron, or a new rule)", () => {
    expect(classifyQueueItem(item({ tagCount: 1 }), allowed)).toBe("already_tagged");
  });
  it("drops archived and transfer-leg transactions", () => {
    expect(classifyQueueItem(item({ archivedAt: new Date() }), allowed)).toBe("archived");
    expect(classifyQueueItem(item({ transferPairId: "pair" }), allowed)).toBe("transfer_leg");
  });
  it("never shows an item outside the assignable entities (defense in depth)", () => {
    expect(classifyQueueItem(item({ entityId: EKC }), allowed)).toBe("wrong_entity");
    expect(classifyQueueItem(item({ entityId: null }), allowed)).toBe("wrong_entity");
    expect(classifyQueueItem(item({ entityId: undefined }), allowed)).toBe("wrong_entity");
    expect(classifyQueueItem(item(), new Set())).toBe("wrong_entity"); // fails closed
  });
  it("checks status first, then entity, then archived/transfer/tagged", () => {
    expect(
      classifyQueueItem(item({ assignmentStatus: "resolved", entityId: EKC, tagCount: 2 }), allowed)
    ).toBe("not_pending");
    expect(classifyQueueItem(item({ entityId: EKC, tagCount: 2 }), allowed)).toBe("wrong_entity");
  });
});

describe("isBatchComplete / batchProgress", () => {
  it("is complete only when no item is still shown (empty counts as complete)", () => {
    expect(isBatchComplete([])).toBe(true);
    expect(isBatchComplete(["already_tagged", "not_pending", "archived"])).toBe(true);
    expect(isBatchComplete(["already_tagged", "show"])).toBe(false);
  });
  it("counts resolved/returned/pending and ignores removed", () => {
    expect(batchProgress(["resolved", "resolved", "returned", "pending", "removed"])).toEqual({
      total: 4,
      resolved: 2,
      returned: 1,
      pending: 1,
    });
    expect(batchProgress([])).toEqual({ total: 0, resolved: 0, returned: 0, pending: 0 });
  });
});

describe("isUsableRulePattern", () => {
  it("requires at least MIN_RULE_PATTERN_ALNUM alphanumeric characters", () => {
    expect(MIN_RULE_PATTERN_ALNUM).toBe(3);
    expect(isUsableRulePattern("abc")).toBe(true);
    expect(isUsableRulePattern("Lowe's")).toBe(true);
    expect(isUsableRulePattern("ab")).toBe(false);
    expect(isUsableRulePattern("")).toBe(false);
    expect(isUsableRulePattern("   ")).toBe(false);
    // Punctuation-only would alnum-strip to "" and match EVERY payee in matchTagRule.
    expect(isUsableRulePattern("--- ...")).toBe(false);
    expect(isUsableRulePattern("a-b")).toBe(false);
  });
});

describe("findSimilarItems", () => {
  const items = [
    { id: "1", payee: "SHELL OIL 12345", amount: 40, accountId: "a" },
    { id: "2", payee: "Shell Oil", amount: 55.5, accountId: "b" },
    { id: "3", payee: "shell-oil #99", amount: 10, accountId: "a" },
    { id: "4", payee: "Whole Foods", amount: 80, accountId: "a" },
    { id: "5", payee: "", amount: 5, accountId: "a" },
  ];
  it("matches with matchTagRule semantics: case/punctuation-insensitive contains", () => {
    expect(findSimilarItems("shell oil", items, "1")).toEqual(["2", "3"]);
    expect(findSimilarItems("SHELL-OIL", items, "1")).toEqual(["2", "3"]);
  });
  it("never includes the source item and ignores non-matching payees", () => {
    expect(findSimilarItems("whole foods", items, "4")).toEqual([]);
    expect(findSimilarItems("shell", items, "2")).toEqual(["1", "3"]);
  });
  it("returns nothing for an unusable (too short / punctuation-only) pattern", () => {
    expect(findSimilarItems("", items, "1")).toEqual([]);
    expect(findSimilarItems("sh", items, "1")).toEqual([]);
    expect(findSimilarItems("---", items, "1")).toEqual([]);
  });
});

describe("ruleSkippedNote", () => {
  it("explains a pure duplicate differently from an overlap", () => {
    expect(ruleSkippedNote(["duplicate"])).toMatch(/already exists/);
    expect(ruleSkippedNote(["duplicate", "duplicate"])).toMatch(/already exists/);
    expect(ruleSkippedNote(["competing"])).toMatch(/overlaps an existing rule/);
    expect(ruleSkippedNote(["duplicate", "overlapping"])).toMatch(/overlaps an existing rule/);
    expect(ruleSkippedNote([])).toMatch(/overlaps an existing rule/);
  });
});
