// Tester oracles for engine ty2025-1b.6 (Form 8995 lines 1i-17, Form 6251 screen lines 1a-4 / 9, Schedule A line 14).
// Independent integer arithmetic written from the 2025 Form 8995 / Form 6251 printed text (data/forms/2025/f8995.pdf, f6251.pdf),
// compared with the rules on seeded random inputs. No engine helper is used to compute an expected value.
import { describe, expect, it } from "vitest";
import { D } from "@/lib/tax2025/money";
import { computeQbi8995 } from "@/lib/tax2025/rules/qbi-8995";
import { computeAmtScreen } from "@/lib/tax2025/rules/screens";
import { computeScheduleA, type DonationInput, type ScheduleAInput } from "@/lib/tax2025/rules/schedule-a";
import type { LineKey, RuleResult } from "@/lib/tax2025/types";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const ri = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

/** whole-dollar half-up of x * pct / 100 for non-negative integers (IRS rounding: 50 cents rounds up). */
const pctHalfUp = (x: number, pct: number): number => Math.floor((x * pct + 50) / 100);

function lineNum(r: RuleResult, key: LineKey): number | null {
  const l = r.lines.find((x) => x.key === key);
  if (!l) return undefined as unknown as null;
  return l.amount === null ? null : Number(l.amount.toString());
}

interface QIn {
  profit: number;
  half: number;
  health: number;
  retire: number;
  ti: number;
  qd: number;
  ncg: number;
  d199: number;
  c3: number;
  c7: number;
}

/** Form 8995 oracle, line by line from the printed form. */
function oracle8995(i: QIn) {
  const l1 = i.profit - i.half - i.health - i.retire;
  const l2 = l1;
  const l3 = i.c3;
  const l4 = Math.max(0, l2 + l3);
  const l5 = pctHalfUp(l4, 20);
  const l6 = Math.max(0, i.d199);
  const l7 = i.c7;
  const l8 = Math.max(0, l6 + l7);
  const l9 = pctHalfUp(l8, 20);
  const l10 = l5 + l9;
  const l11 = Math.max(0, i.ti);
  const l12 = i.qd + Math.max(0, i.ncg);
  const l13 = Math.max(0, l11 - l12);
  const l14 = pctHalfUp(l13, 20);
  const l15 = Math.min(l10, l14);
  const l16 = Math.min(0, l2 + l3);
  const l17 = Math.min(0, l6 + l7);
  return { l1, l2, l4, l5, l6, l8, l9, l10, l11, l12, l13, l14, l15, l16, l17 };
}

