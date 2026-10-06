// TESTER (independent) adversarial probes for decisions X7 / X8 (engine ty2025-1b.10). Written by the Tester, not the Coder.
// Covers what the Coder's files do not: parser fuzz table, boundary amounts through the whole return and the printed PDF, the
// whole-return line 38 penalty case (the Coder only tested it at rule level), fingerprint / approval behaviour on record, change,
// supersede and clear, and the action's canonical storage with hostile text.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { describe, expect, it } from "vitest";
import { currentApproval, NO_REVOCATION_FACTS } from "@/lib/tax-review/gate";
import { computeReturnFingerprint, changedFingerprintParts } from "@/lib/tax-review/fingerprint";
import {
  formatWholeDollars,
  isStoredOverpaymentChoice,
  overpaymentChoiceLabel,
  overpaymentPreview,
  parseOverpaymentAmount,
  parseOverpaymentChoice,
  splitOverpayment,
} from "@/lib/tax2025/overpayment";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { ct1040Map } from "@/lib/tax2025/pdf/maps/ct1040";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { applyOverrides, canonicalDecisionChoice, decisionsFromOverrides, formatOverrideNote, isValidDecisionChoice, type OverrideRow } from "@/lib/tax2025/overrides";
import { checkDecisionForm } from "@/lib/tax2025/override-input";
import { TY2025_ENGINE_VERSION, computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { hasAmount, type DecidedOverpayment, type LineKey, type Ty2025Decisions, type Ty2025Return } from "@/lib/tax2025/types";
import { fullFacts1b, owner } from "./tax2025-fixtures";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";
import { fieldOfLine } from "./tax-review-harness";

const WHO = { by: "Eric", at: "2026-10-06T12:00:00.000Z" };
const refund = (): DecidedOverpayment => ({ chosen: "refund_all", ...WHO });
const applyAmount = (n: number): DecidedOverpayment => ({ chosen: "apply_amount", appliedDollars: n, ...WHO });

function overFacts(): Ty2025Facts {
  const f = fullFacts1b();
  f.income.w2s[0]!.fedWithheldCents = (f.income.w2s[0]!.fedWithheldCents ?? 0) + 3_000_000;
  f.income.w2s[0]!.ctWithheldCents = (f.income.w2s[0]!.ctWithheldCents ?? 0) + 600_000;
  return f;
}
const amt = (r: Ty2025Return, k: LineKey): number | null => {
  const l = r.lines[k];
  return l !== undefined && hasAmount(l.status) ? l.amount : null;
};
const base0 = computeTy2025Return(overFacts(), {});
const O = amt(base0, "f1040.34") ?? -1;
const C = amt(base0, "ct1040.22") ?? -1;

// ── 1. parser fuzz ────────────────────────────────────────────────────────────────────────────────────────────────
describe("TESTER parser: hostile and boundary text", () => {
  const accepted: [string, string][] = [
    ["refund_all", "refund_all"],
    ["  refund_all  ", "refund_all"],
    ["apply_all", "apply_all"],
    ["apply_amount:1", "apply_amount:1"],
    ["apply_amount:5000", "apply_amount:5000"],
    ["apply_amount: 5000 ", "apply_amount:5000"],
    ["apply_amount:$5,000", "apply_amount:5000"],
    ["apply_amount:$ 5,000", "apply_amount:5000"],
    ["apply_amount:007", "apply_amount:7"],
    ["apply_amount:0000001", "apply_amount:1"],
    ["apply_amount:9999999", "apply_amount:9999999"],
    ["apply_amount:9,999,999", "apply_amount:9999999"],
    ["apply_amount:1,000", "apply_amount:1000"],
  ];
  for (const [input, canonical] of accepted) {
    it(`accepts ${JSON.stringify(input)} as ${canonical}`, () => {
      const p = parseOverpaymentChoice(input);
      expect(p.ok).toBe(true);
      if (p.ok) {
        expect(p.canonical).toBe(canonical);
        // canonical text re-parses to itself (idempotent) and is "stored" shape
        expect(parseOverpaymentChoice(p.canonical)).toMatchObject({ ok: true, canonical });
        expect(isStoredOverpaymentChoice(p.canonical)).toBe(true);
      }
    });
  }
  const refused = [
    "", " ", "apply_amount", "apply_amount:", "apply_amount:0", "apply_amount:00", "apply_amount:-1", "apply_amount:-0", "apply_amount:+5",
    "apply_amount:1e3", "apply_amount:1E3", "apply_amount:5e0", "apply_amount:0x10", "apply_amount:0b11", "apply_amount:1_000",
    "apply_amount:5.00", "apply_amount:5.5", "apply_amount:.5", "apply_amount:5.", "apply_amount:5,0", "apply_amount:1,00", "apply_amount:1,0000",
    "apply_amount:,500", "apply_amount:1000,", "apply_amount:5 000", "apply_amount:$", "apply_amount:$-5", "apply_amount:$$5",
    "apply_amount:NaN", "apply_amount:Infinity", "apply_amount:-Infinity", "apply_amount:abc", "apply_amount:5000abc", "apply_amount:5000:1",
    "apply_amount:12345678", "apply_amount:99999999", "apply_amount:99999999999999999999999",
    "apply_amount:٥٠٠٠", // Arabic-Indic digits
    "apply_amount:５０００", // full-width digits
    "apply_amount:5000\n6000", "apply_amount:5000;", "apply_amount:5000%",
    "refund_all:5", "refund_all ", // trailing space is trimmed -> accepted? see below
    "REFUND_ALL", "Refund_All", "apply_all:1", "apply_amount5000", "apply-amount:5000", "no_election", "refund", "apply", "schedule_a", "50", "null", "undefined",
    "__proto__", "constructor", "{}", "[]",
  ].filter((t) => t !== "refund_all "); // "refund_all " trims to a valid choice
  for (const bad of refused) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      const p = parseOverpaymentChoice(bad);
      expect(p.ok, bad).toBe(false);
      if (!p.ok) expect(p.error.length).toBeGreaterThan(10);
      expect(isValidDecisionChoice("federalOverpayment", bad)).toBe(false);
      expect(isValidDecisionChoice("ctOverpayment", bad)).toBe(false);
    });
  }
  it("the amount parser never returns a non-integer, a non-safe integer, a value below 1 or above seven digits (property sweep)", () => {
    const alphabet = ["0", "1", "5", "9", ",", ".", "$", " ", "-", "e", "x", "a"];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let oks = 0;
    for (let i = 0; i < 20000; i++) {
      const len = 1 + Math.floor(rnd() * 9);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      const p = parseOverpaymentAmount(s);
      if (p.ok) {
        oks++;
        expect(Number.isSafeInteger(p.dollars), s).toBe(true);
        expect(p.dollars, s).toBeGreaterThanOrEqual(1);
        expect(p.dollars, s).toBeLessThanOrEqual(9_999_999);
        // the digits of the input (commas / $ / spaces removed) equal the dollars as text modulo leading zeros
        expect(String(p.dollars), s).toBe(String(parseInt(s.replace(/[,$\s]/g, ""), 10)));
      }
    }
    expect(oks).toBeGreaterThan(100);
  });
  it("canonicalDecisionChoice leaves other decisions' text alone and never changes an invalid text", () => {
    expect(canonicalDecisionChoice("homeOfficeMethod", "simplified")).toBe("simplified");
    expect(canonicalDecisionChoice("federalOverpayment", "apply_amount")).toBe("apply_amount");
    expect(canonicalDecisionChoice("federalOverpayment", "apply_amount:$1,000")).toBe("apply_amount:1000");
  });
  it("labels and whole-dollar formatting", () => {
    expect(overpaymentChoiceLabel("apply_amount:1000000")).toBe("Apply $1,000,000 to 2026");
    expect(overpaymentChoiceLabel("apply_amount:999")).toBe("Apply $999 to 2026");
    expect(overpaymentChoiceLabel("nope")).toBeNull();
    expect(formatWholeDollars(0)).toBe("$0");
    expect(formatWholeDollars(1234567)).toBe("$1,234,567");
  });
  it("splitOverpayment boundaries: equal to available, one above, available 0, bad numbers never print a NaN", () => {
    expect(splitOverpayment(100, "apply_amount", 100)).toEqual({ refunded: 0, applied: 100 });
    expect(splitOverpayment(100, "apply_amount", 101)).toBeNull();
    expect(splitOverpayment(100, "apply_amount", 1)).toEqual({ refunded: 99, applied: 1 });
    expect(splitOverpayment(100, "apply_amount", 0)).toBeNull();
    expect(splitOverpayment(100, "apply_amount", null)).toBeNull();
    expect(splitOverpayment(0, "refund_all", null)).toEqual({ refunded: 0, applied: 0 });
    expect(splitOverpayment(0, "apply_amount", 1)).toBeNull();
    expect(splitOverpayment(100, "apply_amount", -3)).toBeNull();
    expect(overpaymentPreview(16054, "apply_amount", "5000")).toBe("Refunded: $11,054; applied to 2026: $5,000");
    expect(overpaymentPreview(16054, "apply_amount", "16055")).toBeNull();
    expect(overpaymentPreview(16054, "apply_amount", "1e3")).toBeNull();
    expect(overpaymentPreview(16054, "refund_all", "garbage")).toBe("Refunded: $16,054; applied to 2026: $0");
  });
  it("the dialog check: Save waits for a valid amount within the limit; whitespace / zero / cents / over-limit never produce a choiceText", () => {
    const st = (amountText: string) => checkDecisionForm({ choice: "apply_amount", reasonText: "A written reason here.", busy: false, amountText, maxDollars: 904 });
    expect(st("400")).toMatchObject({ canSave: true, choiceText: "apply_amount:400" });
    expect(st(" 904 ")).toMatchObject({ canSave: true, choiceText: "apply_amount:904" });
    for (const bad of ["", "0", "905", "1.5", "-1", "1e3", "abc", "99999999"]) {
      const r = st(bad);
      expect(r.canSave, bad).toBe(false);
      expect(r.choiceText, bad).toBeNull();
    }
    expect(st("").amountError).toBeNull(); // untouched: no error yet
    expect(st("905").amountError).toContain("more than the overpayment");
    expect(checkDecisionForm({ choice: "refund_all", reasonText: "A written reason here.", busy: false, amountText: "garbage", maxDollars: 904 })).toMatchObject({ canSave: true, choiceText: "refund_all" });
    expect(checkDecisionForm({ choice: "refund_all", reasonText: "ab", busy: false, maxDollars: 904 }).canSave).toBe(false);
    expect(checkDecisionForm({ choice: "refund_all", reasonText: "A written reason here.", busy: true, maxDollars: 904 }).canSave).toBe(false);
    expect(checkDecisionForm({ choice: null, reasonText: "A written reason here.", busy: false }).canSave).toBe(false);
  });
});

