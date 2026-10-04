import { createElement } from "react";
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { buildSheetModel, type SheetLineOverride } from "@/lib/tax2025-sheet";
import { ReturnSheet } from "@/components/tax/forms/return-sheet";
import { emptyFacts, fullFacts1b, owner } from "@/lib/__tests__/tax2025-fixtures";

// Render smoke tests for the server-rendered sheet (no DOM, no browser): vitest's esbuild uses the
// classic JSX runtime for .tsx sources here, so React is provided as a global for the components under test.
(globalThis as { React?: typeof React }).React = React;

const NOW = new Date("2026-10-03T16:30:00Z");

function render(ret: ReturnType<typeof computeTy2025Return>, overrides?: Record<string, SheetLineOverride>): string {
  const model = buildSheetModel({
    ret,
    documents: [{ id: "w2-eric-a", docType: "w2", taxYear: 2025, verified: true, legacyFormat: false, subjectType: "person" }],
    now: NOW,
    ...(overrides ? { overrides } : {}),
  });
  return renderToStaticMarkup(createElement(ReturnSheet, { model }));
}

describe("ReturnSheet render", () => {
  it("prints the six parts, the DRAFT label and the CPA-is-preparer wording on an all-missing return", () => {
    const html = render(computeTy2025Return(emptyFacts()));
    for (const id of ["part-1", "part-2", "part-3", "part-4", "part-5", "part-6"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("DRAFT for CPA review - computed from the inputs shown; the CPA is the preparer of record");
    expect(html).toContain("INCOMPLETE:");
    expect(html).toContain("not computed");
    expect(html).toContain("2026-10-03 12:30 EDT");
    expect(html).toContain("CPA sign-off checklist");
    expect(html).toContain("What Eric and Eva still need to answer or verify");
    // a not-computed wages line shows the status label, never a zero amount
    const row = html.match(/<tr[^>]*data-line-key="f1040\.1a"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(row).toContain("not computed");
    expect(row).toContain("missing input");
    expect(row).not.toMatch(/\$0\b/);
  });

  it("marks the undecided default on the decisions page and renders override notes", () => {
    const f = fullFacts1b();
    f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive" as const);
    f.income.scheduleC.homeOfficeSqft = owner(200);
    const html = render(computeTy2025Return(f), { "schc.30": { was: 1000, now: 1200, by: "the CPA", at: "2026-10-05T14:00:00Z", reason: "measured" } });
    expect(html).toContain("default, undecided");
    expect(html).toContain('data-decision="X1"');
    expect(html).toContain("Whole-return effect");
    expect(html).toContain("Override: was $1,000, now $1,200, by the CPA on 2026-10-05: measured");
    expect(html).toContain("/documents/w2-eric-a/review");
  });
});