describe("tester oracle: Form 8995 lines 1i-17 (own integer arithmetic)", () => {
  const r = lcg(20251004);
  const cases: QIn[] = [];
  for (let n = 0; n < 4000; n++) {
    const mode = n % 8;
    cases.push({
      profit: mode === 0 ? ri(r, -60000, 0) : ri(r, -30000, 150000),
      half: ri(r, 0, 9000),
      health: mode === 1 ? ri(r, 0, 25000) : 0,
      retire: mode === 2 ? ri(r, 0, 25000) : 0,
      ti: mode === 3 ? ri(r, 394000, 395200) : ri(r, 0, 394600),
      qd: ri(r, 0, 30000),
      ncg: ri(r, -3000, 60000),
      d199: mode === 4 ? ri(r, 0, 8000) : r() < 0.2 ? ri(r, 0, 3000) : 0,
      c3: mode === 5 || mode === 6 ? -ri(r, 0, 40000) : 0,
      c7: mode === 6 || mode === 7 ? -ri(r, 0, 6000) : 0,
    });
  }

  it("matches the oracle on 4,000 seeded patterns (loss only, loss + REIT, carry-ins, threshold edge)", () => {
    let loss16 = 0;
    let loss17 = 0;
    let over = 0;
    for (const c of cases) {
      const res = computeQbi8995({
        scheduleCNetProfit: D(c.profit),
        deductibleHalfSeTax: D(c.half),
        seHealthInsurance: D(c.health),
        seRetirement: D(c.retire),
        taxableIncomeBeforeQbi: D(c.ti),
        qualifiedDividends: D(c.qd),
        netCapitalGain: D(c.ncg),
        section199aDividends: D(c.d199),
        priorQbiLossCarryforward: D(c.c3),
        priorReitPtpLossCarryforward: D(c.c7),
      });
      const o = oracle8995(c);
      const ctx = JSON.stringify(c);
      if (Math.max(0, c.ti) > 394600) {
        over++;
        expect(res.status, ctx).toBe("needs_cpa_judgment");
        expect(res.lines.map((l) => l.key), ctx).toEqual(["f1040.13a"]);
        continue;
      }
      expect(res.status, ctx).toBe("computed");
      const pairs: [LineKey, number][] = [
        ["f8995.1i", o.l1],
        ["f8995.2", o.l2],
        ["f8995.4", o.l4],
        ["f8995.5", o.l5],
        ["f8995.6", o.l6],
        ["f8995.8", o.l8],
        ["f8995.9", o.l9],
        ["f8995.10", o.l10],
        ["f8995.11", o.l11],
        ["f8995.12", o.l12],
        ["f8995.13", o.l13],
        ["f8995.14", o.l14],
        ["f8995.15", o.l15],
        ["f8995.16", o.l16],
        ["f8995.17", o.l17],
        ["f1040.13a", o.l15],
      ];
      for (const [k, v] of pairs) expect(lineNum(res, k), `${k} ${ctx}`).toBe(v === 0 ? 0 : v);
      if (o.l16 < 0) loss16++;
      if (o.l17 < 0) loss17++;
      // lines 3 and 7 are owned by the none-group loop, never emitted by the rule
      expect(res.lines.find((l) => l.key === "f8995.3")).toBeUndefined();
      expect(res.lines.find((l) => l.key === "f8995.7")).toBeUndefined();
    }
    // the fuzz really reached the interesting branches
    expect(loss16).toBeGreaterThan(300);
    expect(loss17).toBeGreaterThan(30);
    expect(over).toBeGreaterThan(100);
  });

  it("exactly 394,600 is Form 8995; 394,601 is not", () => {
    const base = {
      scheduleCNetProfit: D(-9010),
      deductibleHalfSeTax: D(0),
      seHealthInsurance: D(0),
      seRetirement: D(0),
      qualifiedDividends: D(0),
      netCapitalGain: D(0),
      section199aDividends: D(0),
    };
    expect(computeQbi8995({ ...base, taxableIncomeBeforeQbi: D(394600) }).status).toBe("computed");
    expect(lineNum(computeQbi8995({ ...base, taxableIncomeBeforeQbi: D(394600) }), "f8995.16")).toBe(-9010);
    const above = computeQbi8995({ ...base, taxableIncomeBeforeQbi: D(394601) });
    expect(above.status).toBe("needs_cpa_judgment");
    expect(above.lines.find((l) => l.key === "f8995.16")).toBeUndefined();
  });

  it("Eric's shape: QBI -9,010, taxable income before QBI 220,025, net capital gain 5,557 -> 11 = 220,025; 12 = 5,557; 13 = 214,468; 14 = 42,894; 15 = 0; 16 = -9,010", () => {
    const res = computeQbi8995({
      scheduleCNetProfit: D(-9010),
      deductibleHalfSeTax: D(0),
      seHealthInsurance: D(0),
      seRetirement: D(0),
      taxableIncomeBeforeQbi: D(220025),
      qualifiedDividends: D(0),
      netCapitalGain: D(5557),
      section199aDividends: D(0),
    });
    const got = ["f8995.11", "f8995.12", "f8995.13", "f8995.14", "f8995.15", "f8995.16", "f8995.17"].map((k) => lineNum(res, k as LineKey));
    expect(got).toEqual([220025, 5557, 214468, 42894, 0, -9010, 0]);
  });
});

interface AIn {
  agi: number;
  d14: number;
  sr37: number;
  itemizing: boolean;
  taxes7: number;
  std12e: number;
  pab: number;
  regular: number;
  pref: boolean;
}

/** Form 6251 oracle: lines 1a, 1b, 2a, 2g, 4, 5, 6, 7 (the printed 28% shortcut), 9, 11. */
function oracle6251(i: AIn) {
  const l1a = i.d14 - i.sr37;
  const l1b = i.agi - l1a;
  const l2a = i.itemizing ? i.taxes7 : i.std12e;
  const l4 = l1b + l2a + i.pab;
  if (l4 > 1252700) return { l1a, l1b, l2a, l4, over: true as const };
  const l6 = Math.max(0, l4 - 137000);
  // Form line 7 ("All others"): 26% when line 6 is 239,100 or less; otherwise 28% minus 4,782
  const l7 = l6 <= 239100 ? pctHalfUp(l6, 26) : Math.floor((l6 * 28 + 50) / 100) - 4782;
  const l9 = l7;
  return { l1a, l1b, l2a, l4, over: false as const, l6, l9 };
}