// ── 2. boundaries through the whole return and the printed forms ─────────────────────────────────────────────────
async function printed(decisions: Ty2025Decisions, facts = overFacts()) {
  const ret = computeTy2025Return(facts, decisions);
  const view = toPdfReturnView(ret, facts, { generatedAt: "2026-10-06T12:00:00.000Z", generatedBy: "Tester" });
  const fed = await readAllFields((await fillForm("f1040", view, f1040Map, DEFAULT_FILL_OPTIONS)).bytes);
  const ct = await readAllFields((await fillForm("ct1040", view, ct1040Map, DEFAULT_FILL_OPTIONS)).bytes);
  const f = (line: string) => String(fed.get(fieldOfLine(f1040Map, line)) ?? "");
  const c = (field: string) => String(ct.get(`ct1040.${field}`) ?? "");
  return { ret, f, c };
}

describe("TESTER boundaries through the engine and the PDF", () => {
  it("apply_amount = the whole overpayment: 35a is a computed 0 that prints BLANK (never '0'), 36 prints the amount; CT 25 blank, 23 prints", async () => {
    const p = await printed({ federalOverpayment: applyAmount(O), ctOverpayment: applyAmount(C) });
    expect(amt(p.ret, "f1040.35a")).toBe(0);
    expect(p.ret.lines["f1040.35a"]?.status).toBe("computed");
    expect(p.f("f1040.35a")).toBe("");
    expect(p.f("f1040.36")).toBe(O.toLocaleString("en-US"));
    expect(p.c("l25")).toBe("");
    expect(p.c("l23")).toBe(C.toLocaleString("en-US"));
    expect(p.ret.headline.complete).toBe(true);
    expect(p.ret.headline.blockingItemCount).toBe(0);
  });
  it("apply_amount:1 prints 35a = O - 1 and 36 = 1; CT 23 = 1, 25 = C - 1", async () => {
    const p = await printed({ federalOverpayment: applyAmount(1), ctOverpayment: applyAmount(1) });
    expect(p.f("f1040.35a")).toBe((O - 1).toLocaleString("en-US"));
    expect(p.f("f1040.36")).toBe("1");
    expect(p.c("l23")).toBe("1");
    expect(p.c("l25")).toBe((C - 1).toLocaleString("en-US"));
  });
  it("one dollar above the overpayment prints NOTHING on 35a / 36 / 23 / 25 (blocked, never a half-printed split) and blocks the headline", async () => {
    const p = await printed({ federalOverpayment: applyAmount(O + 1), ctOverpayment: applyAmount(C + 1) });
    for (const line of ["f1040.35a", "f1040.36"]) expect(p.f(line), line).toBe("");
    for (const f of ["l23", "l25"]) expect(p.c(f), f).toBe("");
    expect(p.ret.headline.complete).toBe(false);
    expect(p.ret.headline.blockingItemCount).toBeGreaterThan(0);
  });
  it("neither decision changes any tax / AGI / payment / headline line, for every choice (full line diff against the undecided run)", () => {
    const own = new Set<string>(["f1040.35a", "f1040.36", "ct1040.23", "ct1040.25"]);
    const cases: Ty2025Decisions[] = [
      { federalOverpayment: refund(), ctOverpayment: refund() },
      { federalOverpayment: { chosen: "apply_all", ...WHO }, ctOverpayment: { chosen: "apply_all", ...WHO } },
      { federalOverpayment: applyAmount(1), ctOverpayment: applyAmount(1) },
      { federalOverpayment: applyAmount(O), ctOverpayment: applyAmount(C) },
    ];
    for (const d of cases) {
      const r = computeTy2025Return(overFacts(), d);
      for (const k of Object.keys(base0.lines) as LineKey[]) {
        if (own.has(k)) continue;
        expect(r.lines[k]?.amount, k).toBe(base0.lines[k]?.amount);
        expect(r.lines[k]?.status, k).toBe(base0.lines[k]?.status);
      }
      expect(r.headline.federal).toEqual(base0.headline.federal);
      expect(r.headline.connecticut).toEqual(base0.headline.connecticut);
    }
  });
  it("balance due: decisions that are recorded anyway change nothing (no lines move, 35a / 36 / 23 / 25 not_applicable 0 print blank)", async () => {
    const due = fullFacts1b();
    const a = computeTy2025Return(due, {});
    const b = computeTy2025Return(due, { federalOverpayment: refund(), ctOverpayment: applyAmount(5) });
    for (const k of Object.keys(a.lines) as LineKey[]) {
      expect(b.lines[k]?.amount, k).toBe(a.lines[k]?.amount);
      expect(b.lines[k]?.status, k).toBe(a.lines[k]?.status);
    }
    expect(b.decisions.some((d) => d.id === "X7" || d.id === "X8")).toBe(false);
    expect(b.headline.undecidedDecisionCount).toBe(a.headline.undecidedDecisionCount);
    const p = await printed({ federalOverpayment: refund() }, due);
    expect(p.f("f1040.35a")).toBe("");
    expect(p.f("f1040.36")).toBe("");
    expect(p.c("l23") + p.c("l24") + p.c("l24a") + p.c("l25")).toBe("");
  });
});

