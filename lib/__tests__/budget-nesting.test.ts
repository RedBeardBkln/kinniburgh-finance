import { describe, it, expect } from "vitest";
import { nestBudgetLines, type NestableBudgetLine } from "../budget-nesting";

interface Line extends NestableBudgetLine {
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