describe("tester oracle: Form 6251 screen lines 1a / 1b / 2a / 4 / 9 (own arithmetic, the form's own 28% shortcut)", () => {
  const r = lcg(6251);
  it("matches the oracle on 6,000 seeded patterns incl. seniors, negative line 1b, itemizing and the standard deduction", () => {
    let negative1b = 0;
    let withSenior = 0;
    let computedAmt = 0;
    let crossedExemption = 0;
    for (let n = 0; n < 6000; n++) {
      const mode = n % 6;
      const d14 = ri(r, 0, 130000);
      const c: AIn = {
        agi: mode === 0 ? ri(r, 0, d14 + 3000) : mode === 5 ? ri(r, 400000, 1300000) : ri(r, 0, 600000),
        d14,
        sr37: mode === 1 || mode === 2 || mode === 0 ? Math.min(d14, ri(r, 0, 12000)) : 0,
        itemizing: n % 2 === 0,
        taxes7: ri(r, 0, 60000),
        std12e: ri(r, 31500, 40000),
        pab: r() < 0.2 ? ri(r, 0, 20000) : 0,
        regular: ri(r, 0, 250000),
        pref: r() < 0.4,
      };
      const res = computeAmtScreen({
        agi: D(c.agi),
        deductionsLine14: D(c.d14),
        seniorDeduction: D(c.sr37),
        itemizing: c.itemizing,
        scheduleATaxes: c.itemizing ? D(c.taxes7) : null,
        standardDeduction: c.itemizing ? null : D(c.std12e),
        privateActivityBondInterest: D(c.pab),
        regularTax: D(c.regular),
        hasPreferentialIncome: c.pref,
      });
      const o = oracle6251(c);
      const ctx = JSON.stringify(c);
      expect(lineNum(res, "f6251.amti"), ctx).toBe(o.l4);
      if (o.l1b < 0) negative1b++;
      if (c.sr37 > 0) withSenior++;
      if (o.over) {
        expect(res.status, ctx).toBe("needs_cpa_rule_unverified");
        continue;
      }
      expect(lineNum(res, "f6251.tmt"), ctx).toBe(o.l9);
      if (o.l4 > 137000) crossedExemption++;
      if (o.l9 <= c.regular) {
        expect(res.status, ctx).toBe("computed");
        expect(lineNum(res, "f6251.amt"), ctx).toBe(0);
      } else if (c.pref) {
        expect(res.status, ctx).toBe("needs_cpa_rule_unverified");
      } else {
        expect(lineNum(res, "f6251.amt"), ctx).toBe(o.l9 - c.regular);
        computedAmt++;
      }
    }
    expect(negative1b).toBeGreaterThan(200);
    expect(withSenior).toBeGreaterThan(1000);
    expect(computedAmt).toBeGreaterThan(50);
    expect(crossedExemption).toBeGreaterThan(1000);
  });

  it("the tentative minimum tax line is labelled Form 6251 line 9 and amti line 4", () => {
    const res = computeAmtScreen({
      agi: D(200000),
      deductionsLine14: D(31500),
      seniorDeduction: D(0),
      itemizing: false,
      scheduleATaxes: null,
      standardDeduction: D(31500),
      privateActivityBondInterest: D(0),
      regularTax: D(30000),
      hasPreferentialIncome: false,
    });
    expect(res.lines.find((l) => l.key === "f6251.tmt")?.formLine).toBe("6251 line 9");
    expect(res.lines.find((l) => l.key === "f6251.amti")?.formLine).toBe("6251 line 4");
  });
});

// ── Schedule A line 14 (decision D3): the sum of the PRINTED whole-dollar lines 11 + 12 + 13 ────────────────────

/** whole dollars, half up, from integer cents */
const dollarsFromCents = (c: number): number => Math.floor((c + 50) / 100);

function donation(kind: "cash" | "noncash", cents: number, n: number): DonationInput {
  return { id: `t-${kind}-${n}`, kind, amount: D(cents).div(100), amountCents: cents, substantiation: "written_acknowledgment", receiptDocumentId: "r1" };
}

function schA(donations: DonationInput[], agi = 500000): ScheduleAInput {
  return {
    agi: D(agi),
    ctWithholding: D(4200),
    ctEstimatesPaidIn2025: D(2000),
    ctPriorYearBalancePaidIn2025: D(500),
    propertyBills: [],
    propertyTaxNoneConfirmed: true,
    mortgages: [],
    donations,
    donationsNoneConfirmed: donations.length === 0,
  };
}

