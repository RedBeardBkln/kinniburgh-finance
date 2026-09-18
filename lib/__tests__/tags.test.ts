import { describe, it, expect } from "vitest";
import { buildTagTree, flattenTagTree, normalizePayee, normalizePattern, matchTagRule, suggestPayeePattern } from "../tags";

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

describe("normalizePattern", () => {
  it("preserves symbols like apostrophes and ampersands", () => {
    expect(normalizePattern("Lowe's")).toBe("lowe's");
    expect(normalizePattern("Stop & Shop")).toBe("stop & shop");
  });

  it("lowercases and collapses whitespace without stripping symbols", () => {
    expect(normalizePattern("  Trader   Joe's  ")).toBe("trader joe's");
  });

  it("handles empty string", () => {
    expect(normalizePattern("")).toBe("");
  });
});

describe("suggestPayeePattern", () => {
  it("truncates before a ' - ' separator followed by a phone number", () => {
    expect(suggestPayeePattern("xfinity mobile - 888-936-4968 pa")).toBe("xfinity mobile");
  });

  it("truncates before a ' - ' separator followed by a statement-specific date range", () => {
    expect(suggestPayeePattern("interest earned credit - interest period 2025-07-28 ~ 2025-08-27")).toBe(
      "interest earned credit"
    );
  });

  it("truncates before a bare run of 3+ digits even without a ' - ' separator", () => {
    expect(suggestPayeePattern("xfinity mobile 888 936 4968 pa")).toBe("xfinity mobile");
  });

  it("truncates before an ISO-shaped date", () => {
    expect(suggestPayeePattern("payment ref 2025-07-28 confirmation")).toBe("payment ref");
  });

  it("leaves an already-short, generic payee untouched", () => {
    expect(suggestPayeePattern("whole foods")).toBe("whole foods");
    expect(suggestPayeePattern("capital one-crcardpmt")).toBe("capital one-crcardpmt");
  });

  it("falls back to the original string when truncation would leave under 3 characters", () => {
    expect(suggestPayeePattern("bp - 888-936-4968")).toBe("bp - 888-936-4968");
  });

  it("handles empty string", () => {
    expect(suggestPayeePattern("")).toBe("");
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

  it("matches case-insensitively even when normalizedPayee isn't actually lowercased", () => {
    // Regression: alnum() used to only keep [a-z0-9], silently dropping every
    // uppercase letter instead of matching case-insensitively. This bit real
    // data — bank-statement-imported transactions stored payeeNormalized as a
    // raw, un-lowercased copy of payeeRaw (fixed separately in
    // actions/documents.ts), and for those rows this stripped every
    // capitalized word's leading letter, so "Whole Foods Market" matching a
    // "whole foods" rule silently failed.
    expect(
      matchTagRule(rules, { normalizedPayee: "Whole Foods Market 123", amount: 85, accountId: "acct-2566" })
    ).toBe("grocery-tag");
  });

  it("matches a symbol-containing pattern against a longer payee (Lowe's example)", () => {
    const symbolRules = [
      { tagId: "home-tag", payeePattern: "lowe's", amountMin: null, amountMax: null, accountId: null },
    ];
    expect(
      matchTagRule(symbolRules, {
        normalizedPayee: normalizePayee("Lowe's Home Goods LLC"),
        amount: 42,
        accountId: "acct-x",
      })
    ).toBe("home-tag");
  });

  it("matches via contains when pattern is in the middle of the payee", () => {
    const symbolRules = [
      { tagId: "grocery-tag", payeePattern: "stop & shop", amountMin: null, amountMax: null, accountId: null },
    ];
    expect(
      matchTagRule(symbolRules, {
        normalizedPayee: normalizePayee("POS DEBIT STOP & SHOP #1234"),
        amount: 30,
        accountId: "acct-x",
      })
    ).toBe("grocery-tag");
  });
});
