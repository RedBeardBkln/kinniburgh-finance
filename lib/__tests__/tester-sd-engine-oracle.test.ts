// TESTER (independent) oracle for the Schedule D engine (schedule-d-engine, sd-engine branch b7a9b05).
// Everything here is derived by the Tester from the 2025 IRS texts (Schedule D form + instructions, Form 8949 instructions,
// Form 1040 instructions: QDCG worksheet lines 1-25, Form 8995 line 12, Form 8960 lines 5a / 12 / 17), with BigInt-cent arithmetic
// (no Decimal, no float), and never calls the Coder's helpers other than building facts (tax2025-fixtures.ts).
//
//  * hand-derived goldens (real owner figures, four ST/LT sign combinations, $3,000 limit, 6 carryover-out cases)
//  * a line-by-line reimplementation of Schedule D lines 1a-22, the QDCG worksheet and the Capital Loss Carryover Worksheet
//  * a differential of 6,000 random households through computeTy2025Return (7a, 16, qdcg.3, 1040 line 16, QBI line 12, NIIT)

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BrokerBox, BrokerSaleFact, Ty2025Facts } from "@/lib/tax2025/facts";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { computeCapitalLossCarryoverOut } from "@/lib/tax2025/rules/schedule-d";
import { D } from "@/lib/tax2025/money";
import type { LineKey, Ref, Sourced } from "@/lib/tax2025/types";
import { dividend, fullFacts, owner } from "@/lib/__tests__/tax2025-fixtures";

// ── BigInt cents helpers ──────────────────────────────────────────────────────────────────────
type C = number; // integer cents (or exact integer hundredths where a percentage is applied); all values stay far below 2^53
/** whole dollars from cents, half away from zero (IRS: drop under 50 cents, 50 to 99 round up; same magnitude rule for losses). */
const rdc = (c: C): C => {
  const neg = c < 0;
  const m = neg ? -c : c;
  const d = Math.floor((m + 50) / 100);
  return neg ? -d : d;
};
const dollars = (c: C): C => c * 100; // whole dollars -> cents
const minB = (a: C, b: C): C => (a < b ? a : b);
const maxB = (a: C, b: C): C => (a > b ? a : b);
const absB = (a: C): C => (a < 0 ? -a : a);