// ── 3. whole-return line 38 penalty (the Coder only tested the rule level) ───────────────────────────────────────
/** A balance-due return plus ONE federal estimate paid on the last installment date: Form 2210 sees early installments underpaid (a penalty) while the total payments exceed the tax (an overpayment). */
function penaltyFacts(estimateDollars: number): Ty2025Facts {
  const f = fullFacts1b();
  f.payments.federalEstimates = owner([{ paidOn: "2026-01-15", amountCents: estimateDollars * 100, appliesToTaxYear: 2025 }]);
  return f;
}
describe("TESTER whole-return line 38 penalty netting ('Lines 35a, 36 and 38 must equal line 34')", () => {
  const probe = (n: number) => computeTy2025Return(penaltyFacts(n), {});
  // find an estimate that yields BOTH a line 34 overpayment and a line 38 penalty > 0 (search, do not assume)
  let found: { n: number; o: number; p: number } | null = null;
  for (const n of [5000, 10000, 20000, 30000, 40000, 60000, 80000, 120000]) {
    const r = probe(n);
    const o = amt(r, "f1040.34");
    const p = amt(r, "f1040.38");
    if (o !== null && o > 0 && p !== null && p > 0) {
      found = { n, o, p };
      break;
    }
  }
  it("the probe fixture really produces an overpayment AND a printed penalty", () => {
    expect(found, "no estimate size produced overpayment + penalty: adjust the fixture").not.toBeNull();
    console.info("TESTER penalty fixture:", JSON.stringify(found));
  });
  it("refund_all prints 35a = 34 - 38, 36 blank; apply_all prints 36 = 34 - 38; a stated amount splits 34 - 38; 35a + 36 + 38 = 34 on the PRINTED form", async () => {
    if (found === null) return;
    const { n, o, p } = found;
    const facts = penaltyFacts(n);
    const r = await printed({ federalOverpayment: refund() }, facts);
    expect(amt(r.ret, "f1040.35a")).toBe(o - p);
    expect(amt(r.ret, "f1040.36")).toBe(0);
    expect(r.f("f1040.36")).toBe("");
    const a = await printed({ federalOverpayment: { chosen: "apply_all", ...WHO } }, facts);
    expect(amt(a.ret, "f1040.36")).toBe(o - p);
    expect(amt(a.ret, "f1040.35a")).toBe(0);
    if (o - p > 1) {
      const s = await printed({ federalOverpayment: applyAmount(1) }, facts);
      expect(amt(s.ret, "f1040.35a")).toBe(o - p - 1);
      expect(amt(s.ret, "f1040.36")).toBe(1);
      const sum = (v: string) => (v === "" ? 0 : parseInt(v.replace(/,/g, ""), 10));
      expect(sum(s.f("f1040.35a")) + sum(s.f("f1040.36")) + sum(s.f("f1040.38"))).toBe(sum(s.f("f1040.34")));
    }
    // the maximum amount that can be applied is 34 - 38, not 34: one more blocks
    expect(computeTy2025Return(facts, { federalOverpayment: applyAmount(o - p + 1) }).lines["f1040.35a"]?.status).toBe("missing_input");
    expect(computeTy2025Return(facts, { federalOverpayment: applyAmount(o - p) }).lines["f1040.36"]?.status).toBe("computed");
  });
});

