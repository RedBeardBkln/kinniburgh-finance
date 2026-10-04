import { describe, expect, it } from "vitest";
import { BY_HAND, buildIndexLines, scanChrome } from "@/lib/tax2025/pdf/final-package";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { findFinalPackageBannedWording } from "@/lib/tax-wording";
import { fullFacts } from "./tax2025-fixtures";

// The package index (tester Y, D4-a / D4-b): it says the generated Form 8949 attachment is only a summary, and it lists the lines
// that are left blank because they are the owner's choice as "enter by hand" items.

function indexText(hasForm8949Summary: boolean): string[] {
  const facts = fullFacts();
  const view = toPdfReturnView(computeTy2025Return(facts), facts, { generatedAt: "2026-10-08T16:00:00.000Z", generatedBy: "Test" });
  const lines = buildIndexLines({ view, formFiles: [{ name: "forms/01-f1040.pdf", title: "Form 1040" }], attachments: [], notIncluded: [], hasForm8949Summary });
  expect(scanChrome(lines)).toEqual([]);
  return lines.map((l) => {
    const b = l.block;
    return b.kind === "kv" ? `${b.label}: ${b.value}` : b.kind === "spacer" ? "" : b.text;
  });
}

describe("final package index wording", () => {
  it("says the Form 8949 statement is a summary that does not meet Exception 2 by itself, and names the broker detail pages with dates", () => {
    const text = indexText(true).join("\n");
    expect(text).toMatch(/1099-B detail pages, with the dates acquired and sold/);
    expect(text).toMatch(/summary only and does not satisfy the Form 8949 instructions \(Exception 2\) by itself/);
  });
  it("does not print the Also attach block when there are no Form 8949 summary rows", () => {
    expect(indexText(false).join("\n")).not.toMatch(/Exception 2/);
  });
  it("lists the lines left blank for the owner's choice as by-hand items (Form 1040 7b, 35a, 36; CT-1040 23, 24, 24a, 25)", () => {
    const text = indexText(false).join("\n");
    for (const needle of ["Form 1040 lines 35a and 36", "Form 1040 line 7b", "CT-1040 lines 23, 24 and 24a", "line 25"]) expect(text, needle).toContain(needle);
    expect(BY_HAND.length).toBeGreaterThanOrEqual(10);
  });
  it("every by-hand entry passes the final-package banned-wording scan (no 'estimate', 'review', 'draft' ...)", () => {
    for (const t of BY_HAND) expect(findFinalPackageBannedWording(t), t).toEqual([]);
  });
});
