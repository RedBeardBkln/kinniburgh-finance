import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  nestBudgetLines,
  resolveBudgetedAmounts,
  getRootBudgetLineIds,
  type NestableBudgetLine,
  type ResolvableBudgetLine,
} from "../budget-nesting";

interface Line extends NestableBudgetLine {
  name: string;
}

interface ResolvableLine extends ResolvableBudgetLine {
  name: string;
}

function byName(a: Line, b: Line): number {
  return a.name.localeCompare(b.name);
}

describe("nestBudgetLines", () => {
  it("nests a child under its parent when both have budget lines on the account", () => {
    const streaming: Line = { id: "b1", tagId: "streaming", name: "Streaming" };
    const hboMax: Line = { id: "b2", tagId: "hbo-max", name: "HBO Max" };
    const parents = new Map([["hbo-max", "streaming"]]);

    const result = nestBudgetLines([streaming, hboMax], (tagId) => parents.get(tagId), byName);

    expect(result).toEqual([
      { line: streaming, depth: 0 },
      { line: hboMax, depth: 1 },
    ]);
  });

  it("keeps a child at the top level when its parent has no budget line on this account", () => {
    const hboMax: Line = { id: "b1", tagId: "hbo-max", name: "HBO Max" };
    const parents = new Map([["hbo-max", "streaming"]]); // "streaming" tag has no budget line here

    const result = nestBudgetLines([hboMax], (tagId) => parents.get(tagId), byName);

    expect(result).toEqual([{ line: hboMax, depth: 0 }]);
  });

  it("supports multiple levels of nesting", () => {
    const utilities: Line = { id: "b1", tagId: "utilities", name: "Utilities" };
    const internetPhone: Line = { id: "b2", tagId: "internet-phone", name: "Internet and Phone" };
    const cellPlan: Line = { id: "b3", tagId: "cell-plan", name: "Cell Plan" };
    const parents = new Map([
      ["internet-phone", "utilities"],
      ["cell-plan", "internet-phone"],
    ]);

    const result = nestBudgetLines(
      [cellPlan, utilities, internetPhone],
      (tagId) => parents.get(tagId),
      byName
    );

    expect(result).toEqual([
      { line: utilities, depth: 0 },
      { line: internetPhone, depth: 1 },
      { line: cellPlan, depth: 2 },
    ]);
  });

  it("groups multiple children under the same parent and sorts them", () => {
    const streaming: Line = { id: "b1", tagId: "streaming", name: "Streaming" };
    const netflix: Line = { id: "b2", tagId: "netflix", name: "Netflix" };
    const hboMax: Line = { id: "b3", tagId: "hbo-max", name: "HBO Max" };
    const parents = new Map([
      ["netflix", "streaming"],
      ["hbo-max", "streaming"],
    ]);

    const result = nestBudgetLines([streaming, netflix, hboMax], (tagId) => parents.get(tagId), byName);

    // Children sorted alphabetically under their parent: HBO Max before Netflix
    expect(result).toEqual([
      { line: streaming, depth: 0 },
      { line: hboMax, depth: 1 },
      { line: netflix, depth: 1 },
    ]);
  });

  it("doesn't hang or crash on malformed self-referencing parentId data", () => {
    const line: Line = { id: "b1", tagId: "loop", name: "Loop" };
    const parents = new Map([["loop", "loop"]]);

    expect(() => nestBudgetLines([line], (tagId) => parents.get(tagId), byName)).not.toThrow();
  });

  it("treats lines with no parent (or no tag lookup entry) as top-level roots", () => {
    const groceries: Line = { id: "b1", tagId: "groceries", name: "Groceries" };
    const gas: Line = { id: "b2", tagId: "gas", name: "Gas" };

    const result = nestBudgetLines([gas, groceries], () => undefined, byName);

    expect(result).toEqual([
      { line: gas, depth: 0 },
      { line: groceries, depth: 0 },
    ]);
  });

  it("sorts top-level roots using the provided comparator", () => {
    const b: Line = { id: "b1", tagId: "b", name: "Bravo" };
    const a: Line = { id: "b2", tagId: "a", name: "Alpha" };

    const result = nestBudgetLines([b, a], () => null, byName);

    expect(result.map((r) => r.line.name)).toEqual(["Alpha", "Bravo"]);
  });
});