describe("tester oracle: Schedule A line 14 = printed line 11 + line 12 (+ line 13 = 0)", () => {
  it("golden: cash 100.40 + noncash 200.40 -> 100 + 200 = 300; lines 11 and 12 themselves are the per-line rounded sums", () => {
    const res = computeScheduleA(schA([donation("cash", 10040, 1), donation("noncash", 20040, 2)]));
    expect(lineNum(res, "scha.11")).toBe(100);
    expect(lineNum(res, "scha.12")).toBe(200);
    expect(lineNum(res, "scha.14")).toBe(300);
  });

  it("2,000 seeded donation sets: lines 11 / 12 equal the rounded cents sums, line 14 equals their sum", () => {
    const r = lcg(14);
    for (let n = 0; n < 2000; n++) {
      const k = ri(r, 1, 5);
      const ds: DonationInput[] = [];
      let cash = 0;
      let non = 0;
      for (let j = 0; j < k; j++) {
        const cents = ri(r, 1, 300000);
        const kind = r() < 0.5 ? "cash" : "noncash";
        ds.push(donation(kind, cents, j));
        if (kind === "cash") cash += cents;
        else non += cents;
      }
      const res = computeScheduleA(schA(ds));
      const ctx = JSON.stringify(ds.map((d) => [d.kind, d.amountCents]));
      expect(lineNum(res, "scha.11"), ctx).toBe(dollarsFromCents(cash));
      expect(lineNum(res, "scha.12"), ctx).toBe(dollarsFromCents(non));
      expect(lineNum(res, "scha.14"), ctx).toBe(dollarsFromCents(cash) + dollarsFromCents(non));
    }
  });

  it("the 20%-of-AGI test still runs on the whole cents total: 30,000.01 on AGI 150,000 rounds to 30,000 (within), 30,000.50 rounds to 30,001 (over)", () => {
    const within = computeScheduleA(schA([donation("cash", 3000001, 1)], 150000));
    expect(lineNum(within, "scha.14")).toBe(30000);
    const over = computeScheduleA(schA([donation("cash", 3000050, 1)], 150000));
    expect(over.lines.find((l) => l.key === "scha.14")?.status).toBe("needs_cpa_rule_unverified");
  });

  it("documented consequence of D3: cash 10,000.50 + noncash 19,999.50 on AGI 150,000 passes the 20% test (total 30,000.00) but prints line 14 = 30,001", () => {
    const res = computeScheduleA(schA([donation("cash", 1000050, 1), donation("noncash", 1999950, 2)], 150000));
    expect(lineNum(res, "scha.14")).toBe(30001);
  });
});

// ── Form 8995 PDF: the sign convention of the pre-printed parentheses ─────────────────────────────────────────────
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { f8995Map } from "@/lib/tax2025/pdf/maps/f8995";
import { linesOf, required, viewWith } from "./fixtures/tax2025-pdf-mvp2-ct.fixture";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";

describe("tester: Form 8995 PDF lines 3 / 7 / 16 / 17 (pre-printed parentheses)", () => {
  const P = "topmostSubform[0].Page1[0].";
  const NO_STAMP = { ...DEFAULT_FILL_OPTIONS, stamp: false };
  it("a NEGATIVE amount prints its magnitude; a POSITIVE amount (e.g. a carry-in typed as 3000 instead of -3000 in an override) prints BLANK, silently - pinned so a later guard is a deliberate change; the convention is documented in specs/09 and in the override dialog hint (amountEntryHint)", async () => {
    const mk = (l3: number, l7: number) => viewWith({ lines: linesOf([["f8995.3", l3], ["f8995.7", l7]]), formsRequired: { f8995: required(true) } });
    const neg = await readAllFields((await fillForm("f8995", mk(-3000, -400), f8995Map, NO_STAMP)).bytes);
    expect([neg.get(`${P}f1_19[0]`), neg.get(`${P}f1_23[0]`)]).toEqual(["3,000", "400"]);
    const pos = await readAllFields((await fillForm("f8995", mk(3000, 400), f8995Map, NO_STAMP)).bytes);
    expect([pos.get(`${P}f1_19[0]`), pos.get(`${P}f1_23[0]`)]).toEqual(["", ""]);
  });
});
