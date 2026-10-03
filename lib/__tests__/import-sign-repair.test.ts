import { describe, it, expect } from "vitest";
import {
  absCentsKey,
  negateAmount,
  detectSingleSign,
  isDebitOnlyImportAccount,
  planImportSignRepair,
  type RepairImportRow,
  type RepairPlaidRow,
} from "@/lib/import-sign-repair";

const imp = (id: string, day: string, amount: string, over: Partial<RepairImportRow> = {}): RepairImportRow => ({
  id,
  postedAt: `${day}T00:00:00.000Z`,
  amount,
  tagIds: [],
  projectId: null,
  hasLinks: false,
  ...over,
});
const plaid = (
  id: string,
  day: string,
  amount: string,
  tagIds: string[] = [],
  projectId: string | null = null
): RepairPlaidRow => ({
  id,
  postedAt: `${day}T00:00:00.000Z`,
  amount,
  tagIds,
  projectId,
});

describe("absCentsKey", () => {
  it("ignores sign and trailing-zero formatting", () => {
    expect(absCentsKey("-92.54")).toBe("9254");
    expect(absCentsKey("92.54")).toBe("9254");
    expect(absCentsKey("10")).toBe("1000");
    expect(absCentsKey("10.00")).toBe("1000");
    expect(absCentsKey("-7.5")).toBe("750");
    expect(absCentsKey("0.75")).toBe("75");
    expect(absCentsKey("0")).toBe("0");
  });
});

describe("negateAmount", () => {
  it("flips sign without touching digits", () => {
    expect(negateAmount("12.30")).toBe("-12.30");
    expect(negateAmount("-5")).toBe("5");
    expect(negateAmount("+8.60")).toBe("-8.60");
    expect(negateAmount("0.00")).toBe("0.00");
  });
});

describe("detectSingleSign", () => {
  const many = (a: string, n = 12) => Array.from({ length: n }, () => a);
  it("flags an all-positive file", () => {
    expect(detectSingleSign(many("10.00"))).toBe("positive");
  });
  it("flags an all-negative file", () => {
    expect(detectSingleSign(many("-10.00"))).toBe("negative");
  });
  it("is quiet for mixed files", () => {
    expect(detectSingleSign([...many("10.00"), "-3.00"])).toBeNull();
  });
  it("is quiet for tiny files where one sign is coincidence", () => {
    expect(detectSingleSign(many("10.00", 3))).toBeNull();
  });
  it("ignores zero amounts", () => {
    expect(detectSingleSign([...many("10.00"), "0.00"])).toBe("positive");
  });
});

describe("isDebitOnlyImportAccount", () => {
  const pos = Array.from({ length: 12 }, () => "5.00");
  it("matches a checking account with only positive imports", () => {
    expect(isDebitOnlyImportAccount("checking", pos)).toBe(true);
  });
  it("rejects when any import is an outflow", () => {
    expect(isDebitOnlyImportAccount("checking", [...pos, "-1.00"])).toBe(false);
  });
  it("rejects credit cards, where all-positive can be legitimate", () => {
    expect(isDebitOnlyImportAccount("credit_card", pos)).toBe(false);
  });
  it("rejects accounts with too few rows", () => {
    expect(isDebitOnlyImportAccount("checking", ["5.00"])).toBe(false);
  });
});