describe("resolveBudgetedAmounts", () => {
  it("resolves a line with a non-null budgeted amount and no children to its own value", () => {
    const groceries: ResolvableLine = { id: "b1", tagId: "groceries", name: "Groceries", budgeted: new Decimal(400) };

    const result = resolveBudgetedAmounts([groceries], () => undefined, new Decimal(0));

    expect(result.get("b1")!.toString()).toBe("400");
  });

  it("resolves a blank line with no matching children to $0", () => {
    const gas: ResolvableLine = { id: "b1", tagId: "gas", name: "Gas", budgeted: null };

    const result = resolveBudgetedAmounts([gas], () => undefined, new Decimal(0));

    expect(result.get("b1")!.toString()).toBe("0");
  });

  it("resolves a blank parent to the sum of its non-null children (Food & Drink = Groceries + Restaurants)", () => {
    const foodDrink: ResolvableLine = { id: "b1", tagId: "food-drink", name: "Food & Drink", budgeted: null };
    const groceries: ResolvableLine = { id: "b2", tagId: "groceries", name: "Groceries", budgeted: new Decimal(400) };
    const restaurants: ResolvableLine = { id: "b3", tagId: "restaurants", name: "Restaurants", budgeted: new Decimal(150) };
    const parents = new Map([
      ["groceries", "food-drink"],
      ["restaurants", "food-drink"],
    ]);

    const result = resolveBudgetedAmounts(
      [foodDrink, groceries, restaurants],
      (tagId) => parents.get(tagId),
      new Decimal(0)
    );

    expect(result.get("b1")!.toString()).toBe("550");
    expect(result.get("b2")!.toString()).toBe("400");
    expect(result.get("b3")!.toString()).toBe("150");
  });

  it("resolves multi-level bottom-up: a blank grandparent with a blank parent (itself summed from two children) plus one other explicit child", () => {
    // Food & Drink (blank)
    //   Restaurants (blank) = Bakeries & Coffee Shops (60) + Food Delivery (90)
    //   Groceries (400, explicit direct child of Food & Drink)
    const foodDrink: ResolvableLine = { id: "b1", tagId: "food-drink", name: "Food & Drink", budgeted: null };
    const restaurants: ResolvableLine = { id: "b2", tagId: "restaurants", name: "Restaurants", budgeted: null };
    const bakeries: ResolvableLine = { id: "b3", tagId: "bakeries", name: "Bakeries & Coffee Shops", budgeted: new Decimal(60) };
    const delivery: ResolvableLine = { id: "b4", tagId: "delivery", name: "Food Delivery", budgeted: new Decimal(90) };
    const groceries: ResolvableLine = { id: "b5", tagId: "groceries", name: "Groceries", budgeted: new Decimal(400) };
    const parents = new Map([
      ["restaurants", "food-drink"],
      ["groceries", "food-drink"],
      ["bakeries", "restaurants"],
      ["delivery", "restaurants"],
    ]);

    const result = resolveBudgetedAmounts(
      [foodDrink, restaurants, bakeries, delivery, groceries],
      (tagId) => parents.get(tagId),
      new Decimal(0)
    );

    expect(result.get("b2")!.toString()).toBe("150"); // Restaurants = 60 + 90
    expect(result.get("b1")!.toString()).toBe("550"); // Food & Drink = 150 (Restaurants) + 400 (Groceries)
  });

  it("respects an explicit non-null budgeted amount on a line that also has children — never overwritten by the children's sum", () => {
    const foodDrink: ResolvableLine = { id: "b1", tagId: "food-drink", name: "Food & Drink", budgeted: new Decimal(999) };
    const groceries: ResolvableLine = { id: "b2", tagId: "groceries", name: "Groceries", budgeted: new Decimal(400) };
    const parents = new Map([["groceries", "food-drink"]]);

    const result = resolveBudgetedAmounts([foodDrink, groceries], (tagId) => parents.get(tagId), new Decimal(0));

    expect(result.get("b1")!.toString()).toBe("999");
  });

  it("doesn't hang or crash on malformed self-referencing parentId data (cycle guard)", () => {
    const line: ResolvableLine = { id: "b1", tagId: "loop", name: "Loop", budgeted: null };
    const parents = new Map([["loop", "loop"]]);

    expect(() => resolveBudgetedAmounts([line], (tagId) => parents.get(tagId), new Decimal(0))).not.toThrow();
    const result = resolveBudgetedAmounts([line], (tagId) => parents.get(tagId), new Decimal(0));
    expect(result.get("b1")!.toString()).toBe("0");
  });
});

