// The overpayment decisions X7 / X8 on the review sheet: the pure dialog helpers, the sheet model, a server render of the card, and
// source pins for the dialog (no jsdom in this repo; the interactive behaviour is a manual check, see the implementation notes).

import { createElement } from "react";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The decision chip is a client component that imports the (DB-backed) server actions; nothing is called while rendering.
vi.mock("@/actions/tax-return-overrides", () => ({
  setTaxReturnOverride: vi.fn(),
  clearTaxReturnOverride: vi.fn(),
  listTaxReturnOverrideHistory: vi.fn(),
}));
import { checkDecisionForm, formatOverrideHistoryRow, splitRecordedChoice } from "@/lib/tax2025/override-input";
import { applyOverrides, decisionsFromOverrides, type OverrideHistoryRow, type OverrideRow } from "@/lib/tax2025/overrides";
import { TY2025_ENGINE_VERSION, computeTy2025Return } from "@/lib/tax2025/return";
import { buildSheetModel, type SheetModel } from "@/lib/tax2025-sheet";
import { ReturnSheet } from "@/components/tax/forms/return-sheet";
import { fullFacts1b } from "./tax2025-fixtures";

(globalThis as { React?: typeof React }).React = React;

const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const NOW = new Date("2026-10-06T16:30:00Z");
const REASON = "Refund everything: the 2026 estimates are paid from the business account.";

describe("checkDecisionForm (the choice dialog)", () => {
  it("an untouched form cannot save and shows no error; a registry choice needs only the reason (unchanged)", () => {
    expect(checkDecisionForm({ choice: null, reasonText: "", busy: false })).toEqual({ canSave: false, reasonError: null, amountError: null, choiceText: null });
    expect(checkDecisionForm({ choice: "actual", reasonText: REASON, busy: false })).toEqual({ canSave: true, reasonError: null, amountError: null, choiceText: "actual" });
    expect(checkDecisionForm({ choice: "actual", reasonText: REASON, busy: true }).canSave).toBe(false);
  });
  it("refund all and apply all need no amount", () => {
    for (const choice of ["refund_all", "apply_all"]) {
      expect(checkDecisionForm({ choice, reasonText: REASON, busy: false, amountText: "", maxDollars: 16054 })).toMatchObject({ canSave: true, choiceText: choice, amountError: null });
    }
  });
  it("a stated amount: Save waits for a valid whole-dollar amount from 1 up to the limit and stores 'apply_amount:<n>'", () => {
    const check = (amountText: string, maxDollars = 16054) => checkDecisionForm({ choice: "apply_amount", reasonText: REASON, busy: false, amountText, maxDollars });
    expect(check("")).toMatchObject({ canSave: false, amountError: null, choiceText: null });
    expect(check("5000")).toMatchObject({ canSave: true, amountError: null, choiceText: "apply_amount:5000" });
    expect(check("$5,000")).toMatchObject({ canSave: true, choiceText: "apply_amount:5000" });
    expect(check("16054")).toMatchObject({ canSave: true, choiceText: "apply_amount:16054" });
    expect(check("1")).toMatchObject({ canSave: true });
    expect(check("16055")).toMatchObject({ canSave: false, choiceText: null, amountError: "That is more than the overpayment ($16,054)." });
    expect(check("0").canSave).toBe(false);
    expect(check("0").amountError).toBe("Enter the amount to apply as a whole number of dollars, at least 1.");
    expect(check("100.50")).toMatchObject({ canSave: false, amountError: "Enter whole dollars: the form takes whole dollars." });
    for (const bad of ["abc", "-5", "1e3", "5 000", "99999999"]) expect(check(bad).canSave, bad).toBe(false);
  });
  it("the reason still gates Save, and busy blocks it", () => {
    expect(checkDecisionForm({ choice: "refund_all", reasonText: "ab", busy: false, maxDollars: 10 })).toMatchObject({ canSave: false });
    expect(checkDecisionForm({ choice: "refund_all", reasonText: "ab", busy: false, maxDollars: 10 }).reasonError).toMatch(/at least 3 characters/);
    expect(checkDecisionForm({ choice: "apply_amount", reasonText: REASON, busy: true, amountText: "5", maxDollars: 10 }).canSave).toBe(false);
  });
  it("a choice with an amount field but no limit given takes no amount (the registry decisions are untouched)", () => {
    expect(checkDecisionForm({ choice: "apply_amount", reasonText: REASON, busy: false }).choiceText).toBe("apply_amount");
  });
});

describe("splitRecordedChoice (the dialog's starting state)", () => {
  it("reads a recorded overpayment choice back into the radio and the amount box", () => {
    expect(splitRecordedChoice(null)).toEqual({ choice: null, amountText: "" });
    expect(splitRecordedChoice("refund_all")).toEqual({ choice: "refund_all", amountText: "" });
    expect(splitRecordedChoice("apply_amount:5000")).toEqual({ choice: "apply_amount", amountText: "5000" });
    expect(splitRecordedChoice("actual")).toEqual({ choice: "actual", amountText: "" });
  });
});