describe("planImportSignRepair", () => {
  it("flips every positive import row, with no overlap when Plaid has nothing", () => {
    const plan = planImportSignRepair([imp("a", "2025-06-01", "9.99"), imp("b", "2025-06-02", "5")], []);
    expect(plan.negateIds).toEqual(["a", "b"]);
    expect(plan.overlap).toEqual([]);
  });

  it("pairs an import row with a Plaid outflow on the same day and |amount|", () => {
    const plan = planImportSignRepair(
      [imp("i1", "2026-04-14", "7.99")],
      [plaid("p1", "2026-04-14", "-7.99")]
    );
    expect(plan.overlap).toEqual([{ importId: "i1", keptId: "p1", tagIdsToCopy: [], projectIdToCopy: null }]);
    expect(plan.negateIds).toEqual(["i1"]);
  });

  it("does not match different days or amounts", () => {
    const plan = planImportSignRepair(
      [imp("i1", "2026-04-14", "7.99"), imp("i2", "2026-04-15", "7.99")],
      [plaid("p1", "2026-04-14", "-8.00"), plaid("p2", "2026-04-16", "-7.99")]
    );
    expect(plan.overlap).toEqual([]);
  });

  it("ignores Plaid inflows when matching", () => {
    const plan = planImportSignRepair(
      [imp("i1", "2026-04-14", "50")],
      [plaid("p1", "2026-04-14", "50.00")]
    );
    expect(plan.overlap).toEqual([]);
  });

  it("is multiplicity-aware: two identical import rows vs one Plaid row archives only one", () => {
    const plan = planImportSignRepair(
      [imp("i1", "2026-04-14", "10"), imp("i2", "2026-04-14", "10")],
      [plaid("p1", "2026-04-14", "-10")]
    );
    expect(plan.overlap).toHaveLength(1);
    expect(plan.negateIds).toHaveLength(2);
  });

  it("copies tags only when the Plaid row has none", () => {
    const plan = planImportSignRepair(
      [
        imp("i1", "2026-04-14", "10", { tagIds: ["groceries"] }),
        imp("i2", "2026-04-15", "20", { tagIds: ["gas"] }),
      ],
      [plaid("p1", "2026-04-14", "-10", []), plaid("p2", "2026-04-15", "-20", ["fuel"])]
    );
    expect(plan.overlap.find((o) => o.importId === "i1")?.tagIdsToCopy).toEqual(["groceries"]);
    expect(plan.overlap.find((o) => o.importId === "i2")?.tagIdsToCopy).toEqual([]);
  });

  it("flips but does not archive matched rows that carry links", () => {
    const plan = planImportSignRepair(
      [imp("i1", "2026-04-14", "10", { hasLinks: true })],
      [plaid("p1", "2026-04-14", "-10")]
    );
    expect(plan.overlap).toEqual([]);
    expect(plan.linkedOverlapIds).toEqual(["i1"]);
    expect(plan.negateIds).toEqual(["i1"]);
  });

  it("moves a project onto the Plaid row when it has none, then archives", () => {
    const plan = planImportSignRepair(
      [imp("i1", "2026-06-16", "30.58", { projectId: "barn" })],
      [plaid("p1", "2026-06-16", "-30.58")]
    );
    expect(plan.overlap).toEqual([
      { importId: "i1", keptId: "p1", tagIdsToCopy: [], projectIdToCopy: "barn" },
    ]);
    expect(plan.linkedOverlapIds).toEqual([]);
  });

  it("archives with no project copy when the Plaid row already has the same project", () => {
    const plan = planImportSignRepair(
      [imp("i1", "2026-06-16", "30.58", { projectId: "barn" })],
      [plaid("p1", "2026-06-16", "-30.58", [], "barn")]
    );
    expect(plan.overlap[0]?.projectIdToCopy).toBeNull();
  });

  it("leaves a row active when its project conflicts with the Plaid row's project", () => {
    const plan = planImportSignRepair(
      [imp("i1", "2026-06-16", "30.58", { projectId: "barn" })],
      [plaid("p1", "2026-06-16", "-30.58", [], "kitchen")]
    );
    expect(plan.overlap).toEqual([]);
    expect(plan.linkedOverlapIds).toEqual(["i1"]);
    expect(plan.negateIds).toEqual(["i1"]);
  });

  it("ignores import rows that are already outflows (idempotent on re-run)", () => {
    const plan = planImportSignRepair([imp("i1", "2026-04-14", "-10")], [plaid("p1", "2026-04-14", "-10")]);
    expect(plan.negateIds).toEqual([]);
    expect(plan.overlap).toEqual([]);
  });
});