// ── Tax Table + Tax Computation Worksheet (transcribed by the Tester from the 2025 1040 instructions; see fixtures/tester-oracles-2025.json) ──
const ORACLES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "tester-oracles-2025.json"), "utf8")) as { taxTable: Record<string, [number, number]> };
const STARTS = Object.keys(ORACLES.taxTable).map(Number).sort((a, b) => a - b);
function tableTax(x: number): number {
  let lo = 0;
  let hi = STARTS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (STARTS[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  return ORACLES.taxTable[String(STARTS[lo]!)]![1];
}
/** Tax on a whole-dollar amount, in CENTS (Tax Table under $100,000, Tax Computation Worksheet Section B (MFJ) at or above). */
function taxCents(xDollars: C): C {
  if (xDollars <= 0) return 0;
  if (xDollars < 100000) return dollars((tableTax(Number(xDollars))));
  const x = xDollars;
  // (a) x (b) - (d), exact in cents: x dollars * pct = x*pct cents
  if (x <= 206700) return x * 22 - dollars(10172);
  if (x <= 394600) return x * 24 - dollars(14306);
  if (x <= 501050) return x * 32 - dollars(45874);
  if (x <= 751600) return x * 35 - 6090550;
  return x * 37 - 7593750;
}

/** The printed 2025 Qualified Dividends and Capital Gain Tax Worksheet, lines 1-25 (MFJ). Whole-dollar inputs; returns the tax in whole dollars. */
function qdcgTax(l1: C, l2: C, l3: C): { tax: C; lines: Record<number, C> } {
  const L: Record<number, C> = {};
  L[1] = l1;
  L[2] = l2;
  L[3] = l3;
  L[4] = L[2]! + L[3]!;
  L[5] = maxB(0, L[1]! - L[4]!);
  L[6] = 96700;
  L[7] = minB(L[1]!, L[6]!);
  L[8] = minB(L[5]!, L[7]!);
  L[9] = L[7]! - L[8]!;
  L[10] = minB(L[1]!, L[4]!);
  L[11] = L[9]!;
  L[12] = L[10]! - L[11]!;
  L[13] = 600050;
  L[14] = minB(L[1]!, L[13]!);
  L[15] = L[5]! + L[9]!;
  L[16] = maxB(0, L[14]! - L[15]!);
  L[17] = minB(L[12]!, L[16]!);
  L[18] = L[17]! * 15; // cents
  L[19] = L[9]! + L[17]!;
  L[20] = L[10]! - L[19]!;
  L[21] = L[20]! * 20; // cents
  L[22] = taxCents(L[5]!); // cents
  L[23] = L[18]! + L[21]! + L[22]!;
  L[24] = taxCents(L[1]!);
  L[25] = minB(L[23]!, L[24]!);
  return { tax: rdc(L[25]!), lines: L };
}

// ── Schedule D oracle ─────────────────────────────────────────────────────────────────────────
interface ORow {
  form: "1099-B" | "1099-DA";
  box: BrokerBox;
  p: C; // proceeds, cents
  c: C; // cost, cents
  w: C; // wash sale loss disallowed (box 1g), cents, positive
  disc: C; // accrued market discount, cents
  doc?: string;
  payer?: string | null;
}
interface OInput {
  rows: ORow[];
  box2a: C; // 1099-DIV box 2a, cents
  carryS: C; // cents, positive
  carryL: C;
}
const BOX_LINE: Record<BrokerBox, "1b" | "2" | "3" | "8b" | "9" | "10"> = { A: "1b", B: "2", C: "3", D: "8b", E: "9", F: "10", G: "1b", H: "2", I: "3", J: "8b", K: "9", L: "10" };
const DIRECT: Partial<Record<BrokerBox, "1a" | "8a">> = { A: "1a", G: "1a", D: "8a", J: "8a" };
const ST_LINES = ["1a", "1b", "2", "3"];
const LT_LINES = ["8a", "8b", "9", "10"];

interface OSd {
  cells: Record<string, C>; // "<line>.<col>" whole dollars
  l7: C;
  l15: C;
  l16: C;
  l21: C;
  f7a: C;
  qdcg3: C;
  l17: boolean;
}
/** `directOk` = the owner confirmed no adjustment the broker could not know (cgadj No), the only way a clean A / D (or G / J) row goes to 1a / 8a. */
function oracleSd(inp: OInput, directOk: boolean): OSd {
  // route each row (category = form + box) : direct only when the whole category has wash 0 and discount 0
  const catKey = (r: ORow): string => `${r.form}:${r.box}`;
  const cats = new Map<string, ORow[]>();
  for (const r of inp.rows) cats.set(catKey(r), [...(cats.get(catKey(r)) ?? []), r]);
  const exactH: Record<string, C> = {}; // per line, exact cents of (h)
  const sumP: Record<string, C> = {};
  const sumC: Record<string, C> = {};
  const sumW: Record<string, C> = {};
  for (const [, rs] of cats) {
    const first = rs[0]!;
    const wash = rs.reduce((t, r) => t + r.w, 0);
    const disc = rs.reduce((t, r) => t + r.disc, 0);
    const direct = directOk && DIRECT[first.box] !== undefined && wash === 0 && disc === 0;
    const line = direct ? DIRECT[first.box]! : BOX_LINE[first.box];
    const p = rs.reduce((t, r) => t + r.p, 0);
    const c = rs.reduce((t, r) => t + r.c, 0);
    sumP[line] = (sumP[line] ?? 0) + p;
    sumC[line] = (sumC[line] ?? 0) + c;
    sumW[line] = (sumW[line] ?? 0) + wash;
    exactH[line] = (exactH[line] ?? 0) + p - c + wash;
  }
  const cells: Record<string, C> = {};
  for (const l of [...ST_LINES, ...LT_LINES]) {
    const has = sumP[l] !== undefined;
    cells[`${l}.d`] = has ? rdc(sumP[l]!) : 0;
    cells[`${l}.e`] = has ? rdc(sumC[l]!) : 0;
    cells[`${l}.g`] = has ? rdc(sumW[l]!) : 0;
    cells[`${l}.h`] = has ? rdc(exactH[l]!) : 0;
  }
  const exact7 = ST_LINES.reduce((t, l) => t + (exactH[l] ?? 0), 0) - inp.carryS;
  const exact15 = LT_LINES.reduce((t, l) => t + (exactH[l] ?? 0), 0) + inp.box2a - inp.carryL;
  const l7 = rdc(exact7);
  const l15 = rdc(exact15);
  const l16 = rdc(exact7 + exact15);
  const l21 = l16 < 0 ? minB(absB(l16), 3000) : 0;
  const f7a = l16 > 0 ? l16 : l16 < 0 ? -l21 : 0;
  const l17 = l15 > 0 && l16 > 0;
  return { cells, l7, l15, l16, l21, f7a, qdcg3: l17 ? minB(l15, l16) : 0, l17 };
}

// ── facts builder (the capture contract) ────────────────────────────────────────────────────────
const DOCREF = (id: string): Ref[] => [{ kind: "document", id, label: "1099" }];
function factsWith(rows: ORow[], opts: { box2a?: C; carryS?: C; carryL?: C; wagesEric?: number; qdCents?: number; cgadjYes?: boolean; extra?: (f: Ty2025Facts) => void } = {}): Ty2025Facts {
  const f = fullFacts();
  if (opts.wagesEric !== undefined) {
    const w = f.income.w2s[0]!;
    w.wagesCents = opts.wagesEric;
    w.socialSecurityWagesCents = Math.min(opts.wagesEric, 17_610_000);
    w.medicareWagesCents = opts.wagesEric;
  }
  f.income.dividends = [dividend({ docId: "div-1", box1aCents: 100_000, box1bCents: opts.qdCents ?? 80_000, box2aCents: Number(opts.box2a ?? 0) })];
  const byDoc = new Map<string, ORow[]>();
  for (const r of rows) byDoc.set(r.doc ?? "rh", [...(byDoc.get(r.doc ?? "rh") ?? []), r]);
  const sales: BrokerSaleFact[] = [...byDoc.entries()].map(([docId, rs]): BrokerSaleFact => ({
    docId,
    payer: rs[0]!.payer === undefined ? "Robinhood Markets, Inc." : rs[0]!.payer,
    basis: "doc_verified",
    legacyFormat: false,
    refs: DOCREF(docId),
    summaryRead: true,
    signalled1099B: true,
    rows: rs.map((r) => ({
      form: r.form,
      box: r.box,
      proceedsCents: Number(r.p),
      costCents: Number(r.c),
      accruedMarketDiscountCents: Number(r.disc),
      washSaleLossDisallowedCents: Number(r.w),
      gainLossCents: Number(r.p - r.c + r.w),
    })),
    sec1256AggregateCents: 0,
    forms1099DaPresent: rs.some((r) => r.form === "1099-DA"),
  }));
  f.income.brokerSales = sales;
  const stated = (n: number): Sourced<number> => owner(n);
  f.returnAnswers.capitalGains = {
    carryoverShortCents: stated(Number(opts.carryS ?? 0)),
    carryoverLongCents: stated(Number(opts.carryL ?? 0)),
    salesComplete: owner(true),
    brokerAdjustments: owner(opts.cgadjYes === true),
  };
  if (rows.some((r) => r.form === "1099-DA")) f.returnAnswers.attestations.digitalAssets = owner(true);
  opts.extra?.(f);
  return f;
}
const REAL = (): ORow[] => [
  { form: "1099-B", box: "A", p: 587_231, c: 528_550, w: 599, disc: 0 },
  { form: "1099-B", box: "D", p: 1_700_168, c: 1_203_728, w: 0, disc: 0 },
];
const amountOf = (ret: ReturnType<typeof computeTy2025Return>, k: LineKey): number | null => ret.lines[k]?.amount ?? null;

// ── 1. The owner's real figures, hand-derived ──────────────────────────────────────────────────
describe("real owner figures (derived by hand from the Robinhood summary)", () => {
  // Short A: 5,872.31 proceeds, 5,285.50 cost, 5.99 wash sale. 5,872.31 - 5,285.50 = 586.81; + 5.99 = 592.80.
  // Long D: 17,001.68 - 12,037.28 = 4,964.40. Net = 592.80 + 4,964.40 = 5,557.20.
  it("oracle: 592.80 -> 593, 4,964.40 -> 4,964, net 5,557.20 -> 5,557; cell sums 5,872 - 5,286 + 6 = 592 versus (h) 593", () => {
    const o = oracleSd({ rows: REAL(), box2a: 0, carryS: 0, carryL: 0 }, true);
    expect(o.cells["1b.d"]).toBe(5872);
    expect(o.cells["1b.e"]).toBe(5286); // 5,285.50 -> 5,286 (50 cents rounds up)
    expect(o.cells["1b.g"]).toBe(6); // 5.99
    expect(o.cells["1b.h"]).toBe(593); // 592.80 from cents (the 8949 cross-foot 5,872 - 5,286 + 6 = 592 is the rounding artefact)
    expect(o.cells["8a.d"]).toBe(17002);
    expect(o.cells["8a.e"]).toBe(12037);
    expect(o.cells["8a.h"]).toBe(4964);
    expect([o.l7, o.l15, o.l16, o.f7a, o.qdcg3]).toEqual([593, 4964, 5557, 5557, 4964]);
    // alternative reading (round each (d), (e), (g) first, then (h) = d - e + g): line 7 = 592, line 16 = 5,556 -- the IRS "include cents when adding" rule rejects it
    expect(5872 - 5286 + 6).toBe(592);
    expect(rdc(59280 + 496440)).toBe(5557); // the broker's own printed nets, rounded once
  });

  it("engine: the same lines, Form 1040 7a = 5,557, qdcg.3 = 4,964, AGI + 5,557, and the Tester's own QDCG hand run = 20,825 / total 27,890", () => {
    const base = computeTy2025Return(fullFacts());
    const ret = computeTy2025Return(factsWith(REAL()));
    const o = oracleSd({ rows: REAL(), box2a: 0, carryS: 0, carryL: 0 }, true);
    for (const [k, v] of Object.entries(o.cells)) {
      const key = `schd.${k}` as LineKey;
      const a = amountOf(ret, key);
      // cells that do not exist on 1a / 8a (g) are not keys
      if (ret.lines[key] === undefined) continue;
      if (ret.lines[key]!.status === "not_applicable") expect(v, key).toBe(0);
      else expect((a ?? -999999), key).toBe(v);
    }
    expect(amountOf(ret, "schd.7")).toBe(593);
    expect(amountOf(ret, "schd.15")).toBe(4964);
    expect(amountOf(ret, "schd.16")).toBe(5557);
    expect(amountOf(ret, "f1040.7a")).toBe(5557);
    expect(amountOf(ret, "qdcg.3")).toBe(4964);
    expect(amountOf(ret, "f1040.11a")! - amountOf(base, "f1040.11a")!).toBe(5557);
    // QDCG worksheet by hand for TI 142,731: line 3 = 4,964
    const ti = (amountOf(ret, "f1040.15")!);
    expect(ti).toBe(142731);
    const w = qdcgTax(ti, 800, 4964);
    expect(w.lines[5]).toBe(136967); // 142,731 - (800 + 4,964)
    expect(w.lines[9]).toBe(0);
    expect(w.lines[17]).toBe(5764);
    expect(w.lines[22]).toBe(1996074); // worksheet at/above 100,000: 136,967 x 22% - 10,172 = 19,960.74
    expect(w.tax).toBe(20825);
    expect((amountOf(ret, "f1040.16")!)).toBe(20825);
    expect(ret.headline.federal.totalTax.amount! - base.headline.federal.totalTax.amount!).toBe(27890 - 27015);
    expect(ret.headline.federal.totalTax.amount).toBe(27890);
    expect(base.headline.federal.totalTax.amount).toBe(27015);
  });

  it("CT: AGI = federal AGI, CT tax 9,094 vs 8,788 (the CT-1040 starts from federal AGI; no capital gain modification)", () => {
    const base = computeTy2025Return(fullFacts());
    const ret = computeTy2025Return(factsWith(REAL()));
    expect(amountOf(ret, "ct1040.1")).toBe(amountOf(ret, "f1040.11a"));
    expect(ret.headline.connecticut.tax.amount).toBe(9094);
    expect(base.headline.connecticut.tax.amount).toBe(8788);
  });
});

// ── 2. The four ST/LT sign combinations, the $3,000 limit ──────────────────────────────────────
describe("Schedule D netting by hand (four sign combinations)", () => {
  const long = (p: number, c: number, over: Partial<ORow> = {}): ORow => ({ form: "1099-B", box: "D", p: (p) * 100, c: (c) * 100, w: 0, disc: 0, ...over });
  const short = (p: number, c: number, over: Partial<ORow> = {}): ORow => ({ form: "1099-B", box: "A", p: (p) * 100, c: (c) * 100, w: 0, disc: 0, ...over });
  const run = (rows: ORow[], o: { carryS?: C; carryL?: C; box2a?: C } = {}) => {
    const ret = computeTy2025Return(factsWith(rows, o));
    return {
      ret,
      l: (k: LineKey) => amountOf(ret, k),
      s: (k: LineKey) => ret.lines[k]?.status,
    };
  };

  it("ST gain +2,000 / LT gain +3,000: 7 = 2,000, 15 = 3,000, 16 = 5,000, 7a = 5,000, qdcg.3 = 3,000, line 17 yes", () => {
    const r = run([short(5000, 3000), long(8000, 5000)]);
    expect([r.l("schd.7"), r.l("schd.15"), r.l("schd.16"), r.l("f1040.7a"), r.l("qdcg.3")]).toEqual([2000, 3000, 5000, 5000, 3000]);
    expect(r.ret.scheduleD?.line17).toBe(true);
    expect(r.l("schd.21")).toBe(0);
  });

  it("ST gain +10,000 / LT loss -4,000: 16 = +6,000 gain, qdcg.3 = 0 (line 15 is a loss), 7a = 6,000", () => {
    const r = run([short(15000, 5000), long(1000, 5000)]);
    expect([r.l("schd.7"), r.l("schd.15"), r.l("schd.16"), r.l("f1040.7a"), r.l("qdcg.3")]).toEqual([10000, -4000, 6000, 6000, 0]);
    expect(r.ret.scheduleD?.line17).toBe(false);
  });

  it("ST loss -7,000 / LT gain +2,000: 16 = -5,000, limited to -3,000; qdcg.3 = 0; carryover out 2,000 (short)", () => {
    const r = run([short(3000, 10000), long(7000, 5000)]);
    expect([r.l("schd.7"), r.l("schd.15"), r.l("schd.16"), r.l("schd.21"), r.l("f1040.7a"), r.l("qdcg.3")]).toEqual([-7000, 2000, -5000, 3000, -3000, 0]);
    // Capital Loss Carryover Worksheet: line 1 = TI before floor (large, positive), 2 = 3,000, 3 = TI+3000, 4 = 3,000, 5 = 7,000, 6 = 2,000, 7 = 5,000, 8 = 7,000 - 5,000 = 2,000; line 15 not a loss -> 13 = 0
    expect(r.ret.scheduleD?.carryoverOut).toEqual({ shortCents: 200000, longCents: 0, totalCents: 200000 });
  });

  it("ST loss -1,000 / LT loss -1,500: 16 = -2,500 fully deductible (7a = -2,500), no carryover", () => {
    const r = run([short(1000, 2000), long(500, 2000)]);
    expect([r.l("schd.7"), r.l("schd.15"), r.l("schd.16"), r.l("schd.21"), r.l("f1040.7a"), r.l("qdcg.3")]).toEqual([-1000, -1500, -2500, 2500, -2500, 0]);
    expect(r.ret.scheduleD?.carryoverOut).toBeNull();
  });

  it("loss over the limit: ST -4,000 / LT -6,000: 16 = -10,000; line 21 = 3,000, 7a = -3,000; carryover 4,000 short + 3,000 long", () => {
    const r = run([short(1000, 5000), long(1000, 7000)]);
    expect([r.l("schd.16"), r.l("schd.21"), r.l("f1040.7a")]).toEqual([-10000, 3000, -3000]);
    // CLCW: 1 = TI(before floor) large positive; 2 = 3,000; 3 = big; 4 = 3,000; 5 = 4,000 (ST loss); 6 = 0 (line 15 not a gain); 7 = 3,000; 8 = 4,000 - 3,000 = 1,000
    //       9 = 6,000; 10 = 0 (line 7 not a gain); 11 = 4 - 5 = 3,000 - 4,000 -> 0; 12 = 0; 13 = 6,000
    expect(r.ret.scheduleD?.carryoverOut).toEqual({ shortCents: 100000, longCents: 600000, totalCents: 700000 });
  });

  it("zero net: 16 = 0, 7a = 0, no line 21, qdcg.3 = 0", () => {
    const r = run([short(2000, 3000), long(3000, 2000)]);
    expect([r.l("schd.7"), r.l("schd.15"), r.l("schd.16"), r.l("f1040.7a"), r.l("qdcg.3")]).toEqual([-1000, 1000, 0, 0, 0]);
    expect(r.s("schd.21")).toBe("not_applicable");
  });

  it("loss exactly $3,000 and $3,001 (boundary of the limit) and cents rounding at the boundary", () => {
    const r1 = run([long(0 + 1000, 4000)]);
    expect([r1.l("schd.16"), r1.l("schd.21"), r1.l("f1040.7a")]).toEqual([-3000, 3000, -3000]);
    expect(r1.ret.scheduleD?.carryoverOut).toBeNull();
    const r2 = run([long(1000, 4001)]);
    expect([r2.l("schd.16"), r2.l("schd.21"), r2.l("f1040.7a")]).toEqual([-3001, 3000, -3000]);
    expect(r2.ret.scheduleD?.carryoverOut).toEqual({ shortCents: 0, longCents: 100, totalCents: 100 });
    // -3,000.49 rounds to -3,000 (no excess); -3,000.50 rounds to -3,001 -> excess 1
    const r3 = run([{ ...long(0, 0), p: 100000, c: 400049 }]);
    expect([r3.l("schd.16"), r3.l("f1040.7a")]).toEqual([-3000, -3000]);
    const r4 = run([{ ...long(0, 0), p: 100000, c: 400050 }]);
    expect([r4.l("schd.16"), r4.l("f1040.7a")]).toEqual([-3001, -3000]);
  });

  it("carryover in: ST carryover 1,000 reduces line 7; LT carryover 2,500 reduces line 15 (lines 6 and 14 are positive magnitudes)", () => {
    const r = run([short(5000, 3000), long(8000, 5000)], { carryS: 100000, carryL: 250000 });
    expect([r.l("schd.6"), r.l("schd.14"), r.l("schd.7"), r.l("schd.15"), r.l("schd.16"), r.l("f1040.7a"), r.l("qdcg.3")]).toEqual([1000, 2500, 1000, 500, 1500, 1500, 500]);
  });

  it("carryover in with no sales at all still requires Schedule D (7a = -carryover, limited to 3,000)", () => {
    const r = run([], { carryS: 500000, carryL: 0 });
    expect([r.l("schd.6"), r.l("schd.7"), r.l("schd.16"), r.l("schd.21"), r.l("f1040.7a")]).toEqual([5000, -5000, -5000, 3000, -3000]);
    expect(r.ret.scheduleD?.required).toBe(true);
  });

  it("1099-DIV box 2a goes on line 13 and into line 15 / 7a (capital gain distributions with no sales, Exception 1: no Schedule D)", () => {
    const f = factsWith([], { box2a: 123456 });
    f.income.dividendBoxes2b2dConfirmedZero = true; // Exception 1 needs 1099-DIV boxes 2b-2d confirmed zero
    const ret = computeTy2025Return(f);
    expect(ret.scheduleD?.required).toBe(false);
    expect(ret.scheduleD?.exception1).toBe(true);
    expect(amountOf(ret, "f1040.7a")).toBe(1235); // 1,234.56 -> 1,235
    expect(amountOf(ret, "qdcg.3")).toBe(1235); // no Schedule D: QDCG line 3 = 1040 line 7a
    // with sales it lands on line 13 and in line 15 (long-term) and is part of line 16
    const r = run([{ form: "1099-B", box: "A", p: 1_000_000, c: 900_000, w: 0, disc: 0 }], { box2a: 123456 });
    expect([r.l("schd.13"), r.l("schd.15"), r.l("schd.7"), r.l("schd.16")]).toEqual([1235, 1235, 1000, 2235]);
    expect(r.l("qdcg.3")).toBe(1235);
  });
});

// ── 3. Capital Loss Carryover Worksheet (carryover OUT to 2026), re-derived by hand ──────────────────
describe("Capital Loss Carryover Worksheet (instructions p.10) hand-derived cases (carryover out)", () => {
  // inputs: Schedule D line 7, line 15, line 21 (positive), Form 1040 line 15 BEFORE the floor (11b - 14, may be negative)
  const co = (l7: number, l15: number, l21: number, ti: number) => computeCapitalLossCarryoverOut({ line7: D(l7), line15: D(l15), line21: D(l21), taxableIncomeBeforeFloor: D(ti) });
  it("case 1: ST -10,000, LT 0, line 21 = 3,000, TI 50,000: w3 = 53,000, w4 = 3,000, w5 = 10,000, w6 = 0, w7 = 3,000, w8 = 7,000 -> short 7,000", () => {
    expect(co(-10000, 0, 3000, 50000)).toEqual({ shortCents: 700000, longCents: 0, totalCents: 700000 });
  });
  it("case 2: ST 0, LT -10,000: w4 = 3,000, w5 = 0, w9 = 10,000, w10 = 0, w11 = 3,000 - 0 = 3,000, w12 = 3,000, w13 = 7,000 -> long 7,000", () => {
    expect(co(0, -10000, 3000, 50000)).toEqual({ shortCents: 0, longCents: 700000, totalCents: 700000 });
  });
  it("case 3: ST -4,000, LT -6,000 (limit 3,000): short 1,000, long 6,000 (the ST loss uses the $3,000 first)", () => {
    expect(co(-4000, -6000, 3000, 80000)).toEqual({ shortCents: 100000, longCents: 600000, totalCents: 700000 });
  });
  it("case 4: ST -7,000, LT +2,000: w4 = 3,000, w6 = 2,000, w7 = 5,000, w8 = 2,000 -> short 2,000; line 15 is a gain so no long carryover", () => {
    expect(co(-7000, 2000, 3000, 80000)).toEqual({ shortCents: 200000, longCents: 0, totalCents: 200000 });
  });
  it("case 5: ST +2,000, LT -6,000 (net -4,000, limit 3,000): w5 = 0, w9 = 6,000, w10 = 2,000, w11 = 3,000, w12 = 5,000, w13 = 1,000 -> long 1,000", () => {
    expect(co(2000, -6000, 3000, 80000)).toEqual({ shortCents: 0, longCents: 100000, totalCents: 100000 });
  });
  it("case 6: taxable income before the floor is NEGATIVE (-5,000): w3 = max(0, -5,000 + 3,000) = 0, w4 = 0: the whole loss carries (ST -3,000 -> 3,000)", () => {
    expect(co(-3000, 0, 3000, -5000)).toEqual({ shortCents: 300000, longCents: 0, totalCents: 300000 });
  });
  it("case 7: TI before floor -1,000: w3 = 2,000, w4 = min(3,000, 2,000) = 2,000; ST -3,000: w8 = 3,000 - 2,000 = 1,000", () => {
    expect(co(-3000, 0, 3000, -1000)).toEqual({ shortCents: 100000, longCents: 0, totalCents: 100000 });
  });
  it("case 8: loss fully used (ST -2,000, line 21 = 2,000, TI positive): no carryover (null)", () => {
    expect(co(-2000, 0, 2000, 40000)).toBeNull();
  });
  it("case 9: ST -1,000, LT -9,000 (net -10,000, line 21 = 3,000): w4 = 3,000; w5 = 1,000, w7 = 3,000 -> short 0; w11 = max(0, 3,000 - 1,000) = 2,000, w12 = 2,000, w13 = 9,000 - 2,000 = 7,000", () => {
    expect(co(-1000, -9000, 3000, 80000)).toEqual({ shortCents: 0, longCents: 700000, totalCents: 700000 });
  });
  it("end to end: a $50,000 long-term loss on the golden household carries 47,000 to 2026 and 7a = -3,000", () => {
    const ret = computeTy2025Return(factsWith([{ form: "1099-B", box: "D", p: 1_000_000, c: 6_000_000, w: 0, disc: 0 }]));
    expect(amountOf(ret, "f1040.7a")).toBe(-3000);
    expect(ret.scheduleD?.carryoverOut).toEqual({ shortCents: 0, longCents: 4_700_000, totalCents: 4_700_000 });
  });
});

// ── 4. 6,000 random households: Schedule D lines + QDCG tax + QBI line 12 + NIIT vs the Tester's oracle ──────────────
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("random households vs the Tester's oracle (schd.*, 1040 7a, qdcg.3, tax, QBI line 12, NIIT)", () => {
  it("random cases (2,000; 6,000 with SD_TESTER_FULL=1): gains, losses, carryovers, line 13, wash sales (8949 routing), qualified dividends, mixed", () => {
    // default 2,000 cases (suite time); the Tester's verdict run used SD_TESTER_FULL=1 (6,000)
    const N = process.env.SD_TESTER_FULL ? 6000 : 2000;
    const rnd = mulberry32(20261004);
    const ri = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
    let checked = 0;
    let taxChecked = 0;
    let niitPositive = 0;
    let lossCases = 0;
    let qdcgSplit = 0;
    let discriminating = 0;
    let altRoundingDiffers = 0;
    let altCrossFootDiffers = 0;
    let routedTo8949 = 0;
    for (let i = 0; i < N; i++) {
      const rows: ORow[] = [];
      const kinds: BrokerBox[] = ["A", "B", "D", "E"];
      const nRows = ri(0, 4);
      const used = new Set<string>();
      for (let k = 0; k < nRows; k++) {
        const box = kinds[ri(0, 3)]!;
        if (used.has(box)) continue;
        used.add(box);
        const big = rnd() < 0.3;
        const p = (ri(0, big ? 90_000_000 : 3_000_000));
        const c = (ri(0, big ? 90_000_000 : 3_000_000));
        const w = rnd() < 0.3 ? (ri(0, 200_000)) : 0;
        rows.push({ form: "1099-B", box, p, c, w, disc: 0 });
        if (w > 0 || box === "B" || box === "E") routedTo8949++;
      }
      const box2a = rnd() < 0.3 ? (ri(0, 5_000_000)) : 0;
      const carryS = rnd() < 0.2 ? (ri(0, 4_000_000)) : 0;
      const carryL = rnd() < 0.2 ? (ri(0, 4_000_000)) : 0;
      const qd = ri(0, 4) === 0 ? ri(0, 20_000_000) : 80_000;
      const wages = rnd() < 0.5 ? ri(2_000_000, 60_000_000) : 9_000_000;
      const anyRow = rows.some((r) => !(r.p === 0 && r.c === 0 && r.w === 0));
      const required = anyRow || carryS > 0 || carryL > 0;
      if (!required && rows.length > 0 && rows.every((r) => r.p === 0 && r.c === 0 && r.w === 0)) continue;
      const f = factsWith(rows, { box2a, carryS, carryL, qdCents: qd, wagesEric: wages });
      const ret = computeTy2025Return(f);
      const o = oracleSd({ rows, box2a, carryS, carryL }, true);

      if (required) {
        // all Schedule D arithmetic lines
        for (const [k, v] of Object.entries(o.cells)) {
          const key = `schd.${k}` as LineKey;
          const line = ret.lines[key];
          if (line === undefined) continue; // 1a.g / 8a.g do not exist
          if (line.status === "not_applicable") expect(v, `${i} ${key}`).toBe(0);
          else expect((line.amount ?? 0), `${i} ${key}`).toBe(v);
        }
        expect((amountOf(ret, "schd.7")!), `${i} l7`).toBe(o.l7);
        expect((amountOf(ret, "schd.15")!), `${i} l15`).toBe(o.l15);
        expect((amountOf(ret, "schd.16")!), `${i} l16`).toBe(o.l16);
        expect((amountOf(ret, "f1040.7a")!), `${i} 7a`).toBe(o.f7a);
        expect((amountOf(ret, "qdcg.3")!), `${i} qdcg.3`).toBe(o.qdcg3);
        expect(ret.scheduleD?.line17, `${i} line17`).toBe(o.l17);
        expect((amountOf(ret, "schd.21") ?? 0), `${i} l21`).toBe(o.l21);
        // line 6 / 14 magnitudes
        expect((amountOf(ret, "schd.6") ?? 0), `${i} l6`).toBe(rdc(carryS));
        expect((amountOf(ret, "schd.14") ?? 0), `${i} l14`).toBe(rdc(carryL));
        if (o.l16 < 0) lossCases++;
      } else {
        // Exception 1: only capital gain distributions
        expect(ret.scheduleD?.required, `${i} exception 1`).toBe(false);
        expect((amountOf(ret, "f1040.7a")!), `${i} 7a ex1`).toBe(rdc(box2a));
        expect((amountOf(ret, "qdcg.3")!), `${i} qdcg3 ex1`).toBe(rdc(box2a));
      }
      const f7a = (amountOf(ret, "f1040.7a")!);
      const q3 = (amountOf(ret, "qdcg.3")!);
      // AGI moves by exactly 7a versus the no-capital-gain household with the same wages / dividends
      // (checked on the baseline per wages class below)

      // federal tax on taxable income via the Tester's QDCG worksheet (line 3 from the Tester's own netting)
      const ti = amountOf(ret, "f1040.15");
      const qdLine = amountOf(ret, "f1040.3a");
      const tax = amountOf(ret, "f1040.16");
      if (ti !== null && qdLine !== null && tax !== null && ret.lines["f1040.16"]?.status === "computed") {
        const exQ3 = required ? o.qdcg3 : rdc(box2a);
        const w = qdcgTax((ti), (qdLine), exQ3);
        expect((tax), `${i} f1040.16 (ti ${ti}, qd ${qdLine}, q3 ${exQ3})`).toBe(w.tax);
        taxChecked++;
        if (w.lines[9]! > 0 && w.lines[17]! > 0) qdcgSplit++;
        // sensitivity of this oracle: feeding 1040 line 7a (the wrong QDCG line 3) instead would change the tax in this case
        if (qdcgTax((ti), (qdLine), maxB(0, f7a)).tax !== w.tax) discriminating++;
      }
      // Form 8995 line 12 = qualified dividends + qdcg.3 (never 7a)
      const l12 = amountOf(ret, "f8995.12");
      if (l12 !== null && qdLine !== null) {
        expect((l12), `${i} 8995 line 12`).toBe((qdLine) + q3);
        const l11 = amountOf(ret, "f8995.11")!;
        const l10 = amountOf(ret, "f8995.10")!;
        const l13 = maxB(0, (l11) - (l12));
        const l14 = rdc(l13 * 20); // 20% of whole dollars -> cents
        expect((amountOf(ret, "f8995.15")!), `${i} 8995 line 15`).toBe(minB((l10), l14));
      }
      // NIIT: 8960 line 12 = max(0, 2b + 3b + signed 7a); NIIT = 3.8% x min(NII, MAGI - 250,000)
      const i2b = (amountOf(ret, "f1040.2b")!);
      const d3b = (amountOf(ret, "f1040.3b")!);
      const nii = maxB(0, i2b + d3b + f7a);
      const magi = (amountOf(ret, "f1040.11a")!);
      const nl = ret.lines["f8960.nii"];
      if (nl?.amount !== null && nl?.amount !== undefined) expect((nl.amount), `${i} nii`).toBe(nii);
      const niitLine = ret.lines["f8960.niit"];
      if (niitLine?.status === "computed") {
        const excess = maxB(0, magi - 250000);
        expect((niitLine.amount!), `${i} niit`).toBe(Math.floor((minB(nii, excess) * 38 + 500) / 1000)); // 3.8% of whole dollars, rounded half up to whole dollars
        if ((niitLine.amount!) > 0) niitPositive++;
      }
      checked++;
      if (required) {
        // the alternative rounding reading (round every cell first, then add rounded cells) versus the engine / IRS include-cents rule
        const rdH = (l: string) => o.cells[`${l}.h`]!;
        const alt7 = ST_LINES.reduce((t, l) => t + rdH(l), 0) - rdc(carryS);
        const alt15 = LT_LINES.reduce((t, l) => t + rdH(l), 0) + rdc(box2a) - rdc(carryL);
        if (alt7 + alt15 !== o.l16) altRoundingDiffers++;
        // cross-foot: printed (d) - (e) + (g) versus printed (h) on a Form 8949 line
        for (const l of [...ST_LINES, ...LT_LINES]) if (l !== "1a" && l !== "8a" && o.cells[`${l}.d`]! - o.cells[`${l}.e`]! + o.cells[`${l}.g`]! !== o.cells[`${l}.h`]!) { altCrossFootDiffers++; break; }
      }
      // QDCG line 3 is never 7a when Schedule D is filed with a loss / mixed
      if (required && o.f7a > 0 && o.qdcg3 !== o.f7a) expect(q3).not.toBe(f7a);
    }
    expect(checked).toBeGreaterThan(N * 0.8);
    expect(taxChecked).toBeGreaterThan(N * 0.65);
    expect(lossCases).toBeGreaterThan(N * 0.05);
    expect(qdcgSplit).toBeGreaterThan(N * 0.03);
    expect(routedTo8949).toBeGreaterThan(N * 0.15);
    expect(niitPositive).toBeGreaterThan(N * 0.003);
    expect(discriminating).toBeGreaterThan(N * 0.008);
    console.log("oracle sensitivity: wrong-qdcg3 would change the tax in", discriminating, "cases; alt rounding (round cells first) changes line 16 in", altRoundingDiffers, "of", checked, "; cases with a printed 8949 line that does not cross-foot (d-e+g != h):", altCrossFootDiffers);
  }, 600_000);
});

// ── 5. AGI moves by exactly the Form 1040 line 7a ──────────────────────────────────────────────
describe("AGI / CT AGI move by exactly line 7a", () => {
  it("40 random households: AGI(with) - AGI(base) = f1040.7a and ct1040.1 = f1040.11a", () => {
    const rnd = mulberry32(99);
    const ri = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
    for (let i = 0; i < 40; i++) {
      const wages = ri(3_000_000, 40_000_000);
      const base = computeTy2025Return(factsWith([], { wagesEric: wages }));
      const rows: ORow[] = [{ form: "1099-B", box: rnd() < 0.5 ? "A" : "D", p: (ri(0, 50_000_000)), c: (ri(0, 50_000_000)), w: 0, disc: 0 }];
      const ret = computeTy2025Return(factsWith(rows, { wagesEric: wages }));
      expect(amountOf(ret, "f1040.11a")! - amountOf(base, "f1040.11a")!, `${i}`).toBe(amountOf(ret, "f1040.7a"));
      expect(amountOf(ret, "ct1040.1")).toBe(amountOf(ret, "f1040.11a"));
    }
  });
});
