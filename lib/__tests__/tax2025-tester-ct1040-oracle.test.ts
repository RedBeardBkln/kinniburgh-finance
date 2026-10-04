// Tester oracle (ty2025-ct1040-derived-lines): an INDEPENDENT transcription of CT-1040 (Rev. 12/25) lines 3-30 and
// Schedule 3 / 4 from the printed form + instructions, fuzzed against the engine and the filled PDF.
// Only line 6 (tax tables / Tax Calculation Schedule, unchanged by this task), the W-2 withholding (18), estimates (19)
// and extension (20) are taken from the engine as inputs; everything derived is recomputed here with plain integers.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 280000 });
import { describe, expect, it } from "vitest";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { ct1040Map } from "@/lib/tax2025/pdf/maps/ct1040";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { computeCtPropertyTaxCredit } from "@/lib/tax2025/rules/ct";
import { D } from "@/lib/tax2025/money";
import { hasAmount, type LineKey, type Ty2025Return } from "@/lib/tax2025/types";
import { bill, fullFacts, owner } from "./tax2025-fixtures";
import { DEFAULT_FILL_OPTIONS, readAllFields, type FieldValue } from "./tax2025-pdf-harness";

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Round half up on integer cents -> whole dollars (positive amounts only here). */
const roundCents = (cents: number): number => Math.floor((cents + 50) / 100);

/** Form decimal table (MFJ), transcribed from "Property Tax Credit Table" Rev. 12/25. "More than lo, less than or equal hi". */
function mfjDecimalHundredths(ctAgi: number): number {
  if (ctAgi <= 70500) return 0;
  if (ctAgi <= 80500) return 15;
  if (ctAgi <= 90500) return 30;
  if (ctAgi <= 100500) return 45;
  if (ctAgi <= 110500) return 60;
  if (ctAgi <= 120500) return 75;
  if (ctAgi <= 130500) return 90;
  return 100;
}

interface Scenario {
  facts: Ty2025Facts;
  /** inputs the oracle needs */
  ctAgiTarget: number;
  bills: Array<{ kind: "primary_residence" | "motor_vehicle" | "other_real_estate"; cents: number | null }>;
  w2Cents: [number, number];
  estCents: number;
  priorCents: number;
  extCents: number;
  useTaxCents: number;
  credits: "none" | "yes" | "unanswered";
  otherState: "none" | "yes" | "unanswered";
}

const AGIS = [8_000, 23_999, 24_000, 24_001, 60_000, 101_999, 102_000, 102_001, 108_000, 125_000, 130_500, 130_501, 200_000, 270_980, 500_000, 1_200_000];

function wholeAmount(ret: Ty2025Return, key: LineKey): number | null {
  const l = ret.lines[key];
  return l !== undefined && hasAmount(l.status) && l.amount !== null ? l.amount : null;
}

function scenario(rnd: () => number): Scenario {
  const f = fullFacts();
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const ctAgiTarget = rnd() < 0.7 ? pick(AGIS) : 20_000 + Math.floor(rnd() * 400_000);
  // bills: home (1-2 bills, with cents), 0-3 vehicles, maybe other real estate
  const bills: Scenario["bills"] = [];
  const nHome = pick([0, 1, 1, 2]);
  for (let i = 0; i < nHome; i++) bills.push({ kind: "primary_residence", cents: Math.floor(rnd() * 900_000) + (rnd() < 0.3 ? 50 : 0) });
  const nVeh = pick([0, 1, 2, 3]);
  for (let i = 0; i < nVeh; i++) bills.push({ kind: "motor_vehicle", cents: Math.floor(rnd() * 40_000) + (rnd() < 0.5 ? 50 : 0) });
  if (rnd() < 0.2) bills.push({ kind: "other_real_estate", cents: 200_000 });
  f.deductions.propertyTaxBills = bills.map((b, i) =>
    bill({
      docId: `pt-${i}`,
      label: `Bill ${i}`,
      address: b.kind === "primary_residence" ? "27 Old Barry Rd" : null,
      paidInYearCents: b.cents,
      kind: b.kind,
      taxType: b.kind === "motor_vehicle" ? "motor_vehicle" : "real_estate",
    })
  );
  const credits = pick(["none", "none", "none", "yes", "unanswered"] as const);
  const otherState = pick(["none", "none", "none", "yes", "unanswered"] as const);
  const set = (g: "ct_other_credits" | "ct_other_state_tax", v: "none" | "yes" | "unanswered") => {
    if (v === "none") f.statedNone[g] = owner(true);
    else if (v === "yes") f.statedNone[g] = owner(false);
    else delete f.statedNone[g];
  };
  set("ct_other_credits", credits);
  set("ct_other_state_tax", otherState);

  // set federal AGI -> CT AGI target via a stated addition/subtraction
  const fed = wholeAmount(computeTy2025Return(f), "f1040.11a");
  if (fed === null) throw new Error("fed AGI not computed");
  const diff = fed - ctAgiTarget;
  if (diff >= 0) f.ct.subtractions = owner(diff * 100);
  else f.ct.additions = owner(-diff * 100);

  const useTaxCents = pick([0, 0, 0, 0, 5_000, 12_345, 99_999]);
  f.ct.useTax = owner(useTaxCents);

  const w2Cents: [number, number] = [Math.floor(rnd() * 2_000_000), Math.floor(rnd() * 800_000)];
  const [a, b] = f.income.w2s;
  a!.ctWithheldCents = w2Cents[0];
  b!.ctWithheldCents = w2Cents[1];
  const estCents = pick([0, 0, 0, 250_000, 1_000_001, 333_333]);
  const priorCents = pick([0, 0, 0, 10_000, 99_950]);
  const extCents = pick([0, 0, 0, 500_000, 25_050]);
  f.payments.ctEstimates = owner(estCents > 0 ? [{ paidOn: "2025-06-15", amountCents: estCents, appliesToTaxYear: 2025 }] : []);
  f.payments.ctPriorYearOverpaymentApplied = owner(priorCents);
  f.payments.ctExtensionPayment = owner(extCents);
  return { facts: f, ctAgiTarget, bills, w2Cents, estCents, priorCents, extCents, useTaxCents, credits, otherState };
}

