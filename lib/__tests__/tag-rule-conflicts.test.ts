import { describe, it, expect } from "vitest";
import { findRuleConflicts, ruleMatchesSearch, type RuleShape } from "../tag-rule-conflicts";

function rule(overrides: Partial<RuleShape> = {}): RuleShape {
  return {
    id: "r1",
    payeePattern: "lowes",
    tagId: "tag-a",
    amountMin: null,
    amountMax: null,
    accountId: null,
    accountIds: null,
    ...overrides,
  };
}

describe("findRuleConflicts", () => {
  it("flags an identical rule as a duplicate", () => {
    const res = findRuleConflicts(rule({ id: undefined }), [rule()]);
    expect(res).toHaveLength(1);
    expect(res[0]!.kind).toBe("duplicate");
  });

  it("treats punctuation/case differences as the same pattern", () => {
    const res = findRuleConflicts(rule({ id: undefined, payeePattern: "Lowe's" }), [rule()]);
    expect(res[0]!.kind).toBe("duplicate");
  });

  it("flags same payee + different tag as competing", () => {
    const res = findRuleConflicts(rule({ id: undefined, tagId: "tag-b" }), [rule()]);
    expect(res).toHaveLength(1);
    expect(res[0]!.kind).toBe("competing");
  });

  it("flags contained patterns with different tags as competing", () => {
    const res = findRuleConflicts(
      rule({ id: undefined, payeePattern: "lowes home improvement", tagId: "tag-b" }),
      [rule()]
    );
    expect(res[0]!.kind).toBe("competing");
  });

  it("flags contained patterns with the same tag as overlapping", () => {
    const res = findRuleConflicts(rule({ id: undefined, payeePattern: "lowes home improvement" }), [rule()]);
    expect(res[0]!.kind).toBe("overlapping");
  });

  it("flags same payee + tag with a different scope as overlapping, not duplicate", () => {
    const res = findRuleConflicts(rule({ id: undefined, amountMin: 10, amountMax: 50 }), [rule()]);
    expect(res[0]!.kind).toBe("overlapping");
  });

  it("ignores unrelated payees", () => {
    expect(findRuleConflicts(rule({ id: undefined, payeePattern: "target" }), [rule()])).toEqual([]);
  });

  it("ignores rules with non-overlapping amount ranges", () => {
    const existing = rule({ amountMin: 0, amountMax: 50, tagId: "tag-b" });
    const cand = rule({ id: undefined, amountMin: 100, amountMax: 200 });
    expect(findRuleConflicts(cand, [existing])).toEqual([]);
  });

  it("treats touching amount boundaries as overlapping (inclusive, like matchTagRule)", () => {
    const existing = rule({ amountMin: 0, amountMax: 50, tagId: "tag-b" });
    const cand = rule({ id: undefined, amountMin: 50, amountMax: 200 });
    expect(findRuleConflicts(cand, [existing])).toHaveLength(1);
  });

  it("ignores rules scoped to disjoint accounts", () => {
    const existing = rule({ accountIds: ["acct-1"], tagId: "tag-b" });
    const cand = rule({ id: undefined, accountIds: ["acct-2"] });
    expect(findRuleConflicts(cand, [existing])).toEqual([]);
  });

  it("treats an any-account rule as overlapping a scoped rule", () => {
    const existing = rule({ accountIds: ["acct-1"], tagId: "tag-b" });
    expect(findRuleConflicts(rule({ id: undefined }), [existing])).toHaveLength(1);
  });

  it("falls back to legacy single accountId", () => {
    const existing = rule({ accountId: "acct-1", tagId: "tag-b" });
    const disjoint = rule({ id: undefined, accountIds: ["acct-2"] });
    const shared = rule({ id: undefined, accountIds: ["acct-1", "acct-2"] });
    expect(findRuleConflicts(disjoint, [existing])).toEqual([]);
    expect(findRuleConflicts(shared, [existing])).toHaveLength(1);
  });

  it("excludes the rule being edited", () => {
    expect(findRuleConflicts(rule(), [rule()], { excludeId: "r1" })).toEqual([]);
  });

  it("sorts duplicates before competing before overlapping", () => {
    const existing = [
      rule({ id: "o", payeePattern: "lowes home", tagId: "tag-a" }),
      rule({ id: "c", tagId: "tag-b" }),
      rule({ id: "d" }),
    ];
    const kinds = findRuleConflicts(rule({ id: undefined }), existing).map((c) => c.kind);
    expect(kinds).toEqual(["duplicate", "competing", "overlapping"]);
  });

  it("treats a null-pattern rule as overlapping any payee", () => {
    const existing = rule({ payeePattern: null, tagId: "tag-b" });
    expect(findRuleConflicts(rule({ id: undefined }), [existing])).toHaveLength(1);
  });
});

describe("ruleMatchesSearch", () => {
  const fields = { payeePattern: "lowe's", tagName: "Home Improvement", accountLabels: ["Chase Checking"] };

  it("matches everything on an empty query", () => {
    expect(ruleMatchesSearch("  ", fields)).toBe(true);
  });
  it("matches payee ignoring punctuation and case", () => {
    expect(ruleMatchesSearch("LOWES", fields)).toBe(true);
  });
  it("matches tag name", () => {
    expect(ruleMatchesSearch("improve", fields)).toBe(true);
  });
  it("matches account nickname", () => {
    expect(ruleMatchesSearch("chase", fields)).toBe(true);
  });
  it("rejects non-matches", () => {
    expect(ruleMatchesSearch("target", fields)).toBe(false);
  });
});
