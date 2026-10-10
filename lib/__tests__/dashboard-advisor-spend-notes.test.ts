import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The advisor, the monthly review and the budget CSV still use the older per-tag signed spend. Until they adopt
// lib/month-spend, their wording must not claim to match the dashboard's Spent (review round 1, S1: text only, no logic change).
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

describe("older spend readers say they are not the dashboard's Spent", () => {
  it("get_budget_status: note and description", () => {
    const src = read("lib/advisor/tools/get-budget-status.ts");
    expect(src).toMatch(/NOT the dashboard's Spent figure/);
    expect(src).toMatch(/the Mortgage line reads differently/);
    expect(src).toMatch(/Spent here is the net signed amount on the exact tag, NOT the dashboard's Spent/);
  });
  it("advisor context: the total is labelled as a net outflow on budget tags", () => {
    const src = read("lib/advisor-context.ts");
    expect(src).toMatch(/Net outflow on budget tags \(not the dashboard's Spent figure; can differ\)/);
    expect(src).not.toMatch(/Total spent:/);
    expect(src).toMatch(/Total budgeted: /); // pinned by the consumers test
  });
  it("spend query comments no longer claim to match the Budgets page", () => {
    const src = read("lib/advisor/queries/spend.ts");
    expect(src).toMatch(/NOT the dashboard's Spent \(lib\/month-spend\.ts\)/);
    expect(src).not.toMatch(/as on the Budgets page|same rules as the Budgets page/);
  });
});
