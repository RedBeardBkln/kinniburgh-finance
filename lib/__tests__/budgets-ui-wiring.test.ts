// Source-level checks of the client wiring (there is no DOM test environment in this repo): every Budget write from a
// screen names the line by a locator, the Delete wording explains that it ends the line, no copy button exists, and no
// client component pulls the server-only carry / materialize modules into the browser bundle.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { carriedEditNote, endLineConfirmText, firstEditSaveSentence } from "@/lib/budget-first-edit-note";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

describe("Budget writes from the screens use a locator", () => {
  const client = read("components/budgets/budget-page-client.tsx");
  it("delete and the additional buffer pass { entityId, tagId, period } of the line and the page's month", () => {
    expect(client).toContain("deleteBudget({ entityId: b.entityId, tagId: b.tagId, period })");
    expect(client).toContain("updateBudgetAdditionalAmount({ entityId: line.entityId, tagId: line.tagId, period }, cents)");
    expect(client).toContain("locator={{ entityId: b.entityId, tagId: b.tagId, period }}");
  });
  it("the edit modal names the line by entity + tag + month, not by id", () => {
    const modal = read("components/budgets/budget-edit-modal.tsx");
    expect(modal).toContain("updateBudget({ entityId: budget!.entityId, tagId: budget!.tagId, period }, {");
    expect(modal).not.toMatch(/budget!?\.id\b/);
  });
  it("the inline editor takes the locator", () => {
    const editor = read("components/budgets/budget-line-editor.tsx");
    expect(editor).toContain("updateBudgetLine(locator, value)");
    expect(editor).not.toMatch(/budgetId/);
  });
  it("the dashboard inline amount edit moved to the locator too", () => {
    const dialog = read("components/dashboard/drilldown-dialog.tsx");
    expect(dialog).toContain("updateBudgetLine({ entityId: edit.entityId, tagId: edit.tagId, period: edit.period }, input)");
    expect(dialog).not.toMatch(/edit\.budgetId/);
    expect(read("lib/dashboard-drill.ts")).not.toMatch(/lineEdit: \{ budgetId/);
  });
});

describe("Delete ends the line, in plain words", () => {
  const client = read("components/budgets/budget-page-client.tsx");
  it("the confirm text names the month, says how many saved later months go with the line, and what is kept (S3)", () => {
    expect(client).toContain("endLineConfirmText(b.tagName, periodLabel, b.laterSavedMonths)");
    expect(client).not.toContain("Delete this budget line?");
    expect(endLineConfirmText("Groceries", "October 2026", 2)).toBe(
      'End "Groceries" from October 2026 onward? This removes the line from October 2026 and the 2 later months that already have it, and it stops appearing in the budget and the forecast from then on. Earlier months are not changed. The linked scheduled bill will also be deactivated.'
    );
    expect(endLineConfirmText("Groceries", "October 2026", 1)).toContain("and the 1 later month that already has it");
    expect(endLineConfirmText("Groceries", "October 2026", 0)).toContain("This removes the line from October 2026; no later month has it saved");
    expect(endLineConfirmText("Groceries", "October 2026", null)).toContain("and every later month that already has it");
  });
  it("the button says End line, not Delete", () => {
    expect(client).toMatch(/onClick=\{\(\) => onDelete\(b\)\}[\s\S]{0,400}End line/);
    expect(client).not.toMatch(/>\s*Delete\s*</);
  });
  it("a refused delete or edit shows the plain message instead of being swallowed", () => {
    expect(client).toMatch(/if \("error" in result\) alert\(result\.error\);/);
  });
});

describe("S1/S2: the owner is told what a first change saves BEFORE making it", () => {
  it("the notice sentence counts the months and warns that the in-between months stop following earlier edits", () => {
    expect(firstEditSaveSentence(["2027-01"])).toBe("The first time you change something here, the whole list is saved for this month.");
    const s = firstEditSaveSentence(["2027-01", "2027-02", "2027-03"]);
    expect(s).toContain("saved for 3 months (January 2027 to March 2027): this month and every empty month before it.");
    expect(s).toContain("Those months then keep their own amounts and no longer follow later changes made to earlier months.");
    expect(firstEditSaveSentence(null)).toContain("earlier months after the last saved one are also empty, they are saved too");
  });
  it("the dashboard line dialog says the same for a carried line (same count)", () => {
    expect(carriedEditNote("2026-12", ["2027-01"])).toBe("Carried from December 2026: this month has no saved budget of its own yet. Changing the amount saves the carried budget for this month.");
    const many = carriedEditNote("2026-09", ["2026-10", "2026-11", "2026-12", "2027-01"]);
    expect(many).toContain("Carried from September 2026");
    expect(many).toContain("saves the carried budget for 4 months (October 2026 to January 2027): this month and every empty month before it.");
    expect(carriedEditNote("2026-09", null)).toContain("and for any empty month before it");
    const dialog = read("components/dashboard/drilldown-dialog.tsx");
    expect(dialog).toContain('data-testid="carried-edit-note"');
    expect(dialog).toContain("{edit.carriedNote}");
  });
});

describe("no copy button anywhere, and the old hazard note is gone", () => {
  it("no screen file offers to copy last month's lines", () => {
    for (const f of ["app/budgets/page.tsx", "components/budgets/budget-page-client.tsx", "components/budgets/budget-edit-modal.tsx", "components/budgets/budget-line-editor.tsx"]) {
      expect(read(f).toLowerCase(), f).not.toMatch(/copy (last|previous) month|copy lines|copy forward|copy budget/);
    }
  });
  it("CLAUDE.md no longer carries the hazard sentence and documents the new behavior", () => {
    const doc = read("CLAUDE.md");
    expect(doc).not.toContain("HAZARD: adding a single line");
    expect(doc).not.toMatch(/until `\/budgets` can copy last month's lines/);
    expect(doc).toContain("copy-on-first-edit");
    expect(doc).toContain("Every Budget action takes a locator");
    expect(doc).toContain("Delete ENDS the line from that month onward");
    // ASCII only inside the paragraph
    const start = doc.indexOf("**Budget carry-forward and copy-on-first-edit**");
    const end = doc.indexOf("\n", start);
    expect(start).toBeGreaterThan(0);
    expect(/^[\x20-\x7e]+$/.test(doc.slice(start, end))).toBe(true);
  });
});

describe("the browser bundle stays free of the server-only modules", () => {
  it("no client component imports the carry-forward or materialize modules (they import Decimal as a value)", () => {
    const files = [
      "components/budgets/budget-page-client.tsx",
      "components/budgets/budget-edit-modal.tsx",
      "components/budgets/budget-line-editor.tsx",
      "components/dashboard/drilldown-dialog.tsx",
      "components/dashboard/budget-lines-table.tsx",
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, f).toMatch(/^"use client";/);
      expect(src, f).not.toMatch(/budget-carry-forward|budget-materialize/);
    }
  });
  it("the client files only import a TYPE from the actions file (plus the action functions)", () => {
    expect(read("components/budgets/budget-line-editor.tsx")).toContain('import { updateBudgetLine, type BudgetLineLocator } from "@/actions/budgets";');
  });
});