describe("history rows for the overpayment decisions", () => {
  const row = (valueText: string, over: Partial<OverrideHistoryRow> = {}): OverrideHistoryRow => ({
    id: "r1",
    version: 1,
    valueKind: "choice",
    valueCents: null,
    valueText,
    authority: "owner",
    reason: REASON,
    setByName: "Eric",
    setAt: "2026-10-06T16:00:00.000Z",
    archivedAt: null,
    archiveKind: null,
    archiveReason: null,
    ...over,
  });
  it("'Refund all', 'Apply all to 2026', 'Apply $5,000 to 2026'; the other choices read as before", () => {
    expect(formatOverrideHistoryRow(row("refund_all")).valueText).toBe("choice: Refund all");
    expect(formatOverrideHistoryRow(row("apply_all")).valueText).toBe("choice: Apply all to 2026");
    expect(formatOverrideHistoryRow(row("apply_amount:5000")).valueText).toBe("choice: Apply $5,000 to 2026");
    expect(formatOverrideHistoryRow(row("actual")).valueText).toBe("choice: actual");
    expect(formatOverrideHistoryRow(row("70.5"), { percent: true }).valueText).toBe("70.5% business use");
    expect(formatOverrideHistoryRow(row("refund_all", { archivedAt: "2026-10-07T12:00:00.000Z", archiveKind: "cleared", archiveReason: "Changed my mind." })).state).toBe("cleared");
  });
});

// ── the sheet model ───────────────────────────────────────────────────────────────────────────────────────────────