describe("TESTER whole-return penalty ABOVE the overpayment (line 38 > line 34 > 0)", () => {
  it("prints 0 / 0 on 35a and 36 for every choice, raises the advisory 'overpayment-penalty-exceeds', blocks a stated amount, and leaves line 37 alone (documented R4)", () => {
    let hit: { n: number; o: number; p: number } | null = null;
    for (let n = 4000; n <= 40000 && hit === null; n += 100) {
      const r = computeTy2025Return(penaltyFacts(n), {});
      const o = amt(r, "f1040.34");
      const p = amt(r, "f1040.38");
      if (o !== null && p !== null && o > 0 && p > o) hit = { n, o, p };
    }
    console.info("TESTER P>O fixture:", JSON.stringify(hit));
    if (hit === null) return; // reported in the test report if this fixture shape cannot produce P > O
    const facts = penaltyFacts(hit.n);
    for (const d of [refund(), { chosen: "apply_all" as const, ...WHO }]) {
      const r = computeTy2025Return(facts, { federalOverpayment: d });
      expect(amt(r, "f1040.35a")).toBe(0);
      expect(amt(r, "f1040.36")).toBe(0);
      expect(r.openItems.some((i) => i.id === "overpayment-penalty-exceeds" && i.severity === "advisory")).toBe(true);
      expect(amt(r, "f1040.37")).toBe(0); // documented limitation R4: line 37 does not carry (line 38 - line 34) = $61; the advisory item says to check it by hand
      expect(r.headline.blockingItemCount).toBe(computeTy2025Return(facts, {}).headline.blockingItemCount);
    }
    expect(computeTy2025Return(facts, { federalOverpayment: applyAmount(1) }).lines["f1040.35a"]?.status).toBe("missing_input");
    // the advisory also exists while undecided (the penalty is above the overpayment whatever is chosen)
    expect(computeTy2025Return(facts, {}).openItems.some((i) => i.id === "overpayment-penalty-exceeds")).toBe(true);
  });
});

