import { describe, expect, it } from "vitest";
import { buildBudgetTreeGroups, compareByShortName, rowLabel, visibleRows, type TreeLineInput } from "@/lib/dashboard-budget-tree";
import { nestBudgetLines } from "@/lib/budget-nesting";

const PARENT: Record<string, string | null> = {
  food: null,
  groceries: "food",
  restaurants: "food",
  coffee: "restaurants",
  utilities: null,
  electric: "utilities",
  pets: null,
};
const SHORT: Record<string, string> = { food: "Food & Drink", groceries: "Groceries", restaurants: "Restaurants", coffee: "Coffee", utilities: "Utilities", electric: "Electric", pets: "Pet" };
const FULL: Record<string, string> = {
  food: "Food & Drink",
  groceries: "Food & Drink / Groceries",
  restaurants: "Food & Drink / Restaurants",
  coffee: "Food & Drink / Restaurants / Coffee",
  utilities: "Utilities",
  electric: "Utilities / Electric",
  pets: "Pet",
};
const parentOf = (id: string) => PARENT[id] ?? null;
const line = (tagId: string, accountId: string, accountName: string): TreeLineInput => ({
  id: "L-" + tagId + "-" + accountId,
  tagId,
  accountId,
  accountName,
  shortName: SHORT[tagId]!,
  fullName: FULL[tagId]!,
});

describe("dashboard budget tree", () => {
  const lines = [
    line("coffee", "A", "Primary Checking"),
    line("pets", "A", "Primary Checking"),
    line("food", "A", "Primary Checking"),
    line("restaurants", "A", "Primary Checking"),
    line("groceries", "A", "Primary Checking"),
    line("electric", "B", "Heating & Electric"),
    line("utilities", "B", "Heating & Electric"),
  ];
  const groups = buildBudgetTreeGroups(lines, parentOf);

  it("groups by account, accounts in name order", () => {
    expect(groups.map((g) => g.accountName)).toEqual(["Heating & Electric", "Primary Checking"]);
  });

  it("orders and nests exactly as /budgets does (nestBudgetLines with the short-name comparator)", () => {
    const primary = groups.find((g) => g.accountId === "A")!;
    const expected = nestBudgetLines(lines.filter((l) => l.accountId === "A"), parentOf, compareByShortName);
    expect(primary.rows.map((r) => [r.line.id, r.depth])).toEqual(expected.map((r) => [r.line.id, r.depth]));
    // parent above children, children indented, grandchild one deeper
    expect(primary.rows.map((r) => `${r.depth}:${r.line.shortName}`)).toEqual(["0:Food & Drink", "1:Groceries", "1:Restaurants", "2:Coffee", "0:Pet"]);
  });

  it("knows each row's parent, ancestors and whether it has children", () => {
    const primary = groups.find((g) => g.accountId === "A")!;
    const by = Object.fromEntries(primary.rows.map((r) => [r.line.shortName, r]));
    expect(by["Food & Drink"]!.parentId).toBeNull();
    expect(by["Food & Drink"]!.hasChildren).toBe(true);
    expect(by["Coffee"]!.parentId).toBe(by["Restaurants"]!.line.id);
    expect(by["Coffee"]!.ancestorIds).toEqual([by["Restaurants"]!.line.id, by["Food & Drink"]!.line.id]);
    expect(by["Coffee"]!.hasChildren).toBe(false);
    expect(by["Pet"]!.hasChildren).toBe(false);
  });

  it("a parent without a line of its own on that account does not pull a child under it", () => {
    const other = buildBudgetTreeGroups([line("electric", "A", "Primary Checking")], parentOf);
    expect(other[0]!.rows[0]!.depth).toBe(0);
    expect(other[0]!.rows[0]!.parentId).toBeNull();
  });

  it("collapsing a parent hides its descendants only, never itself", () => {
    const primary = groups.find((g) => g.accountId === "A")!;
    const food = primary.rows.find((r) => r.line.shortName === "Food & Drink")!;
    const restaurants = primary.rows.find((r) => r.line.shortName === "Restaurants")!;
    expect(visibleRows(primary.rows, new Set()).length).toBe(5);
    expect(visibleRows(primary.rows, new Set([food.line.id])).map((r) => r.line.shortName)).toEqual(["Food & Drink", "Pet"]);
    expect(visibleRows(primary.rows, new Set([restaurants.line.id])).map((r) => r.line.shortName)).toEqual(["Food & Drink", "Groceries", "Restaurants", "Pet"]);
  });

  it("labels: a top-level row shows the full tag path, a nested row its own name", () => {
    const primary = groups.find((g) => g.accountId === "A")!;
    const electricOnly = buildBudgetTreeGroups([line("electric", "A", "Primary Checking")], parentOf)[0]!.rows[0]!;
    expect(rowLabel(electricOnly)).toBe("Utilities / Electric");
    const groceries = primary.rows.find((r) => r.line.shortName === "Groceries")!;
    expect(rowLabel(groceries)).toBe("Groceries");
  });
});