/** The independent oracle. Returns the expected whole-dollar values; null = the engine must NOT print an amount. */
function oracle(s: Scenario, ret: Ty2025Return) {
  const L = (k: LineKey) => wholeAmount(ret, k);
  const l1 = L("f1040.11a");
  const l5 = L("ct1040.ctAgi");
  const out: Record<string, number | null> = {};
  out.l5 = l5;
  const l6 = L("ct1040.6"); // tax table / schedule (input)
  const l7 = s.otherState === "none" ? 0 : null; // + w2 with other state withholding: none in these fixtures
  out.l7 = l7;
  out.l8 = l6 !== null && l7 !== null ? Math.max(0, l6 - l7) : null;
  const l9 = L("ct1040.9"); // line 9 comes from the federal AMT screen (input)
  out.l10 = out.l8 !== null && l9 !== null ? out.l8 + l9 : null;
  // Schedule 3
  const unclassifiedOrUnpaid = s.bills.some((b) => (b.kind === "primary_residence" || b.kind === "motor_vehicle") && b.cents === null);
  let l11: number | null = null;
  let s3: { l63: number; l65: number; l67: number; l68: number } | null = null;
  if (l5 !== null && !unclassifiedOrUnpaid) {
    const dec = mfjDecimalHundredths(l5);
    if (dec === 100) l11 = 0;
    else if (out.l10 === null) l11 = null;
    else if (out.l10 === 0) l11 = 0;
    else {
      const home = s.bills.filter((b) => b.kind === "primary_residence").reduce((a, b) => a + (b.cents ?? 0), 0);
      const homeRows = s.bills.some((b) => b.kind === "primary_residence") ? [roundCents(home)] : [];
      const veh = s.bills
        .filter((b) => b.kind === "motor_vehicle")
        .map((b) => roundCents(b.cents ?? 0))
        .sort((x, y) => y - x)
        .slice(0, 2);
      const l63 = [...homeRows, ...veh].reduce((a, x) => a + x, 0);
      const l65 = Math.min(l63, 300);
      const l67 = Math.floor((l65 * dec + 50) / 100); // half up on whole dollars
      const l68 = l65 - l67;
      s3 = { l63, l65, l67, l68 };
      l11 = Math.min(l68, out.l10);
    }
  }
  out.l11 = l11;
  out.l12 = out.l10 !== null && l11 !== null ? Math.max(0, out.l10 - l11) : null;
  const l13 = s.credits === "none" ? 0 : null;
  out.l13 = l13;
  out.l14 = out.l12 !== null && l13 !== null ? Math.max(0, out.l12 - l13) : null;
  out.l15 = Math.floor((s.useTaxCents + 50) / 100);
  out.l16 = out.l14 !== null ? out.l14 + out.l15 : null;
  out.l17 = out.l16;
  // payments (inputs from engine for 18, 19, 20; 20a-d from the answer)
  const l18 = L("ct1040.18");
  const l19 = L("ct1040.19");
  const l20 = L("ct1040.20");
  const l20x = s.credits === "none" ? 0 : null;
  out.l18 = l18;
  out.l21 = l18 !== null && l19 !== null && l20 !== null && l20x !== null ? l18 + l19 + l20 + 4 * l20x : null;
  out.l22 = out.l21 !== null && out.l17 !== null ? Math.max(0, out.l21 - out.l17) : null;
  out.l26 = out.l21 !== null && out.l17 !== null ? Math.max(0, out.l17 - out.l21) : null;
  out.s3 = s3 === null ? null : 1;
  return { out, s3, l1, l6 };
}

