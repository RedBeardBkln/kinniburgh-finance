// The business-use percentage (X6) on the review sheet: the pure dialog helpers, the sheet model, and source pins for the dialog and the
// sheet (there is no jsdom in this repo; interactive behaviour is checked by hand in Chrome, see the implementation notes).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUSINESS_USE_ACCOUNTS, formatCentsText, roundMilliCentsToDollars, shareCents } from "@/lib/tax2025/business-use";
import { checkBusinessUseForm, formatOverrideHistoryRow, previewBusinessUse } from "@/lib/tax2025/override-input";
import { applyOverrides, decisionsFromOverrides, type OverrideHistoryRow, type OverrideRow } from "@/lib/tax2025/overrides";
import { TY2025_ENGINE_VERSION, computeTy2025Return } from "@/lib/tax2025/return";
import { buildSheetModel, type SheetModel } from "@/lib/tax2025-sheet";
import { fullFacts1b, gl } from "./tax2025-fixtures";

const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const NOW = new Date("2026-10-06T16:30:00Z");
const REASON = "Bill split by the number of people working from home; usage log kept.";

describe("checkBusinessUseForm", () => {
  it("an untouched form shows no error and cannot save", () => {
    expect(checkBusinessUseForm({ percentText: "", reasonText: "", busy: false })).toEqual({ canSave: false, percentError: null, reasonError: null, tenths: null });
  });
  it("valid percentage and reason: Save is allowed; busy blocks it", () => {
    const ok = checkBusinessUseForm({ percentText: "70.5", reasonText: REASON, busy: false });
    expect(ok).toEqual({ canSave: true, percentError: null, reasonError: null, tenths: 705 });
    expect(checkBusinessUseForm({ percentText: "70", reasonText: REASON, busy: true }).canSave).toBe(false);
    for (const p of ["0", "100", "70%", " 33.3 "]) expect(checkBusinessUseForm({ percentText: p, reasonText: REASON, busy: false }).canSave, p).toBe(true);
  });
  it("invalid percentages show the plain error and block Save", () => {
    for (const p of ["101", "-1", "70.55", "abc", "1e2", "70,5", "100.1"]) {
      const c = checkBusinessUseForm({ percentText: p, reasonText: REASON, busy: false });
      expect(c.canSave, p).toBe(false);
      expect(c.percentError, p).toBe("Enter a percentage from 0 to 100, with at most one decimal.");
      expect(c.tenths, p).toBeNull();
    }
  });
  it("a reason that is too short blocks Save with the reason error; a valid percentage alone is not enough", () => {
    const c = checkBusinessUseForm({ percentText: "70", reasonText: "ab", busy: false });
    expect(c.canSave).toBe(false);
    expect(c.reasonError).toMatch(/at least 3 characters/);
    expect(c.percentError).toBeNull();
  });
});

describe("previewBusinessUse (integers only; equals the plan's hand table)", () => {
  const base = { flaggedCents: 261_017, otherCents: 0, lineLabel: "Schedule C line 25" };
  it("261,017 cents: 70% -> 1,827 with a 783.05 personal portion; 100% -> 2,610; 70.5% -> 1,840; 33.3% -> 869; 0% -> 0", () => {
    expect(previewBusinessUse({ ...base, tenths: 700 })).toMatchObject({ lineDollars: 1827, personalCents: 78_305, atFullDollars: 2610 });
    expect(previewBusinessUse({ ...base, tenths: 1000 })).toMatchObject({ lineDollars: 2610, personalCents: 0 });
    expect(previewBusinessUse({ ...base, tenths: 705 }).lineDollars).toBe(1840);
    expect(previewBusinessUse({ ...base, tenths: 333 }).lineDollars).toBe(869);
    expect(previewBusinessUse({ ...base, tenths: 0 })).toMatchObject({ lineDollars: 0, personalCents: 261_017 });
  });
  it("the sentence reads as the plan says", () => {
    expect(previewBusinessUse({ ...base, tenths: 700 }).text).toBe(
      "At 70%: Schedule C line 25 would be about $1,827; personal portion $783.05; at 100% it is $2,610."
    );
  });
  it("rounds the LINE once: another account on the line counts at 100% inside the one rounding", () => {
    // internet 1,000.30 at 50% + electricity 100.40 at 100% = 600.55 -> 601
    expect(previewBusinessUse({ flaggedCents: 100_030, otherCents: 10_040, tenths: 500, lineLabel: "x" }).lineDollars).toBe(601);
    expect(previewBusinessUse({ flaggedCents: 100_100, otherCents: 0, tenths: 500, lineLabel: "x" }).lineDollars).toBe(501);
  });
  it("integer helpers: shareCents is half-up cents; formatCentsText keeps the engine's money convention", () => {
    expect(shareCents(261_017, 700)).toBe(182_712);
    expect(shareCents(1, 500)).toBe(1);
    expect(shareCents(1, 499)).toBe(0);
    expect(roundMilliCentsToDollars(50_000)).toBe(1);
    expect(roundMilliCentsToDollars(49_999)).toBe(0);
    expect(formatCentsText(78_305)).toBe("$783.05");
    expect(formatCentsText(261_000)).toBe("$2,610");
    expect(formatCentsText(5)).toBe("$0.05");
    expect(formatCentsText(0)).toBe("$0");
    expect(formatCentsText(-50)).toBe("-$0.50");
  });
});