// ── 3b. line-flow edges are behavioural: a pin upstream flags the lines downstream as 'depends on an override' ───────
describe("TESTER line-flow edges for the new lines (mutation M8 showed no existing test pins ct1040.23 -> ct1040.25)", () => {
  const pinRow = (key: string, dollars: number): OverrideRow => ({
    id: `pin-${key}`, taxYear: 2025, targetKind: "line", targetKey: key, version: 1, valueKind: "money_cents", valueCents: dollars * 100, valueText: null,
    computedSnapshot: { status: "computed", cents: null, engineVersion: TY2025_ENGINE_VERSION }, authority: "owner", reason: "Per the notice.", setByName: "Eric",
    setAt: new Date("2026-10-06T16:00:00.000Z"), archivedAt: null,
  });
  const dependsOn = (pinKey: string, dollars: number, target: string): LineKey[] => {
    const decisions: Ty2025Decisions = { federalOverpayment: refund(), ctOverpayment: applyAmount(400) };
    const ret = computeTy2025Return(overFacts(), decisions);
    const cents = (amt(ret, pinKey as LineKey) ?? 0) * 100;
    const row = { ...pinRow(pinKey, dollars), computedSnapshot: { status: ret.lines[pinKey as LineKey]?.status ?? "computed", cents, engineVersion: TY2025_ENGINE_VERSION } };
    const eff = applyOverrides(ret, [row]);
    return eff.lines[target as LineKey]?.dependsOnOverridden ?? [];
  };
  it("a pin on CT line 23 flags CT line 25", () => expect(dependsOn("ct1040.23", 300, "ct1040.25")).toContain("ct1040.23"));
  it("a pin on CT line 22 flags CT lines 23 and 25", () => {
    expect(dependsOn("ct1040.22", 1000, "ct1040.23")).toContain("ct1040.22");
    expect(dependsOn("ct1040.22", 1000, "ct1040.25")).toContain("ct1040.22");
  });
  it("a pin on Form 1040 line 38 flags lines 35a and 36; a pin on line 34 flags both too", () => {
    expect(dependsOn("f1040.38", 50, "f1040.35a")).toContain("f1040.38");
    expect(dependsOn("f1040.38", 50, "f1040.36")).toContain("f1040.38");
    expect(dependsOn("f1040.34", 9000, "f1040.35a")).toContain("f1040.34");
    expect(dependsOn("f1040.34", 9000, "f1040.36")).toContain("f1040.34");
  });
});