const FIELDS: Record<string, LineKey> = {
  l5: "ct1040.ctAgi",
  l7: "ct1040.7",
  l8: "ct1040.8",
  l10: "ct1040.10",
  l11: "ct1040.11",
  l12: "ct1040.12",
  l13: "ct1040.13",
  l14: "ct1040.14",
  l15: "ct1040.15",
  l16: "ct1040.16",
  l17: "ct1040.17",
  l21: "ct1040.21",
  l22: "ct1040.22",
  l26: "ct1040.26",
};

describe("tester oracle: CT-1040 lines 3-30 (engine lines)", () => {
  it("1,500 random scenarios: every derived line equals the independent oracle; blocked inputs never produce an amount", () => {
    const rnd = mulberry(20261004);
    let blockedChain = 0;
    let computedChain = 0;
    let withCredit = 0;
    let due = 0;
    let over = 0;
    for (let i = 0; i < 1500; i++) {
      const s = scenario(rnd);
      const ret = computeTy2025Return(s.facts);
      const { out, s3 } = oracle(s, ret);
      for (const [f, key] of Object.entries(FIELDS)) {
        const want = out[f];
        const got = wholeAmount(ret, key);
        if (want === undefined) continue;
        expect(got, `#${i} ${f} ${key} (agi ${s.ctAgiTarget}, credits ${s.credits}, otherState ${s.otherState}) status=${ret.lines[key]?.status}`).toBe(want);
      }
      // line 3, 25, 27-30
      expect(wholeAmount(ret, "ct1040.3")).toBe(wholeAmount(ret, "f1040.11a") === null ? null : (wholeAmount(ret, "f1040.11a") ?? 0) + (wholeAmount(ret, "ct1040.additions") ?? 0));
      const l14 = out.l14 ?? null;
      const l18 = wholeAmount(ret, "ct1040.18");
      const l22 = out.l22 ?? null;
      const l26 = out.l26 ?? null;
      if (l14 !== null && l18 !== null && l22 !== null && l26 !== null && s.credits === "none") {
        // settlement
        const l29 = ret.lines["ct1040.29"];
        if (l14 - l18 < 1000) {
          expect(l29?.status, `#${i} l29 under 1000: ${l14}-${l18}`).toBe("not_applicable");
          expect(l29?.amount).toBe(0);
        } else {
          expect(hasAmount(l29?.status ?? "missing_input"), `#${i} l29 at/over 1000 must not be an amount (${l14}-${l18})`).toBe(false);
        }
        const l25 = ret.lines["ct1040.25"];
        if (l22 === 0) expect(l25?.status).toBe("not_applicable");
        else {
          expect(hasAmount(l25?.status ?? "missing_input")).toBe(false);
          expect(l25?.reason ?? "").toContain(`$${l22.toLocaleString("en-US")}`);
        }
        for (const k of ["ct1040.27", "ct1040.28"] as const) {
          if (l26 === 0) expect(ret.lines[k]?.status).toBe("not_applicable");
          else expect(hasAmount(ret.lines[k]?.status ?? "missing_input"), `#${i} ${k} with L26 ${l26}`).toBe(false);
        }
        const l30 = ret.lines["ct1040.30"];
        const all0 = l26 === 0 && l14 - l18 < 1000;
        if (all0) expect(wholeAmount(ret, "ct1040.30")).toBe(0);
        else expect(hasAmount(l30?.status ?? "missing_input"), `#${i} l30 must not be an amount when 27/28/29 are not final`).toBe(false);
        // balance sign
        expect(wholeAmount(ret, "ct1040.balance" as LineKey)).toBe(l26 - l22);
        computedChain++;
        if (l26 > 0) due++;
        if (l22 > 0) over++;
      } else if (s.credits !== "none" || s.otherState !== "none") {
        blockedChain++;
        // never an amount downstream of a gated line
        for (const k of ["ct1040.14", "ct1040.16", "ct1040.17", "ct1040.21", "ct1040.22", "ct1040.26", "ct1040.balance"] as LineKey[]) {
          if (s.credits !== "none") expect(hasAmount(ret.lines[k]?.status ?? "missing_input"), `#${i} ${k} must be blocked with credits=${s.credits}`).toBe(false);
        }
        expect(ret.headline.complete, `#${i} headline cannot be complete with a gated answer`).toBe(false);
      }
      if (s3 !== null && s3.l68 > 0) withCredit++;
    }
    // the fuzz must have exercised each branch
    expect(computedChain).toBeGreaterThan(150);
    expect(blockedChain).toBeGreaterThan(150);
    expect(withCredit).toBeGreaterThan(30);
    expect(due).toBeGreaterThan(30);
    expect(over).toBeGreaterThan(30);
  });
});