describe("history rows read as a percentage for a business-use target", () => {
  const row = (over: Partial<OverrideHistoryRow> = {}): OverrideHistoryRow => ({
    id: "r1",
    version: 2,
    valueKind: "choice",
    valueCents: null,
    valueText: "70.5",
    authority: "owner",
    reason: REASON,
    setByName: "Eric",
    setAt: "2026-10-06T16:00:00.000Z",
    archivedAt: null,
    archiveKind: null,
    archiveReason: null,
    ...over,
  });
  it("'70.5% business use' instead of 'choice: 70.5'", () => {
    expect(formatOverrideHistoryRow(row(), { percent: true }).valueText).toBe("70.5% business use");
    expect(formatOverrideHistoryRow(row()).valueText).toBe("choice: 70.5");
    expect(formatOverrideHistoryRow(row({ archivedAt: "2026-10-07T12:00:00.000Z", archiveKind: "cleared", archiveReason: "Wrong plan." }), { percent: true })).toMatchObject({
      state: "cleared",
      valueText: "70.5% business use",
      clearReasonText: "Wrong plan.",
    });
  });
});

// ── the sheet model ───────────────────────────────────────────────────────────────────────────────────────────────

function facts(withAccount = true) {
  const f = fullFacts1b();
  if (withAccount) f.income.scheduleC.glLines = [...f.income.scheduleC.glLines, gl("6100", "Utilities:Internet & Phone", "expense", 261_017)];
  return f;
}
function overrideRow(valueText: string): OverrideRow {
  return {
    id: "row-1",
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
    setByName: "Eric",
    setAt: new Date("2026-10-06T16:00:00.000Z"),
    archivedAt: null,
  };
}
function sheet(rows: OverrideRow[], f = facts()): SheetModel {
  const ret = computeTy2025Return(f, decisionsFromOverrides(rows));
  return buildSheetModel({ ret, documents: [], now: NOW, effective: applyOverrides(ret, rows) });
}

describe("sheet model: the X6 card", () => {
  it("undecided: both alternatives side by side, 'default, undecided', no recorded percentage, personal portion $0 at the default", () => {
    const m = sheet([]);
    const x6 = m.decisions.find((d) => d.id === "X6");
    expect(x6).toBeDefined();
    expect(x6?.undecided).toBe(true);
    expect(x6?.statusText).toBe("default, undecided");
    expect(x6?.decisionKey).toBe("businessUse.internet_phone");
    expect(x6?.choices).toEqual([]);
    expect(x6?.alternatives.map((a) => [a.id, a.marker])).toEqual([
      ["full", "default, undecided"],
      ["recorded", null],
    ]);
    expect(x6?.alternatives[0]?.effectAmountText).toBe("$2,610");
    expect(x6?.percent).toMatchObject({ currentText: null, defaultText: "100", bookedCents: 261_017, otherLineCents: 0, lineLabel: "Schedule C line 25", personalCents: 0 });
    expect(x6?.percent?.personalText).toBe("Personal portion: $0 at the default (100% business use).");
    expect(m.decisionPlaceholders.some((p) => p.id === "X6")).toBe(false);
  });
  it("undecided: line 25 carries the 'default, undecided: <label>' provenance", () => {
    const m = sheet([]);
    const line = m.federal.flatMap((g) => g.lines).find((l) => l.key === "schc.25");
    expect(line?.defaultUndecided).toContain("Business-use share");
    expect(JSON.stringify(line)).toContain("default, undecided");
  });
  it("decided 70%: both alternatives, the recorded one in force with its effect, who / when / reason, and the personal portion", () => {
    const m = sheet([overrideRow("70")]);
    const x6 = m.decisions.find((d) => d.id === "X6");
    expect(x6?.undecided).toBe(false);
    expect(x6?.statusText).toBe("decided");
    expect(x6?.chosen).toBe("70%");
    expect(x6?.alternatives.map((a) => [a.id, a.marker, a.inForce])).toEqual([
      ["full", "default", false],
      ["recorded", "chosen", true],
    ]);
    expect(x6?.alternatives[1]?.effectNote).toContain("$1,827");
    expect(x6?.override?.note).toContain("set to 70%");
    expect(x6?.override).toMatchObject({ by: "Eric", reason: REASON, choice: "70" });
    expect(x6?.percent?.currentText).toBe("70");
    expect(x6?.percent?.personalText).toBe("Personal portion: $783.05 (not deducted; informational, not a Schedule C amount; nothing is booked).");
    expect(x6?.decidedBy).toBe("Eric");
    const line = m.federal.flatMap((g) => g.lines).find((l) => l.key === "schc.25");
    expect(line?.defaultUndecided).toBeNull();
    expect(line?.chips.some((c) => c.kind === "decision" && c.label.startsWith("Owner decision X6: 70% business use, the owner's statement, not verified by documents"))).toBe(true);
  });
  it("another account on the line is passed to the dialog preview as the line's other cents", () => {
    const f = facts();
    f.income.scheduleC.glLines.push(gl("6200", "Utilities:Phone service", "expense", 120_000));
    const x6 = sheet([], f).decisions.find((d) => d.id === "X6");
    expect(x6?.percent?.otherLineCents).toBe(120_000);
    expect(x6?.percent?.bookedCents).toBe(261_017);
  });
  it("no booked amount: the card is a placeholder with a plain note, and the other decisions keep their cards", () => {
    const m = sheet([], facts(false));
    expect(m.decisions.some((d) => d.id === "X6")).toBe(false);
    const p = m.decisionPlaceholders.find((x) => x.id === "X6");
    expect(p?.note).toMatch(/^Not raised for this return: nothing is booked to the shared household internet and phone service/);
    expect(p?.label).toBe(BUSINESS_USE_ACCOUNTS[0].label);
  });
  it("every decision the sheet shows or lists is X1 / X2 / X3 / X5 / X6", () => {
    for (const withAccount of [true, false]) {
      const m = sheet([], facts(withAccount));
      expect(new Set([...m.decisions.map((d) => d.id), ...m.decisionPlaceholders.map((p) => p.id)])).toEqual(new Set(["X1", "X2", "X3", "X5", "X6"]));
    }
  });
});