// ── 4. fingerprint and approval ──────────────────────────────────────────────────────────────────────────────────
describe("TESTER fingerprint and approval behaviour on record / change / supersede / clear", () => {
  const AT = new Date("2026-10-06T16:00:00.000Z");
  const row = (id: string, key: string, text: string, version = 1, archivedAt: Date | null = null): OverrideRow => ({
    id, taxYear: 2025, targetKind: "decision", targetKey: key, version, valueKind: "choice", valueCents: null, valueText: text,
    computedSnapshot: { status: "default_undecided", cents: null, engineVersion: TY2025_ENGINE_VERSION }, authority: "owner",
    reason: "A written reason for the test.", setByName: "Eric", setAt: AT, archivedAt,
  });
  function fp(rows: OverrideRow[]) {
    const facts = overFacts();
    const active = rows.filter((r) => r.archivedAt === null); // the real loader (loadActiveOverrides) reads only active rows
    const ret = computeTy2025Return(facts, decisionsFromOverrides(active));
    const effective = applyOverrides(ret, active);
    const view = toPdfReturnView(ret, facts, { generatedAt: "2026-10-06T16:00:00.000Z", generatedBy: "Tester", overrides: { effective, formatNote: formatOverrideNote } });
    return computeReturnFingerprint({
      engineVersion: ret.engineVersion, viewFingerprint: view.fingerprint, answers: view.answers, header: view.header, facts,
      documents: [], questionnaires: [], overrides: active, decisions: view.decisions,
    });
  }
  const none = fp([]);
  const x7refund = fp([row("a", "federalOverpayment", "refund_all")]);
  const x7a5000 = fp([row("b", "federalOverpayment", "apply_amount:5000", 2), row("a", "federalOverpayment", "refund_all", 1, AT)]);
  const x7a5001 = fp([row("c", "federalOverpayment", "apply_amount:5001", 3), row("b", "federalOverpayment", "apply_amount:5000", 2, AT)]);
  const x8refund = fp([row("d", "ctOverpayment", "refund_all")]);
  const cleared = fp([row("a", "federalOverpayment", "refund_all", 1, AT)]); // archived, nothing active
  it("recording, changing the choice, changing the amount by $1 and recording the other decision each give a new fingerprint", () => {
    const all = [none, x7refund, x7a5000, x7a5001, x8refund].map((x) => x.fingerprint);
    expect(new Set(all).size).toBe(all.length);
    expect(changedFingerprintParts(none.parts, x7refund.parts)).toEqual(expect.arrayContaining(["view", "overrides", "decisions"]));
    expect(changedFingerprintParts(x7a5000.parts, x7a5001.parts)).toEqual(expect.arrayContaining(["overrides"]));
  });
  it("clearing returns to the undecided state's fingerprint (the decision row is archived, never deleted)", () => {
    expect(cleared.fingerprint).toBe(none.fingerprint);
  });
  it("a recorded amount of 5,000 and a record of 'apply_amount:$5,000' in the same canonical state still differ only through the stored row text", () => {
    const canonical = fp([row("b", "federalOverpayment", "apply_amount:5000")]);
    const decorated = fp([row("b", "federalOverpayment", "apply_amount:$5,000")]);
    // same engine state, different stored text -> the overrides part (row text) differs; the view part must NOT (decision chosen is canonical)
    expect(changedFingerprintParts(canonical.parts, decorated.parts)).toEqual(["overrides"]);
  });
  it("an approval bound to the state with X7 refund_all stops counting when X7 is changed, when X8 is recorded, and when the engine version moves; it counts again only for the same fingerprint", () => {
    const approvals = [{ kind: "approved" as const, fingerprint: x7refund.fingerprint, at: "2026-10-06T17:00:00.000Z" }];
    expect(currentApproval(approvals, x7refund.fingerprint, NO_REVOCATION_FACTS)).not.toBeNull();
    for (const other of [x7a5000, x8refund, none]) expect(currentApproval(approvals, other.fingerprint, NO_REVOCATION_FACTS)).toBeNull();
    const bumped = computeReturnFingerprint({
      engineVersion: "ty2025-1b.11", viewFingerprint: "x", answers: {}, header: {}, facts: {}, documents: [], questionnaires: [], overrides: [], decisions: [],
    });
    expect(currentApproval(approvals, bumped.fingerprint, NO_REVOCATION_FACTS)).toBeNull();
  });
});