describe("tester oracle: CT-1040 printed fields", () => {
  it("30 scenarios: every printed field equals the oracle; blank only where the oracle is 0 (computed) or blocked; Schedule 3 rows foot", async () => {
    const rnd = mulberry(77);
    for (let i = 0; i < 30; i++) {
      const s = scenario(rnd);
      const ret = computeTy2025Return(s.facts);
      const view = toPdfReturnView(ret, s.facts, { generatedAt: "2026-10-04T12:00:00.000Z", generatedBy: "Oracle" });
      const res = await fillForm("ct1040", view, ct1040Map, DEFAULT_FILL_OPTIONS);
      const fields: Map<string, FieldValue> = await readAllFields(res.bytes);
      const num = (n: string): number | null => {
        const v = fields.get(`ct1040.${n}`);
        return typeof v === "string" && v !== "" ? Number(v.replace(/,/g, "")) : null;
      };
      const { out, s3 } = oracle(s, ret);
      for (const f of ["l5", "l7", "l8", "l10", "l12", "l13", "l14", "l15", "l16", "l17", "l21", "l22", "l26"]) {
        const want = out[f];
        if (want === null || want === undefined) {
          expect(num(f), `#${i} ${f} must be blank when blocked`).toBeNull();
        } else if (want !== 0) {
          expect(num(f), `#${i} ${f}`).toBe(want);
        } else {
          // zero: blank or "0", never anything else
          expect([null, 0].includes(num(f)), `#${i} ${f} zero`).toBe(true);
        }
      }
      // blocked line 7/13/20a-d never prints a 0
      if (s.otherState !== "none") expect(num("l7"), `#${i} l7 with otherState=${s.otherState}`).toBeNull();
      if (s.credits !== "none") for (const f of ["l13", "l20a", "l20b", "l20c", "l20d"]) expect(num(f), `#${i} ${f} with credits=${s.credits}`).toBeNull();
      // the printed form's own arithmetic, when everything it needs is printed (blank = computed 0 only when the engine line has an amount)
      const val = (n: string, key: LineKey): number | null => num(n) ?? (wholeAmount(ret, key) !== null ? 0 : null);
      const chk = (name: string, out_: number | null, parts: Array<number | null>, fn: (p: number[]) => number) => {
        if (out_ === null || parts.some((p) => p === null)) return;
        expect(out_, `#${i} printed ${name}`).toBe(fn(parts as number[]));
      };
      chk("3=1+2", val("l3", "ct1040.3"), [val("l1", "ct1040.1"), val("l2", "ct1040.additions")], (p) => p[0]! + p[1]!);
      chk("5=3-4", val("l5", "ct1040.ctAgi"), [val("l3", "ct1040.3"), val("l4", "ct1040.subtractions")], (p) => p[0]! - p[1]!);
      chk("8", val("l8", "ct1040.8"), [val("l6", "ct1040.6"), val("l7", "ct1040.7")], (p) => Math.max(0, p[0]! - p[1]!));
      chk("10", val("l10", "ct1040.10"), [val("l8", "ct1040.8"), val("l9", "ct1040.9")], (p) => p[0]! + p[1]!);
      chk("12", val("l12", "ct1040.12"), [val("l10", "ct1040.10"), val("l11", "ct1040.11")], (p) => Math.max(0, p[0]! - p[1]!));
      chk("14", val("l14", "ct1040.14"), [val("l12", "ct1040.12"), val("l13", "ct1040.13")], (p) => Math.max(0, p[0]! - p[1]!));
      chk("16", val("l16", "ct1040.16"), [val("l14", "ct1040.14"), val("l15", "ct1040.15")], (p) => p[0]! + p[1]!);
      chk("17", val("l17", "ct1040.17"), [val("l16", "ct1040.16")], (p) => p[0]!);
      chk(
        "21",
        val("l21", "ct1040.21"),
        [val("l18", "ct1040.18"), val("l19", "ct1040.19"), val("l20", "ct1040.20"), val("l20a", "ct1040.20a"), val("l20b", "ct1040.20b"), val("l20c", "ct1040.20c"), val("l20d", "ct1040.20d")],
        (p) => p.reduce((a, x) => a + x, 0)
      );
      chk("22", val("l22", "ct1040.22"), [val("l21", "ct1040.21"), val("l17", "ct1040.17")], (p) => Math.max(0, p[0]! - p[1]!));
      chk("26", val("l26", "ct1040.26"), [val("l17", "ct1040.17"), val("l21", "ct1040.21")], (p) => Math.max(0, p[0]! - p[1]!));
      // 22 and 26 never both print; 23/24/24a/25/27-30 never print an amount
      expect((num("l22") ?? 0) === 0 || (num("l26") ?? 0) === 0).toBe(true);
      for (const f of ["l23", "l24", "l24a", "l25", "l27", "l28", "l29", "l30"]) {
        const v = num(f);
        if (f === "l29" || f === "l30" || f === "l27" || f === "l28") expect([null, 0].includes(v), `#${i} ${f} prints ${v}`).toBe(true);
        else expect(v, `#${i} ${f}`).toBeNull();
      }
      // Schedule 3: rows add to 63, 65 = min(63, 300), 68 = 65 - 67, 11 = 68
      const rows = (num("l60") ?? 0) + (num("l61") ?? 0) + (num("l62") ?? 0);
      if (s3 !== null) {
        expect(rows, `#${i} rows 60-62 add to 63`).toBe(s3.l63);
        if (s3.l63 !== 0) expect(num("l63"), `#${i} l63`).toBe(s3.l63);
        if (s3.l65 !== 0) expect(num("l65"), `#${i} l65`).toBe(s3.l65);
        if (s3.l67 !== 0) expect(num("l67"), `#${i} l67`).toBe(s3.l67);
        if (s3.l68 !== 0) expect(num("l68"), `#${i} l68`).toBe(s3.l68);
      } else if (out.l11 === 0 && out.l10 !== null) {
        // nothing claimed: if line 63 is not printed the rows must not be either (no row-60-only schedule)
        if (num("l63") === null) expect(rows, `#${i} Schedule 3 rows without a total`).toBe(0);
      }
    }
  });
});

