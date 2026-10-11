// The Add-line dialog's "Also add to later saved months" checkbox: ticked by default, label and preview from the
// planner's context, hidden when there is nothing to add to, never shown in edit mode. Static markup (no DOM in this repo).
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/actions/budgets", () => ({ createBudget: async () => ({ success: true }), updateBudget: async () => ({ success: true }) }));

import { BudgetEditModal } from "@/components/budgets/budget-edit-modal";
import type { LaterAddContext } from "@/lib/budget-first-edit-note";

(globalThis as unknown as { React: typeof React }).React = React;

const accounts = [{ id: "acc-1", nickname: "Checking", mask: null }];
const tags = [
  { id: "t-new", name: "Cat / New", shortName: "New" },
  { id: "t-has", name: "Cat / Has", shortName: "Has" },
];
const laterAdd: LaterAddContext = {
  through: "2026-12",
  candidates: ["2026-10", "2026-11", "2026-12"],
  skippedByTag: { "t-has": ["2026-12"] },
};

const addModal = (ctx: LaterAddContext | null | undefined) =>
  renderToStaticMarkup(<BudgetEditModal mode="add" accounts={accounts} tags={tags} entityId="e1" period="2026-09" laterAdd={ctx} onClose={() => {}} />);

describe("Add-line dialog: also add to later saved months", () => {
  it("shows the checkbox ticked by default, with the label and the planner's range", () => {
    const html = addModal(laterAdd);
    expect(html).toContain("Also add to later saved months (through December 2026)");
    expect(html).toMatch(/<input type="checkbox" checked=""/);
    expect(html).toContain("This line will also be added to 3 later months: October 2026 to December 2026.");
    expect(html).toContain("carry forward after December 2026");
  });

  it("is hidden when there is no context, when the context is null, or when no month is a candidate", () => {
    for (const ctx of [undefined, null, { through: "2026-12", candidates: [], skippedByTag: {} }]) {
      const html = addModal(ctx);
      expect(html).not.toContain("Also add to later saved months");
      expect(html).not.toContain('type="checkbox"');
    }
  });

  it("never appears in edit mode", () => {
    const html = renderToStaticMarkup(
      <BudgetEditModal
        mode="edit"
        budget={{ entityId: "e1", tagId: "t-new", tagName: "New", accountId: "acc-1", budgeted: "10", payDay: null, frequency: "monthly", payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null }}
        accounts={accounts}
        entityId="e1"
        period="2026-09"
        laterAdd={laterAdd}
        onClose={() => {}}
      />
    );
    expect(html).not.toContain("Also add to later saved months");
  });

  it("the source: the flag sent follows the checkbox (false whenever it is hidden), and no month list is ever sent", () => {
    const src = readFileSync(join(process.cwd(), "components/budgets/budget-edit-modal.tsx"), "utf8").replace(/\r\n/g, "\n");
    expect(src).toContain("alsoAddToLaterMonths: showAlsoLater ? alsoLater : false,");
    expect(src).toMatch(/const \[alsoLater, setAlsoLater\] = useState\(true\);/);
    expect(src).not.toMatch(/laterMonths:|months:/);
  });

  it("no component imports the planner, the writer or the carry-forward modules (only the pure wording file)", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const f = join(dir, n);
        return statSync(f).isDirectory() ? walk(f) : /\.tsx?$/.test(n) ? [f] : [];
      });
    const offenders = walk(join(process.cwd(), "components")).filter((f) => /budget-materialize|budget-carry-forward/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