// ── 5. the review layers on the penalty cases (the Coder's L1 / L2 tests have no line 38 > 0 return) ─────────────────
import { sourceTieoutCheck } from "@/lib/tax-review/l1/source-tieout";
import type { L1Context } from "@/lib/tax-review/l1/context";
import { runL2 } from "@/lib/tax-review/l2";

describe("TESTER L1 refund-split and L2 oracle on whole returns with a printed line 38 penalty", () => {
  const cases: [string, number][] = [["penalty below the overpayment (O 7,985, P 146)", 20000], ["penalty above the overpayment (O 85, P 146)", 12100]];
  const decisionSets: [string, Ty2025Decisions][] = [
    ["refund_all", { federalOverpayment: refund() }],
    ["apply_all", { federalOverpayment: { chosen: "apply_all", ...WHO } }],
    ["apply_amount:1", { federalOverpayment: applyAmount(1) }],
  ];
  for (const [label, n] of cases) {
    for (const [dname, d] of decisionSets) {
      it(`${label}, ${dname}: L1.C1.refund-split finds nothing, and L2 has zero mismatches (or the engine blocks the amount)`, async () => {
        const facts = penaltyFacts(n);
        const ret = computeTy2025Return(facts, d);
        const view = toPdfReturnView(ret, facts, { generatedAt: "2026-10-06T16:00:00.000Z", generatedBy: "Tester" });
        const found = (await sourceTieoutCheck.run({ ret, view, facts, raw: null } as unknown as L1Context)).filter((x) => x.check.startsWith("L1.C1.refund-split"));
        expect(found).toEqual([]);
        const l2 = runL2({ ret, effective: applyOverrides(ret, []), facts });
        if (ret.lines["f1040.35a"]?.status === "missing_input") return; // apply_amount above what is available: blocked, nothing printed
        expect(l2.status).toBe("ran");
        expect(l2.summary.mismatchCount).toBe(0);
      });
    }
  }
});