describe("getRootBudgetLineIds", () => {
  it("returns exactly the ids of lines with no budgeted parent present in the same list", () => {
    const streaming: Line = { id: "b1", tagId: "streaming", name: "Streaming" };
    const hboMax: Line = { id: "b2", tagId: "hbo-max", name: "HBO Max" };
    const groceries: Line = { id: "b3", tagId: "groceries", name: "Groceries" };
    const parents = new Map([["hbo-max", "streaming"]]);

    const result = getRootBudgetLineIds([streaming, hboMax, groceries], (tagId) => parents.get(tagId));

    expect(result).toEqual(new Set(["b1", "b3"]));
  });

  it("treats a child whose parent has no budget line on this account as a root", () => {
    const hboMax: Line = { id: "b1", tagId: "hbo-max", name: "HBO Max" };
    const parents = new Map([["hbo-max", "streaming"]]); // "streaming" tag has no budget line here

    const result = getRootBudgetLineIds([hboMax], (tagId) => parents.get(tagId));

    expect(result).toEqual(new Set(["b1"]));
  });
});

describe("resolveBudgetedAmounts + getRootBudgetLineIds composed (the 'total budgeted' recipe every consumer site uses)", () => {
  it("a blank auto-sum parent with two children plus one unrelated root sums to only the roots' resolved amounts, not every line", () => {
    // Mirrors the real consumer recipe in app/budgets/page.tsx, app/page.tsx,
    // app/forecast/page.tsx, etc.: sum resolveBudgetedAmounts(...) but only
    // for ids present in getRootBudgetLineIds(...).
    const parent: ResolvableLine = { id: "p", tagId: "parent", name: "Food & Drink", budgeted: null };
    const child1: ResolvableLine = { id: "c1", tagId: "child1", name: "Groceries", budgeted: new Decimal(10) };
    const child2: ResolvableLine = { id: "c2", tagId: "child2", name: "Restaurants", budgeted: new Decimal(20) };
    const unrelatedRoot: ResolvableLine = { id: "r2", tagId: "unrelated", name: "Gas", budgeted: new Decimal(5) };
    const lines = [parent, child1, child2, unrelatedRoot];
    const parents = new Map([
      ["child1", "parent"],
      ["child2", "parent"],
    ]);
    const tagParentId = (tagId: string) => parents.get(tagId);

    const resolved = resolveBudgetedAmounts(lines, tagParentId, new Decimal(0));
    const roots = getRootBudgetLineIds(lines, tagParentId);

    expect(roots).toEqual(new Set(["p", "r2"]));

    let total = new Decimal(0);
    for (const line of lines) {
      if (roots.has(line.id)) total = total.plus(resolved.get(line.id)!);
    }
    // $30 (auto-summed parent) + $5 (unrelated root) = $35 — NOT $65, which
    // would result from summing every line (parent + children + root).
    expect(total.toString()).toBe("35");
  });

  it("an explicit parent amount equal to its children's sum produces the identical total as leaving it blank/auto (acceptance criterion: totals must match either way)", () => {
    const parents = new Map([
      ["child1", "parent"],
      ["child2", "parent"],
    ]);
    const tagParentId = (tagId: string) => parents.get(tagId);

    function totalFor(parentBudgeted: Decimal | null): string {
      const lines: ResolvableLine[] = [
        { id: "p", tagId: "parent", name: "Food & Drink", budgeted: parentBudgeted },
        { id: "c1", tagId: "child1", name: "Groceries", budgeted: new Decimal(10) },
        { id: "c2", tagId: "child2", name: "Restaurants", budgeted: new Decimal(20) },
      ];
      const resolved = resolveBudgetedAmounts(lines, tagParentId, new Decimal(0));
      const roots = getRootBudgetLineIds(lines, tagParentId);
      let total = new Decimal(0);
      for (const line of lines) if (roots.has(line.id)) total = total.plus(resolved.get(line.id)!);
      return total.toString();
    }

    expect(totalFor(null)).toBe(totalFor(new Decimal(30)));
    expect(totalFor(null)).toBe("30");
  });
});