describe("tester probes", () => {
  it("Schedule 3 tie rounding is in form order: 65 = 10, decimal .75 -> 67 = round(7.5) = 8, 68 = 2 (the old 65 x (1 - decimal) would give 3)", () => {
    const r = computeCtPropertyTaxCredit({
      ctAgi: D(115000),
      ctTaxBeforeCredits: D(5000),
      bills: [{ docId: "v", label: "Auto", kind: "motor_vehicle", paid: D("10.00") }],
    });
    const get = (k: LineKey) => r.lines.find((l) => l.key === k)?.amount?.toNumber();
    expect(get("ct1040.s3.63")).toBe(10);
    expect(get("ct1040.s3.65")).toBe(10);
    expect(get("ct1040.s3.67")).toBe(8);
    expect(get("ct1040.11")).toBe(2);
  });

  // Line 18 is the sum of the whole-dollar Column C rows (one per W-2), not the rounded sum of the cents (fixed in rules/payments.ts)
  it("withholding rows with cents: printed rows 18a-e add to printed line 18 (CT-1040 line 18 = sum of Column C)", async () => {
    const f = fullFacts();
    const [a, b] = f.income.w2s;
    a!.ctWithheldCents = 10_050;
    b!.ctWithheldCents = 10_050;
    const ret = computeTy2025Return(f);
    const view = toPdfReturnView(ret, f, { generatedAt: "2026-10-04T12:00:00.000Z", generatedBy: "Probe" });
    const res = await fillForm("ct1040", view, ct1040Map, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(res.bytes);
    const n = (k: string): number => Number(String(fields.get(`ct1040.${k}`) ?? "").replace(/,/g, "") || 0);
    const rowSum = n("l18a") + n("l18b") + n("l18c") + n("l18d") + n("l18e");
    expect(rowSum).toBe(n("l18"));
    expect(n("l18")).toBe(202); // 101 + 101, not round(201.00)
    expect(ret.lines["ct1040.18"]?.amount).toBe(202);
  });
});