// ── 6. the real final package build (fails closed on banned wording) and the index text we write ─────────────────────
import { unzipSync } from "fflate";
import { buildFinalPackage, buildIndexLines, scanChrome } from "@/lib/tax2025/pdf/final-package";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { findFinalPackageBannedWording } from "@/lib/tax-wording";

describe("TESTER the real final package with decisions X7 / X8", () => {
  for (const [name, d] of [
    ["undecided (the package is only reachable after approval, but the build must still scan clean)", {}],
    ["refund all", { federalOverpayment: refund(), ctOverpayment: refund() }],
    ["a stated amount", { federalOverpayment: applyAmount(5000), ctOverpayment: applyAmount(400) }],
  ] as [string, Ty2025Decisions][]) {
    it(`${name}: buildFinalPackage succeeds (its own scan is fail-closed); the index text has no banned wording and, once decided, no decision wording`, async () => {
      const facts = overFacts();
      const ret = computeTy2025Return(facts, d);
      const view = toPdfReturnView(ret, facts, { generatedAt: "2026-10-06T16:00:00.000Z", generatedBy: "Tester" });
      const result = await buildFinalPackage(view, { maps: FORM_MAPS });
      if (!result.ok) throw new Error(`final package refused: ${result.reason}`);
      expect(Object.keys(unzipSync(result.zip)).filter((n) => n.endsWith(".pdf")).length).toBeGreaterThan(3);
      const idx = buildIndexLines({ view, formFiles: [{ name: "forms/01-f1040.pdf", title: "Form 1040" }], attachments: [], notIncluded: [], hasForm8949Summary: false });
      expect(scanChrome(idx)).toEqual([]);
      const text = idx.map((l) => (l.block.kind === "kv" ? `${l.block.label}: ${l.block.value}` : "text" in l.block ? l.block.text : "")).join("\n");
      expect(text).toContain("Enter by hand before filing"); // positive control: the text is real
      expect(findFinalPackageBannedWording(text)).toEqual([]);
      if (Object.keys(d).length > 0) for (const needle of ["X7", "X8", "decision X", "app fills", "Or record", "Form 1040 lines 35a and 36", "CT-1040 lines 23, 24 and 24a"]) expect(text.includes(needle), needle).toBe(false);
      else for (const needle of ["Form 1040 lines 35a and 36", "CT-1040 lines 23, 24 and 24a"]) expect(text.includes(needle), needle).toBe(true);
    });
  }
});
