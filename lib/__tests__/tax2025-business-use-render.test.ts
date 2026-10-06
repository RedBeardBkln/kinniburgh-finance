// Server render of the review sheet with the business-use decision (X6): the card, the alternatives, the personal portion and the dialog chip
// (no DOM, no browser; the dialog itself opens on a click and is checked by hand, see the implementation notes).

import { createElement } from "react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/actions/tax-return-overrides", () => ({
  setTaxReturnOverride: vi.fn(),
  clearTaxReturnOverride: vi.fn(),
  listTaxReturnOverrideHistory: vi.fn(),
}));
import { applyOverrides, decisionsFromOverrides, type OverrideRow } from "@/lib/tax2025/overrides";
import { TY2025_ENGINE_VERSION, computeTy2025Return } from "@/lib/tax2025/return";
import { buildSheetModel } from "@/lib/tax2025-sheet";
import { ReturnSheet } from "@/components/tax/forms/return-sheet";
import { fullFacts1b, gl } from "@/lib/__tests__/tax2025-fixtures";

(globalThis as { React?: typeof React }).React = React;

const NOW = new Date("2026-10-06T16:30:00Z");
const REASON = "Bill split by the number of people working from home; usage log kept.";

function row(valueText: string): OverrideRow {
  return {
    id: "00000000-0000-4000-8000-0000000000bb",
    taxYear: 2025,
    targetKind: "decision",
    targetKey: "businessUse.internet_phone",
    version: 1,
    valueKind: "choice",
    valueCents: null,
    valueText,
    computedSnapshot: { status: "default_undecided", cents: null, engineVersion: TY2025_ENGINE_VERSION },
    authority: "owner",
    reason: REASON,
    setByName: "Eric Kinniburgh",
    setAt: new Date("2026-10-06T14:00:00Z"),
    archivedAt: null,
  };
}

function render(rows: OverrideRow[], withEffective = true, withAccount = true): string {
  const f = fullFacts1b();
  if (withAccount) f.income.scheduleC.glLines = [...f.income.scheduleC.glLines, gl("6100", "Utilities:Internet & Phone", "expense", 261_017)];
  const ret = computeTy2025Return(f, decisionsFromOverrides(rows));
  const model = buildSheetModel({ ret, documents: [], now: NOW, ...(withEffective ? { effective: applyOverrides(ret, rows) } : {}) });
  return renderToStaticMarkup(createElement(ReturnSheet, { model }));
}

/** The X6 card (from its data-decision attribute to the end of its block). */
function card(html: string): string {
  const start = html.indexOf('data-decision="X6"');
  expect(start, "the X6 card is on the sheet").toBeGreaterThan(-1);
  const next = html.indexOf("data-decision=", start + 10);
  return html.slice(start, next === -1 ? start + 8000 : next);
}

describe("review sheet: the X6 card", () => {
  it("undecided: 'default, undecided', both alternatives side by side, the $0 personal portion, and a Record chip", () => {
    const c = card(render([]));
    expect(c).toContain("X6: Business-use share of the shared internet and phone service (Schedule C line 25)");
    expect(c).toContain("default, undecided");
    expect(c).toContain("100% business use (no split)");
    expect(c).toContain("A recorded business-use share (none recorded yet)");
    expect(c).toContain("Schedule C line 25 would be $2,610; nothing is treated as personal.");
    expect(c).toContain('data-testid="personal-portion"');
    expect(c).toContain("Personal portion: $0 at the default (100% business use).");
    expect(c).toContain('data-testid="decision-chip"');
    expect(c).toContain('aria-label="Record decision X6"');
    expect(c).toContain("Record this decision");
  });
  it("decided 70%: the recorded alternative is chosen with its effect, the note names who / when / why, the personal portion is shown, and the chip says Change", () => {
    const c = card(render([row("70")]));
    expect(c).toContain("decided");
    expect(c).toContain("70% business use (your recorded share)");
    expect(c).toContain("Schedule C line 25 is $1,827");
    expect(c).toContain("The other $783.05 is personal");
    expect(c).toContain("Personal portion: $783.05 (not deducted; informational, not a Schedule C amount; nothing is booked).");
    expect(c).toContain('data-testid="decision-override-note"');
    expect(c).toContain("set to 70%");
    expect(c).toContain("Eric Kinniburgh");
    expect(c).toContain(REASON);
    expect(c).toContain('aria-label="Change decision X6"');
    expect(c).toContain("Change decision");
  });
  it("without the override layer the card shows no Record button (read-only sheet)", () => {
    const c = card(render([], false));
    expect(c).not.toContain('data-testid="decision-chip"');
    expect(c).toContain("Personal portion: $0 at the default (100% business use).");
  });
  it("no booked amount: X6 is only a placeholder line in 'Decisions not raised'", () => {
    const html = render([], true, false);
    expect(html).not.toContain('data-decision="X6"');
    expect(html).toContain("X6: Business-use share of the shared internet and phone service (Schedule C line 25).");
    expect(html).toContain("nothing is booked for 2025 to the shared household internet and phone service in the EK Consulting books");
  });
  it("Schedule C line 25 carries the decision provenance on the sheet: default, undecided, then the owner's statement", () => {
    const undecided = render([]);
    const l25 = undecided.match(/<tr[^>]*data-line-key="schc\.25"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(l25).toContain("$2,610");
    expect(l25).toContain("default, undecided");
    const decided = render([row("70")]);
    const d25 = decided.match(/<tr[^>]*data-line-key="schc\.25"[\s\S]*?<\/tr>/)?.[0] ?? "";
    expect(d25).toContain("$1,827");
    expect(d25).toContain("not verified by documents");
  });
});