// ── source pins ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("source pins: the dialog and the sheet", () => {
  const dialog = read("components/tax/forms/override-business-use-button.tsx");
  const sheetSrc = read("components/tax/forms/return-sheet.tsx");
  const code = dialog.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");

  it("the dialog is a client component with no window.confirm / confirm()", () => {
    expect(dialog.startsWith('"use client";')).toBe(true);
    expect(code).not.toMatch(/window\.confirm|\bconfirm\s*\(/);
  });
  it("it imports no engine value (overrides.ts / line-flow), no db, no auth", () => {
    expect(dialog).not.toMatch(/line-flow|@\/lib\/db|@\/lib\/auth|@prisma/);
    for (const m of dialog.matchAll(/^import\s+(?!type\b)[^;]*from\s+"(@\/lib\/tax2025\/overrides)"/gm)) throw new Error(`value import from ${m[1]}`);
  });
  it("it is accessible and plain: ModalShell, Record / Change wording, labelled percent input, reason label, busy state, refresh in startTransition", () => {
    expect(dialog).toContain("<ModalShell");
    expect(dialog).toContain('${current === null ? "Record" : "Change"} decision ${data.id}');
    expect(dialog).toContain("Business-use percentage (0 to 100, one decimal allowed)");
    expect(dialog).toContain('inputMode="decimal"');
    expect(dialog).toContain("htmlFor={percentId}");
    expect(dialog).toContain("Reason and basis (required): how you worked out the share (for example the bill split, a usage log, hours of business use)");
    expect(dialog).toContain('{busy ? "Saving..." : "Save"}');
    expect(dialog).toContain("startTransition(() => router.refresh())");
    expect(dialog).toContain("describeActionFailure");
    expect(dialog).toContain("<HistorySection");
    expect(dialog).toContain("<ClearSection");
    expect(dialog).toContain("<AuthorityField />");
    expect(dialog).toContain('data-testid="business-use-preview"');
    expect(dialog).toContain('data-testid="business-use-phone-help"');
  });
  it("the first-phone-line help text is present (Schedule C line 25 instructions)", () => {
    expect(dialog).toContain("base rate (including taxes) of the first phone line into your home");
  });
  it("the review sheet mounts the percent dialog for a percent decision and prints the personal portion", () => {
    expect(sheetSrc).toContain("<OverrideBusinessUseButton");
    expect(sheetSrc).toContain('data-testid="personal-portion"');
    expect(sheetSrc).toContain("data-decision={d.id}");
    expect(sheetSrc).toContain("d.percent !== null");
    expect(sheetSrc).toContain("<OverrideDecisionButton");
  });
  it("the history section words a business-use target as a percentage", () => {
    const parts = read("components/tax/forms/override-parts.tsx");
    expect(parts).toContain("BUSINESS_USE_TARGET_PREFIX");
    expect(parts).toContain("{ percent: targetKey.startsWith(BUSINESS_USE_TARGET_PREFIX) }");
  });
});