function overFacts() {
  const f = fullFacts1b();
  f.income.w2s[0]!.fedWithheldCents = (f.income.w2s[0]!.fedWithheldCents ?? 0) + 3_000_000;
  f.income.w2s[0]!.ctWithheldCents = (f.income.w2s[0]!.ctWithheldCents ?? 0) + 600_000;
  return f;
}
function overrideRow(targetKey: string, valueText: string): OverrideRow {
  return {
    id: `row-${targetKey}`,
    taxYear: 2025,
    targetKind: "decision",
    targetKey,
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
function sheetOf(rows: OverrideRow[], f = overFacts()): { model: SheetModel; ret: ReturnType<typeof computeTy2025Return> } {
  const ret = computeTy2025Return(f, decisionsFromOverrides(rows));
  return { model: buildSheetModel({ ret, documents: [], now: NOW, effective: applyOverrides(ret, rows) }), ret };
}

describe("sheet model: the X7 and X8 cards", () => {
  it("undecided: three recordable choices (never no_election), four alternatives side by side, the limit is the engine's line", () => {
    const { model, ret } = sheetOf([]);
    const x7 = model.decisions.find((d) => d.id === "X7");
    const x8 = model.decisions.find((d) => d.id === "X8");
    expect(x7?.decisionKey).toBe("federalOverpayment");
    expect(x8?.decisionKey).toBe("ctOverpayment");
    for (const d of [x7, x8]) {
      expect(d?.undecided).toBe(true);
      expect(d?.statusText).toBe("default, undecided");
      expect(d?.choices.map((c) => c.id)).toEqual(["refund_all", "apply_all", "apply_amount"]);
      expect(d?.alternatives.map((a) => [a.id, a.marker])).toEqual([
        ["no_election", "default, undecided"],
        ["refund_all", null],
        ["apply_all", null],
        ["apply_amount", null],
      ]);
      expect(d?.percent).toBeNull();
      for (const a of d?.alternatives ?? []) expect(a.effectAmountText, a.id).toBeNull();
    }
    expect(x7?.amount).toEqual({ maxDollars: ret.lines["f1040.34"]?.amount, currentDollars: null, overpaymentLine: "Form 1040 line 34" });
    expect(x8?.amount).toEqual({ maxDollars: ret.lines["ct1040.22"]?.amount, currentDollars: null, overpaymentLine: "CT-1040 line 22" });
    expect(model.decisionPlaceholders.some((p) => p.id === "X7" || p.id === "X8")).toBe(false);
  });
  it("undecided: lines 35a / 36 and CT 25 carry the 'default, undecided' provenance", () => {
    const { model } = sheetOf([]);
    const l35a = model.federal.flatMap((g) => g.lines).find((l) => l.key === "f1040.35a");
    expect(l35a?.defaultUndecided).toContain("Overpayment on Form 1040 line 34");
    const l25 = model.connecticut.flatMap((g) => g.lines).find((l) => l.key === "ct1040.25");
    expect(l25?.defaultUndecided).toContain("Overpayment on CT-1040 line 22");
  });
  it("decided refund all: the recorded alternative is in force, who / when / reason, the lines show amounts, the chip says Change", () => {
    const { model, ret } = sheetOf([overrideRow("federalOverpayment", "refund_all"), overrideRow("ctOverpayment", "apply_amount:400")]);
    const x7 = model.decisions.find((d) => d.id === "X7");
    expect(x7?.undecided).toBe(false);
    expect(x7?.statusText).toBe("decided");
    expect(x7?.alternatives.map((a) => [a.id, a.inForce])).toEqual([["no_election", false], ["refund_all", true], ["apply_all", false], ["apply_amount", false]]);
    expect(x7?.override).toMatchObject({ by: "Eric", reason: REASON, choice: "refund_all" });
    expect(x7?.override?.note).toContain("set to Refund all");
    const x8 = model.decisions.find((d) => d.id === "X8");
    expect(x8?.override?.choice).toBe("apply_amount:400");
    expect(x8?.override?.note).toContain("set to Apply $400 to 2026");
    expect(x8?.amount?.currentDollars).toBe(400);
    const l35a = model.federal.flatMap((g) => g.lines).find((l) => l.key === "f1040.35a");
    expect(l35a?.amount).toBe(ret.lines["f1040.34"]?.amount);
    expect(l35a?.defaultUndecided).toBeNull();
    expect(l35a?.chips.some((c) => c.kind === "decision" && c.label.startsWith("Owner decision X7: refund all"))).toBe(true);
  });
  it("no overpayment: placeholders with a plain note instead of cards", () => {
    const { model } = sheetOf([], fullFacts1b());
    expect(model.decisions.some((d) => d.id === "X7" || d.id === "X8")).toBe(false);
    expect(model.decisionPlaceholders.find((p) => p.id === "X7")?.note).toMatch(/^Not raised for this return: Form 1040 line 34 is 0/);
    expect(model.decisionPlaceholders.find((p) => p.id === "X8")?.note).toMatch(/^Not raised for this return: CT-1040 line 22 is 0/);
    expect(model.decisionPlaceholders.find((p) => p.id === "X7")?.note).not.toMatch(/\bCPA\b/);
  });
});

describe("server render of the decision cards", () => {
  it("both cards render with their alternatives, the default marker and the Record chip; no wording about a CPA", () => {
    const { model } = sheetOf([]);
    const html = renderToStaticMarkup(createElement(ReturnSheet, { model }));
    expect(html).toContain('data-decision="X7"');
    expect(html).toContain('data-decision="X8"');
    expect(html).toContain("Overpayment on Form 1040 line 34");
    expect(html).toContain("Refund all (nothing applied to 2026)");
    expect(html).toContain("Apply a stated amount to 2026");
    expect(html).toContain("No election recorded (the lines print blank)");
    expect(html).toContain("default, undecided");
    expect(html).toContain("Record this decision");
    expect(html).not.toMatch(/\bCPA\b/);
  });
  it("decided: the chip changes to 'Change decision' and the recorded note shows", () => {
    const { model } = sheetOf([overrideRow("federalOverpayment", "refund_all")]);
    const html = renderToStaticMarkup(createElement(ReturnSheet, { model }));
    expect(html).toContain("Change decision");
    expect(html).toContain("set to Refund all");
  });
});

// ── source pins ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("source pins: the choice dialog", () => {
  const dialog = read("components/tax/forms/override-decision-button.tsx");
  const code = dialog.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
  it("is a client component with no window.confirm and no engine value / db / auth import", () => {
    expect(dialog.startsWith('"use client";')).toBe(true);
    expect(code).not.toMatch(/window\.confirm|\bconfirm\s*\(/);
    expect(dialog).not.toMatch(/line-flow|@\/lib\/db|@\/lib\/auth|@prisma/);
    for (const m of dialog.matchAll(/^import\s+(?!type\b)[^;]*from\s+"(@\/lib\/tax2025\/overrides)"/gm)) throw new Error(`value import from ${m[1]}`);
  });
  it("the amount input appears only for 'apply a stated amount', is labelled, numeric, and Save uses the checked text", () => {
    expect(dialog).toContain('choice === "apply_amount"');
    expect(dialog).toContain("Amount to apply to your 2026 estimated tax (whole dollars, 1 to {formatWholeDollars(data.amount.maxDollars)})");
    expect(dialog).toContain('inputMode="numeric"');
    expect(dialog).toContain("htmlFor={`${radioName}-amount`}");
    expect(dialog).toContain('data-testid="overpayment-amount"');
    expect(dialog).toContain('data-testid="overpayment-preview"');
    expect(dialog).toContain("choice: form.choiceText");
    expect(dialog).toContain("overpaymentPreview(maxDollars, modeChosen, amountText)");
  });
  it("says that applying an amount cannot be changed once the return is filed, and what stays by hand", () => {
    expect(dialog).toContain("Once the return is filed, the choice to apply an amount to 2026 cannot be changed. You can change this decision here until you file.");
    expect(dialog).toContain("Direct deposit (lines 35b to 35d) and Form 8888 are entered by hand");
    expect(dialog).toContain("Lines 24 (CHET) and 24a (charities) are never filled by this app; choosing here means none.");
    expect(dialog).not.toMatch(/\bCPA\b/);
  });
  it("the sheet passes the limit to the dialog", () => {
    expect(read("components/tax/forms/return-sheet.tsx")).toContain("amount: d.amount === null ? null : { maxDollars: d.amount.maxDollars, overpaymentLine: d.amount.overpaymentLine }");
  });
});
