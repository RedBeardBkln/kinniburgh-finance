import { createElement } from "react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The override chips are client components that import the (DB-backed) server actions; nothing is called while rendering.
vi.mock("@/actions/tax-return-overrides", () => ({
  setTaxReturnOverride: vi.fn(),
  clearTaxReturnOverride: vi.fn(),
  listTaxReturnOverrideHistory: vi.fn(),
}));
import { computeTy2025Return } from "@/lib/tax2025/return";
import { buildSheetModel } from "@/lib/tax2025-sheet";
import { applyOverrides, lineSnapshot, type OverrideRow } from "@/lib/tax2025/overrides";
import type { LineKey } from "@/lib/tax2025/types";
import { ReturnSheet } from "@/components/tax/forms/return-sheet";
import { emptyFacts, fullFacts1b, owner } from "@/lib/__tests__/tax2025-fixtures";

// Render smoke tests for the server-rendered sheet (no DOM, no browser): vitest's esbuild uses the
// classic JSX runtime for .tsx sources here, so React is provided as a global for the components under test.
(globalThis as { React?: typeof React }).React = React;

const NOW = new Date("2026-10-03T16:30:00Z");

function pinRow(ret: ReturnType<typeof computeTy2025Return>, key: LineKey, valueCents: number, reason: string): OverrideRow {
  const l = ret.lines[key];
  if (!l) throw new Error(`no line ${key}`);
  return {
    id: "00000000-0000-4000-8000-0000000000aa",
    taxYear: 2025,
    targetKind: "line",
    targetKey: key,
    version: 1,
    valueKind: "money_cents",
    valueCents,
    valueText: null,
    computedSnapshot: lineSnapshot(l, ret.engineVersion),
    authority: "cpa",
    reason,
    setByName: "Eric Kinniburgh",
    setAt: new Date("2026-10-05T14:00:00Z"),
    archivedAt: null,
  };
}

function render(ret: ReturnType<typeof computeTy2025Return>, rows?: OverrideRow[]): string {
  const model = buildSheetModel({
    ret,
    documents: [{ id: "w2-eric-a", docType: "w2", taxYear: 2025, verified: true, legacyFormat: false, subjectType: "person" }],
    now: NOW,
    ...(rows ? { effective: applyOverrides(ret, rows) } : {}),
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
    const ret = computeTy2025Return(f);
    expect(ret.lines["schc.30"]?.amount).toBe(1000); // 200 sq ft x $5 (simplified method)
    const html = render(ret, [pinRow(ret, "schc.30", 120_000, "measured")]);
    expect(html).toContain("default, undecided");
    expect(html).toContain('data-decision="X1"');
    expect(html).toContain("Whole-return effect");
    // the ONE note wording (formatOverrideNote) with the computed value it replaced, who / when (America/New_York) / why
    expect(html).toContain(`CPA override: was $1,000 computed, now $1,200, by Eric Kinniburgh (per CPA) on 2026-10-05, reason: measured`);
    expect(html).toContain('data-testid="override-note"');
    expect(html).toContain('data-testid="overrides-panel"');
    expect(html).toContain("Totals are NOT recomputed");
    expect(html).toContain("depends on an override, not recomputed");
    expect(html).toContain("/documents/w2-eric-a/review");
  });
});
