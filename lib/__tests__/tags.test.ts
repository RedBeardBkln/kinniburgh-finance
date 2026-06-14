import { describe, it, expect } from "vitest";
import { buildTagTree, flattenTagTree, normalizePayee, matchTagRule } from "../tags";

describe("buildTagTree", () => {
  const flat = [
    { id: "1", name: "Food & Drink", shortName: "Food & Drink", parentId: null },
    { id: "2", name: "Food & Drink / Groceries", shortName: "Groceries", parentId: "1" },
    { id: "3", name: "Food & Drink / Restaurants & Bars", shortName: "Restaurants & Bars", parentId: "1" },
    { id: "4", name: "Utilities", shortName: "Utilities", parentId: null },
    { id: "5", name: "Utilities / Mortgage", shortName: "Mortgage", parentId: "4" },
  ];

  it("builds a tree with correct parent-child nesting", () => {
    const tree = buildTagTree(flat);
    expect(tree).toHaveLength(2);
    const foodNode = tree.find((n) => n.id === "1");
    expect(foodNode?.children).toHaveLength(2);
  });

  it("sorts children alphabetically", () => {
    const tree = buildTagTree(flat);
    const foodNode = tree.find((n) => n.id === "1")!;
    expect(foodNode.children[0]!.shortName).toBe("Groceries");
    expect(foodNode.children[1]!.shortName).toBe("Restaurants & Bars");
  });

  it("handles orphaned children gracefully (places them as roots)", () => {
    const withOrphan = [
      ...flat,
      { id: "99", name: "Orphan", shortName: "Orphan", parentId: "nonexistent" },
    ];
    const tree = buildTagTree(withOrphan);
    const roots = tree.map((n) => n.id);
    expect(roots).toContain("99");
  });
});

describe("flattenTagTree", () => {
  it("flattens depth-first", () => {
    const flat = [
      { id: "1", name: "A", shortName: "A", parentId: null },
      { id: "2", name: "A/B", shortName: "B", parentId: "1" },
      { id: "3", name: "A/C", shortName: "C", parentId: "1" },
    ];
    const tree = buildTagTree(flat);
    const flattened = flattenTagTree(tree);
    expect(flattened.map((n) => n.id)).toEqual(["1", "2", "3"]);
  });
});

describe("normalizePayee", () => {
  it("lowercases, strips punctuation, and collapses spaces", () => {
    // "&" becomes a space → "mccthy htng   oil llc" → collapsed → single spaces
    expect(normalizePayee("MCCTHY HTNG & OIL LLC")).toBe("mccthy htng oil llc");
  });

  it("collapses multiple spaces", () => {
    expect(normalizePayee("Whole   Foods")).toBe("whole foods");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizePayee("  Target  ")).toBe("target");
  });

  it("handles empty string", () => {
    expect(normalizePayee("")).toBe("");
  });
});

describe("matchTagRule", () => {
  const rules = [
    { tagId: "grocery-tag", payeePattern: "whole foods", amountMin: null, amountMax: null, accountId: null },
    { tagId: "gas-tag", payeePattern: "bp", amountMin: null, amountMax: null, accountId: "acct-2566" },
    { tagId: "small-purchase-tag", payeePattern: null, amountMin: 1, amountMax: 10, accountId: null },
  ];

  it("matches by exact payee pattern", () => {
    expect(
      matchTagRule(rules, { normalizedPayee: "whole foods", amount: 85, accountId: "acct-2566" })
    ).toBe("grocery-tag");
  });

  it("matches by payee prefix", () => {
    expect(
      matchTagRule(rules, { normalizedPayee: "whole foods market 123", amount: 85, accountId: "acct-2566" })
    ).toBe("grocery-tag");
  });

  it("matches by amount range when no payee pattern", () => {
    expect(
      matchTagRule(rules, { normalizedPayee: "unknown vendor", amount: 5, accountId: "acct-x" })
    ).toBe("small-purchase-tag");
  });

  it("prefers payee+account match over payee-only match", () => {
    // Both gas-tag (payee+account) and a hypothetical payee-only rule compete
    const extendedRules = [
      ...rules,
      { tagId: "generic-bp-tag", payeePattern: "bp", amountMin: null, amountMax: null, accountId: null },
    ];
    expect(
      matchTagRule(extendedRules, { normalizedPayee: "bp", amount: 50, accountId: "acct-2566" })
    ).toBe("gas-tag"); // account-specific wins
  });

  it("returns null when no rule matches", () => {
    expect(
      matchTagRule(rules, { normalizedPayee: "mystery payee", amount: 500, accountId: "acct-x" })
    ).toBeNull();
  });
});
