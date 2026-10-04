import { describe, expect, it } from "vitest";
import { unsureLeaf } from "@/lib/tax2025/answer-state";
import { CONSTANTS } from "@/lib/tax2025/constants";
import type { BrokerBox, BrokerSaleFact, Ty2025Facts } from "@/lib/tax2025/facts";
import { aggregateInvestments, scheduleDInput } from "@/lib/tax2025/inputs";
import { LINE_KEYS, NONE_GROUP_IDS, lineMeta } from "@/lib/tax2025/line-catalog";
import { D } from "@/lib/tax2025/money";
import { computeTy2025Return, duplicateEmissions } from "@/lib/tax2025/return";
import { computeCapitalLossCarryoverOut, computeScheduleD, type ScheduleDOutput } from "@/lib/tax2025/rules/schedule-d";
import { computeForm8960, type Form8960Input } from "@/lib/tax2025/rules/form-8960";
import { qdcgWorksheet } from "@/lib/tax2025/rules/tax-calc";
import { missingLeaf, type LineKey, type Ref, type Sourced, type Ty2025Return } from "@/lib/tax2025/types";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { resolveTaxDocForCompute } from "@/lib/tax-extraction-policy";
import { normalizeTaxExtraction } from "@/lib/tax-extraction-schema";
import { ROBINHOOD_2025_RAW } from "./broker-summary-fixtures";
import { ERIC_ID, EVA_ID, fullFacts, fullFacts1b, owner, dividend } from "./tax2025-fixtures";

// Schedule D / Form 8949 engine tests. Every expected number below is hand-computed from the 2025 IRS text:
//   - Schedule D form: lines 1a-16 and the line 21 limit;
//   - Instructions for Schedule D: "Lines 1a and 8a" Examples 1-2, "Rounding Off to Whole Dollars", the Capital Loss Carryover Worksheet;
//   - Instructions for Form 8949: Exception 2 (summary row, code M, W), column (g) is a POSITIVE wash sale add-back;
//   - Form 1040 instructions: the Qualified Dividends and Capital Gain Tax Worksheet (line 3 = smaller of Schedule D line 15 or 16).
// The facts follow the capture side's contract: income.brokerSales (one entry per 1099), returnAnswers.capitalGains (carryover, every sale
// listed, broker adjustments) and the two capital none-groups in statedNone.

const REF: Ref[] = [{ kind: "document", id: "rh", label: "1099" }];

interface TestRow {
  docId: string;
  payer: string | null;
  refs: Ref[];
  form: "1099-B" | "1099-DA" | null;
  box: BrokerBox | null;
  proceedsCents: number | null;
  costCents: number | null;
  accruedMarketDiscountCents: number | null;
  washSaleCents: number | null;
  brokerGainCents: number | null;
}

function row(box: BrokerBox | null, proceedsCents: number | null, costCents: number | null, over: Partial<TestRow> = {}): TestRow {
  return {
    docId: "rh",
    payer: "Robinhood Markets, Inc.",
    refs: REF,
    form: "1099-B",
    box,
    proceedsCents,
    costCents,
    accruedMarketDiscountCents: 0,
    washSaleCents: 0,
    brokerGainCents: null,
    ...over,
  };
}

interface CgOpts {
  carryoverShort?: Sourced<number>;
  carryoverLong?: Sourced<number>;
  salesComplete?: Sourced<boolean>;
  /** In the rule's terms: true = the owner confirmed NOTHING the broker could not know (the stored answer is the inverse). */
  noBrokerAdjustments?: Sourced<boolean>;
  otherLinesNone?: Sourced<boolean>;
  specialRatesNone?: Sourced<boolean>;
  /** Section 1256 aggregate (cents) printed on the first document; 0 = a printed 0.00. */
  section1256Cents?: number | null;
  /** Documents with a 1099-B signal whose sales summary was never read. */
  unread?: { docId: string; payer: string | null }[];
  /** A 1099-DA is present (variantsPresent) whether or not rows were read. */
  da1099?: boolean;
}

const invert = (leaf: Sourced<boolean>): Sourced<boolean> => (leaf.value === null ? leaf : { ...leaf, value: !leaf.value });

function withCg(rows: TestRow[], o: CgOpts = {}, base: () => Ty2025Facts = fullFacts): Ty2025Facts {
  const f = base();
  const byDoc = new Map<string, TestRow[]>();
  for (const r of rows) byDoc.set(r.docId, [...(byDoc.get(r.docId) ?? []), r]);
  const sales: BrokerSaleFact[] = [...byDoc.entries()].map(([docId, rs]): BrokerSaleFact => ({
    docId,
    payer: rs[0]?.payer ?? null,
    basis: "doc_verified",
    legacyFormat: false,
    refs: rs[0]?.refs ?? [],
    summaryRead: true,
    signalled1099B: true,
    rows: rs.map((r) => ({
      form: r.form,
      box: r.box,
      proceedsCents: r.proceedsCents,
      costCents: r.costCents,
      accruedMarketDiscountCents: r.accruedMarketDiscountCents,
      washSaleLossDisallowedCents: r.washSaleCents,
      gainLossCents: r.brokerGainCents,
    })),
    sec1256AggregateCents: null,
    forms1099DaPresent: o.da1099 === true || rs.some((r) => r.form === "1099-DA"),
  }));
  for (const u of o.unread ?? []) {
    sales.push({ docId: u.docId, payer: u.payer, basis: "doc_verified", legacyFormat: false, refs: [{ kind: "document", id: u.docId, label: "1099" }], summaryRead: false, signalled1099B: true, rows: [], sec1256AggregateCents: null, forms1099DaPresent: false });
  }
  if (o.section1256Cents !== undefined && o.section1256Cents !== null) {
    if (sales.length === 0) sales.push({ docId: "rh", payer: "Robinhood Markets, Inc.", basis: "doc_verified", legacyFormat: false, refs: REF, summaryRead: true, signalled1099B: true, rows: [], sec1256AggregateCents: null, forms1099DaPresent: false });
    sales[0] = { ...sales[0]!, sec1256AggregateCents: o.section1256Cents };
  }
  if (o.da1099 === true && sales.length === 0) {
    sales.push({ docId: "rh", payer: "Robinhood Markets, Inc.", basis: "doc_verified", legacyFormat: false, refs: REF, summaryRead: true, signalled1099B: false, rows: [], sec1256AggregateCents: null, forms1099DaPresent: true });
  }
  f.income.brokerSales = sales;
  f.returnAnswers.capitalGains = {
    carryoverShortCents: o.carryoverShort ?? owner(0),
    carryoverLongCents: o.carryoverLong ?? owner(0),
    salesComplete: o.salesComplete ?? owner(true),
    brokerAdjustments: invert(o.noBrokerAdjustments ?? owner(true)),
  };
  // the none-group statements: "Not sure" and unanswered are both absent (the capture side cannot tell them apart)
  const group = (g: "capital_gain_other" | "capital_special_rates", leaf: Sourced<boolean> | undefined): void => {
    if (leaf === undefined) f.statedNone[g] = owner(true);
    else if (leaf.value === null) delete f.statedNone[g];
    else f.statedNone[g] = leaf;
  };
  group("capital_gain_other", o.otherLinesNone);
  group("capital_special_rates", o.specialRatesNone);
  return f;
}

/** The REAL household figures (Robinhood 2025): short-term box A with a $5.99 wash sale, long-term box D with basis reported and no adjustment. */
const REAL_ROWS = (): TestRow[] => [
  row("A", 587_231, 528_550, { washSaleCents: 599, brokerGainCents: 59_280 }),
  row("D", 1_700_168, 1_203_728, { brokerGainCents: 496_440 }),
];

function sd(f: Ty2025Facts, fill = false): ScheduleDOutput {
  return computeScheduleD(scheduleDInput(f, aggregateInvestments(f), fill));
}
function line(out: ScheduleDOutput, key: LineKey) {
  const l = out.result.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l;
}
const amt = (out: ScheduleDOutput, key: LineKey): string | null => {
  const l = line(out, key);
  return l.amount === null ? null : l.amount.toString();
};
const st = (out: ScheduleDOutput, key: LineKey) => line(out, key).status;
const ex = (out: ScheduleDOutput, key: LineKey): string | null => {
  const l = line(out, key);
  return l.exact === undefined || l.exact === null ? null : l.exact.toString();
};

const rAmt = (ret: Ty2025Return, key: LineKey): number | null => ret.lines[key]?.amount ?? null;
const rSt = (ret: Ty2025Return, key: LineKey) => ret.lines[key]?.status;

describe("catalog and constants", () => {
  it("the Schedule D cell keys carry the printed line id and the QDCG worksheet line 3 exists", () => {
    expect(LINE_KEYS).toContain("schd.1a.d");
    expect(LINE_KEYS).toContain("schd.10.h");
    expect(LINE_KEYS).toContain("qdcg.3");
    expect(LINE_KEYS).not.toContain("schd.1a.g"); // 1a / 8a have no (g) cell: adjustments force Form 8949
    expect(LINE_KEYS).not.toContain("schd.8a.g");
    expect(lineMeta("schd.8b.h").formLine).toBe("8b");
    expect(lineMeta("schd.8b.h").form).toBe("Schedule D");
    expect(lineMeta("schd.16").formLine).toBe("16");
    expect(new Set(LINE_KEYS).size).toBe(LINE_KEYS.length);
  });

  it("the two capital none-groups exist and gate lines 4, 5, 11, 12 and 18, 19", () => {
    expect(NONE_GROUP_IDS).toContain("capital_gain_other");
    expect(NONE_GROUP_IDS).toContain("capital_special_rates");
    for (const k of ["schd.4", "schd.5", "schd.11", "schd.12"] as const) expect(lineMeta(k).group, k).toBe("capital_gain_other");
    for (const k of ["schd.18", "schd.19"] as const) expect(lineMeta(k).group, k).toBe("capital_special_rates");
    expect(lineMeta("schd.7").group).toBeUndefined();
  });

  it("the capital loss limit is registered with its primary source", () => {
    expect(CONSTANTS.CAPITAL_LOSS_LIMIT_MFJ.value).toBe(3000);
    expect(CONSTANTS.CAPITAL_LOSS_LIMIT_MFS.value).toBe(1500);
    expect(CONSTANTS.CAPITAL_LOSS_LIMIT_MFJ.url).toBe("https://www.irs.gov/instructions/i1040sd");
    expect(CONSTANTS.CAPITAL_LOSS_LIMIT_MFJ.verifiedOn).toBe("2026-10-04");
  });
});

describe("the real Robinhood figures (hand-computed)", () => {
  // Short A: proceeds 5,872.31, cost 5,285.50, wash sale 5.99 (code W) -> gain 5,872.31 - 5,285.50 + 5.99 = 592.80
  // Long D:  proceeds 17,001.68, cost 12,037.28, no adjustment -> gain 4,964.40
  // line 7 = 592.80 -> 593; line 15 = 4,964.40 -> 4,964; line 16 = 5,557.20 -> 5,557
  const out = sd(withCg(REAL_ROWS()));

  it("box A (wash sale) goes to Form 8949 and Schedule D line 1b; box D (clean) goes directly to line 8a", () => {
    expect(amt(out, "schd.1a.d")).toBe("0");
    expect(st(out, "schd.1a.d")).toBe("not_applicable");
    expect(amt(out, "schd.1b.d")).toBe("5872");
    expect(ex(out, "schd.1b.d")).toBe("5872.31");
    expect(amt(out, "schd.1b.e")).toBe("5286"); // 5,285.50 rounds up (50 to 99 cents rounds up)
    expect(amt(out, "schd.1b.g")).toBe("6"); // the wash sale add-back, positive
    expect(ex(out, "schd.1b.g")).toBe("5.99");
    expect(amt(out, "schd.1b.h")).toBe("593"); // 592.80, figured from the cents, NOT 5,872 - 5,286 + 6 = 592
    expect(ex(out, "schd.1b.h")).toBe("592.8");
    expect(amt(out, "schd.8a.d")).toBe("17002");
    expect(amt(out, "schd.8a.e")).toBe("12037");
    expect(amt(out, "schd.8a.h")).toBe("4964");
    expect(line(out, "schd.1b.h").status).toBe("computed");
  });

  it("lines 7, 15, 16 and Form 1040 line 7a; the QDCG worksheet line 3 is the smaller of 15 and 16", () => {
    expect(amt(out, "schd.7")).toBe("593");
    expect(amt(out, "schd.15")).toBe("4964");
    expect(amt(out, "schd.16")).toBe("5557");
    expect(ex(out, "schd.16")).toBe("5557.2");
    expect(amt(out, "f1040.7a")).toBe("5557");
    expect(amt(out, "qdcg.3")).toBe("4964");
    expect(amt(out, "schd.21")).toBe("0");
    expect(st(out, "schd.21")).toBe("not_applicable");
    expect(out.detail.line17).toBe(true);
    expect(out.detail.line20).toBe(true); // lines 18 and 19 zero: the Qualified Dividends and Capital Gain Tax Worksheet
    expect(out.detail.line22).toBeNull();
  });

  it("the Form 8949 summary row: broker name + 'see attached statement', code MW, column (g) positive, (h) = (d) - (e) + (g)", () => {
    expect(out.detail.required).toBe(true);
    expect(out.detail.exception1).toBe(false);
    expect(out.detail.form8949Required).toBe(true);
    const a = out.detail.categories.find((c) => c.box === "A")!;
    expect(a).toMatchObject({ part: "I", line: "1b", routing: "form_8949_summary", codes: "MW", description: "Robinhood Markets, Inc. - see attached statement", proceedsCents: 587_231, costCents: 528_550, washSaleCents: 599, gainCents: 59_280 });
    expect(a.rows).toHaveLength(1);
    const d = out.detail.categories.find((c) => c.box === "D")!;
    expect(d).toMatchObject({ part: "II", line: "8a", routing: "schedule_d_direct", codes: "", gainCents: 496_440 });
  });

  it("the broker's printed gain reconciles (it already includes the wash sale add-back), so there is no reconciliation item", () => {
    expect(out.openItems.filter((i) => i.id.startsWith("schd-reconciliation"))).toEqual([]);
    expect(out.openItems.find((i) => i.id === "schd-attached-statement")?.severity).toBe("advisory");
    expect(out.openItems.find((i) => i.id === "schd-ct-capital-gains")?.severity).toBe("advisory");
    expect(out.openItems.filter((i) => i.severity === "blocking")).toEqual([]);
  });

  it("through the whole return: AGI +5,557, QDCG worksheet hand-run, NII, CT AGI = federal AGI", () => {
    const ret = computeTy2025Return(withCg(REAL_ROWS()));
    expect(rAmt(ret, "f1040.7a")).toBe(5557);
    expect(rAmt(ret, "f1040.9")).toBe(187_057); // 181,500 + 5,557
    expect(rAmt(ret, "f1040.11a")).toBe(183_524); // 177,967 + 5,557
    expect(rAmt(ret, "f1040.13a")).toBe(9293); // QBI is limited by 20% of QBI, not by the income cap
    expect(rAmt(ret, "f1040.15")).toBe(142_731); // 183,524 - 31,500 - 9,293
    expect(rAmt(ret, "qdcg.3")).toBe(4964);
    // QDCG worksheet, TY2025 MFJ: 1) 142,731  2) 800  3) 4,964  4) 5,764  5) 136,967  6) 96,700  7) 96,700  8) 96,700  9) 0
    //   10) 5,764  11) 0  12) 5,764  13) 600,050  14) 142,731  15) 136,967  16) 5,764  17) 5,764  18) 864.60  19) 5,764  20) 0  21) 0
    //   22) tax on 136,967 = 2,385 + 12% x 73,100 (8,772) + 22% x 40,017 (8,803.74) = 19,960.74
    //   23) 864.60 + 0 + 19,960.74 = 20,825.34 -> 20,825   24) tax on 142,731 = 11,157 + 22% x 45,781 (10,071.82) = 21,228.82 -> 21,229
    //   25) smaller = 20,825
    expect(rAmt(ret, "qdcg.25")).toBe(20_825);
    expect(rAmt(ret, "f1040.16")).toBe(20_825);
    expect(rAmt(ret, "f1040.24")).toBe(27_890); // 20,825 + the unchanged 7,065 of other taxes
    expect(rAmt(ret, "f8960.nii")).toBe(7057); // 500 interest + 1,000 dividends + 5,557
    expect(rAmt(ret, "sch2.12")).toBe(0); // MAGI 183,524 is under 250,000
    expect(rAmt(ret, "ct1040.1")).toBe(183_524);
    expect(rAmt(ret, "ct1040.ctAgi")).toBe(183_524);
    expect(ret.headline.complete).toBe(true);
    expect(ret.formsRequired.schd).toMatchObject({ required: true });
    expect(ret.formsRequired.f8949).toMatchObject({ required: true });
    expect(ret.scheduleD?.categories).toHaveLength(2);
    expect(duplicateEmissions(withCg(REAL_ROWS()))).toEqual([]);
  });

  it("the same figures through fullFacts1b (answers-driven) agree", () => {
    const ret = computeTy2025Return(withCg(REAL_ROWS(), {}, fullFacts1b));
    expect(rAmt(ret, "f1040.24")).toBe(27_890);
  });

  it("the broker rows are the document's: line 7a / 16 carry the document reference", () => {
    const ret = computeTy2025Return(withCg(REAL_ROWS()));
    expect(ret.lines["f1040.7a"]?.refs.some((r) => r.kind === "document" && r.id === "rh")).toBe(true);
    expect(ret.lines["schd.1b.h"]?.refs.some((r) => r.kind === "document" && r.id === "rh")).toBe(true);
    expect(ret.lines["schd.6"]?.refs).toEqual(expect.any(Array));
  });
});

describe("a household with no capital gains rows is unchanged (golden)", () => {
  it("fullFacts without capitalGains: federal tax 27,015, CT 8,788, line 7a 0, Schedule D not required (Exception 1)", () => {
    const ret = computeTy2025Return(fullFacts());
    expect(ret.headline.federal.totalTax.amount).toBe(27_015);
    expect(ret.headline.connecticut.tax.amount).toBe(8788);
    expect(rAmt(ret, "f1040.7a")).toBe(0);
    expect(rAmt(ret, "qdcg.3")).toBe(0);
    // Schedule D is not required, but the 1099-DIV boxes 2b-2d are not confirmed zero (fullFacts has a 1099-DIV): the 7b box must NOT be ticked
    expect(ret.scheduleD).toMatchObject({ required: false, exception1: false, boxes2b2dUnconfirmed: true, form8949Required: false, categories: [] });
    const confirmed = fullFacts();
    confirmed.income.dividendBoxes2b2dConfirmedZero = true;
    expect(computeTy2025Return(confirmed).scheduleD).toMatchObject({ required: false, exception1: true, boxes2b2dUnconfirmed: false });
    // no 1099-DIV at all: nothing to confirm
    const noDiv = fullFacts();
    noDiv.income.dividends = [];
    noDiv.income.noDividendsConfirmed = owner(true);
    expect(computeTy2025Return(noDiv).scheduleD?.exception1).toBe(true);
    expect(ret.formsRequired.schd?.required).toBe(false);
    expect(ret.formsRequired.f8949?.required).toBe(false);
    expect(rSt(ret, "schd.16")).toBe("not_applicable");
    expect(ret.headline.complete).toBe(true);
  });

  it("a summary read with no sales and every capital answer missing is the same Exception 1 result (the two none-group statements still wait for the owner)", () => {
    const f = withCg([], { carryoverShort: missingLeaf(), carryoverLong: missingLeaf(), salesComplete: missingLeaf(), noBrokerAdjustments: missingLeaf(), otherLinesNone: missingLeaf(), specialRatesNone: missingLeaf() });
    const ret = computeTy2025Return(f);
    expect(ret.headline.federal.totalTax.amount).toBe(27_015);
    expect(ret.headline.connecticut.tax.amount).toBe(8788);
    expect(ret.scheduleD?.required).toBe(false);
    expect(rAmt(ret, "f1040.7a")).toBe(0);
    // the Schedule D lines 4, 5, 11, 12 and 18, 19 are none-group lines: blocked until the owner states "none"
    expect(rSt(ret, "schd.4")).toBe("not_yet_computed");
    expect(rSt(ret, "schd.18")).toBe("not_yet_computed");
    expect(ret.openItems.some((i) => i.id === "none:capital_gain_other")).toBe(true);
  });

  it("rows whose five figures are all KNOWN zeros are ignored: a box B / E row of printed zeros does not trigger Form 8949 or Schedule D", () => {
    const f = withCg([row("B", 0, 0, { brokerGainCents: 0 }), row("E", 0, 0, { brokerGainCents: 0 })]);
    const ret = computeTy2025Return(f);
    expect(ret.scheduleD?.required).toBe(false);
    expect(ret.formsRequired.f8949?.required).toBe(false);
    expect(ret.headline.federal.totalTax.amount).toBe(27_015);
  });

  it("D1: a row with printed-zero proceeds but an UNREAD cost / wash sale / discount / gain is unknown, not zero: it blocks (never 'Schedule D not required')", () => {
    for (const over of [{ costCents: null }, { washSaleCents: null }, { accruedMarketDiscountCents: null }]) {
      const f = withCg([row("A", 0, 0, { brokerGainCents: 0, ...over })]);
      const ret = computeTy2025Return(f);
      expect(ret.scheduleD?.required, JSON.stringify(over)).toBe(true);
      expect(rSt(ret, "f1040.7a"), JSON.stringify(over)).not.toBe("computed");
    }
    // only the printed gain unread: every figure the arithmetic needs is a known 0, so the row is kept (Schedule D required) and computes 0
    const g = computeTy2025Return(withCg([row("A", 0, 0, { brokerGainCents: null })]));
    expect(g.scheduleD?.required).toBe(true);
    expect(rAmt(g, "f1040.7a")).toBe(0);
    // proceeds not read at all with the rest zero is also kept
    expect(computeTy2025Return(withCg([row("A", null, 0, { brokerGainCents: 0 })])).scheduleD?.required).toBe(true);
  });

  it("a Schedule D that is required carries the advisory that printed lines can differ by $1 from the sum of the printed cells", () => {
    const out = sd(withCg(REAL_ROWS()));
    const item = out.openItems.find((i) => i.id === "schd-rounding");
    expect(item?.severity).toBe("advisory");
    expect(item?.message).toContain("round off only the total");
    expect(sd(fullFacts()).openItems.find((i) => i.id === "schd-rounding")).toBeUndefined();
  });

  it("Exception 1: only capital gain distributions -> 1040 line 7a = box 2a, Schedule D lines not applicable, qdcg.3 = line 7a", () => {
    const f = fullFacts();
    f.income.dividends = [dividend({ docId: "div-1", box1aCents: 100_000, box1bCents: 80_000, box2aCents: 30_000 })];
    f.income.dividendBoxes2b2dConfirmedZero = true;
    const out = sd(f);
    expect(out.detail.exception1).toBe(true);
    expect(amt(out, "f1040.7a")).toBe("300");
    expect(amt(out, "qdcg.3")).toBe("300");
    expect(st(out, "schd.13")).toBe("not_applicable");
    expect(st(out, "schd.16")).toBe("not_applicable");
    const ret = computeTy2025Return(f);
    expect(rAmt(ret, "f1040.7a")).toBe(300);
    expect(ret.formsRequired.schd?.required).toBe(false);
  });

  it("the old 1099-B 'other box' signal still blocks line 7a when the capture side is not wired", () => {
    const f = fullFacts();
    f.income.otherIncomeBoxes = [{ docId: "d1", payer: "Broker", basis: "doc_verified", variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 1 }];
    const ret = computeTy2025Return(f);
    expect(rSt(ret, "f1040.7a")).toBe("needs_cpa_judgment");
    expect(rSt(ret, "qdcg.3")).toBe("needs_cpa_judgment");
    expect(ret.formsRequired.schd?.required).toBe("blocking");
  });

  it("with capitalGains present the engine ignores 1099-B 'other box' entries (the resolver is the source of truth)", () => {
    const f = withCg(REAL_ROWS());
    f.income.otherIncomeBoxes = [{ docId: "rh", payer: "Broker", basis: "doc_verified", variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 1 }];
    expect(rAmt(computeTy2025Return(f), "f1040.7a")).toBe(5557);
  });
});

describe("routing: lines 1a / 8a versus Form 8949", () => {
  it("IRS Schedule D instructions Example 1: proceeds 6,000, basis 2,000, basis reported, no adjustment -> line 8a 6,000 / 2,000 / 4,000, no Form 8949", () => {
    const out = sd(withCg([row("D", 600_000, 200_000)]));
    expect(amt(out, "schd.8a.d")).toBe("6000");
    expect(amt(out, "schd.8a.e")).toBe("2000");
    expect(amt(out, "schd.8a.h")).toBe("4000");
    expect(amt(out, "schd.8b.h")).toBe("0");
    expect(out.detail.form8949Required).toBe(false);
    expect(out.detail.categories[0]).toMatchObject({ routing: "schedule_d_direct", codes: "", description: "" });
    expect(out.openItems.find((i) => i.id === "schd-attached-statement")).toBeUndefined();
    const ret = computeTy2025Return(withCg([row("D", 600_000, 200_000)]));
    expect(ret.formsRequired.schd?.required).toBe(true);
    expect(ret.formsRequired.f8949?.required).toBe(false);
  });

  it("Example 1 continued: a second transaction (5,000 / 3,000) combines to 11,000 / 5,000 / 6,000 on line 8a", () => {
    const f = withCg([row("D", 600_000, 200_000), row("D", 500_000, 300_000, { docId: "rh2", refs: [{ kind: "document", id: "rh2", label: "1099" }] })]);
    const out = sd(f);
    expect(amt(out, "schd.8a.d")).toBe("11000");
    expect(amt(out, "schd.8a.e")).toBe("5000");
    expect(amt(out, "schd.8a.h")).toBe("6000");
    // same broker, two documents: one summary row
    expect(out.detail.categories).toHaveLength(1);
    expect(out.detail.categories[0]!.rows).toHaveLength(1);
  });

  it("a short-term box A category with basis reported and no adjustment goes directly to line 1a", () => {
    const out = sd(withCg([row("A", 250_000, 100_000)]));
    expect(amt(out, "schd.1a.d")).toBe("2500");
    expect(amt(out, "schd.1a.h")).toBe("1500");
    expect(amt(out, "schd.1b.d")).toBe("0");
    expect(amt(out, "schd.7")).toBe("1500");
    expect(out.detail.form8949Required).toBe(false);
  });

  it("box B and box E (basis NOT reported to the IRS) always go through Form 8949, lines 2 and 9, code M", () => {
    const out = sd(withCg([row("B", 1_000_000, 1_200_000), row("E", 300_000, 100_000)]));
    expect(amt(out, "schd.2.d")).toBe("10000");
    expect(amt(out, "schd.2.e")).toBe("12000");
    expect(amt(out, "schd.2.g")).toBe("0");
    expect(amt(out, "schd.2.h")).toBe("-2000");
    expect(amt(out, "schd.9.h")).toBe("2000");
    expect(amt(out, "schd.1a.h")).toBe("0");
    expect(amt(out, "schd.8a.h")).toBe("0");
    expect(amt(out, "schd.7")).toBe("-2000");
    expect(amt(out, "schd.15")).toBe("2000");
    expect(amt(out, "schd.16")).toBe("0");
    expect(out.detail.form8949Required).toBe(true);
    expect(out.detail.categories.map((c) => [c.box, c.line, c.routing, c.codes])).toEqual([
      ["B", "2", "form_8949_summary", "M"],
      ["E", "9", "form_8949_summary", "M"],
    ]);
  });

  it("a category with any wash sale goes to Form 8949 even when it is box D; code MW", () => {
    const out = sd(withCg([row("D", 900_000, 1_000_000, { washSaleCents: 20_000 })]));
    expect(amt(out, "schd.8a.d")).toBe("0");
    expect(amt(out, "schd.8b.d")).toBe("9000");
    expect(amt(out, "schd.8b.e")).toBe("10000");
    expect(amt(out, "schd.8b.g")).toBe("200");
    expect(amt(out, "schd.8b.h")).toBe("-800"); // 9,000 - 10,000 + 200
    expect(out.detail.categories[0]).toMatchObject({ routing: "form_8949_summary", codes: "MW", gainCents: -80_000 });
  });

  it("two brokers in one box: one Form 8949 summary row per broker (the instructions: totals from each broker on a separate row)", () => {
    const f = withCg([
      row("B", 100_000, 50_000),
      row("B", 200_000, 80_000, { docId: "x2", payer: "Other Broker LLC", refs: [{ kind: "document", id: "x2", label: "1099" }] }),
    ]);
    const out = sd(f);
    const b = out.detail.categories.find((c) => c.box === "B")!;
    expect(b.rows.map((r) => [r.payer, r.proceedsCents, r.gainCents])).toEqual([
      ["Robinhood Markets, Inc.", 100_000, 50_000],
      ["Other Broker LLC", 200_000, 120_000],
    ]);
    expect(amt(out, "schd.2.d")).toBe("3000"); // the Schedule D line is the total of both
    expect(b.description).toBe("Robinhood Markets, Inc. / Other Broker LLC - see attached statement");
  });

  it("the owner's 'broker could not know of an adjustment' answer (cgadj): No/Not sure/unanswered all block; 'none' unblocks", () => {
    for (const [leaf, status] of [
      [owner(false), "needs_cpa_judgment"],
      [unsureLeaf<boolean>([]), "needs_cpa_judgment"],
      [missingLeaf<boolean>(), "missing_input"],
    ] as const) {
      const out = sd(withCg([row("D", 600_000, 200_000)], { noBrokerAdjustments: leaf }));
      expect(st(out, "schd.8a.d")).toBe(status);
      expect(st(out, "schd.16")).toBe(status);
      expect(st(out, "f1040.7a")).toBe(status);
      expect(st(out, "qdcg.3")).toBe(status);
      expect(out.openItems.find((i) => i.id === "schd-adjustments-owner")?.severity).toBe("blocking");
      expect(out.detail.form8949Required).toBe("blocking");
    }
    expect(st(sd(withCg([row("D", 600_000, 200_000)])), "f1040.7a")).toBe("computed");
  });

  it("the owner's 'statement lists every sale' answer (cgall): No / Not sure / unanswered block Schedule D", () => {
    for (const [leaf, status] of [
      [owner(false), "needs_cpa_judgment"],
      [unsureLeaf<boolean>([]), "needs_cpa_judgment"],
      [missingLeaf<boolean>(), "missing_input"],
    ] as const) {
      const out = sd(withCg([row("D", 600_000, 200_000)], { salesComplete: leaf }));
      expect(st(out, "f1040.7a")).toBe(status);
      expect(out.openItems.find((i) => i.id === "schd-other-sales")?.severity).toBe("blocking");
    }
  });
});

describe("rounding: cents are added first and rounded once", () => {
  it("line 16 is the rounded total of the exact lines, not the sum of the rounded lines (a $1 difference)", () => {
    // ST (box A, clean): 100.60 - 100.00 = 0.60 -> line 7 = 1; LT (box D, clean): 0.60 -> line 15 = 1; line 16 = 1.20 -> 1 (not 2)
    const out = sd(withCg([row("A", 10_060, 10_000), row("D", 10_060, 10_000)]));
    expect(amt(out, "schd.7")).toBe("1");
    expect(amt(out, "schd.15")).toBe("1");
    expect(amt(out, "schd.16")).toBe("1");
    expect(ex(out, "schd.16")).toBe("1.2");
    expect(amt(out, "f1040.7a")).toBe("1");
  });

  it("a cell (h) is rounded from the exact (d) - (e) + (g): 5,872 - 5,286 + 6 = 592 is NOT line 1b (h) = 593", () => {
    const out = sd(withCg(REAL_ROWS()));
    expect(Number(amt(out, "schd.1b.d")) - Number(amt(out, "schd.1b.e")) + Number(amt(out, "schd.1b.g"))).toBe(592);
    expect(amt(out, "schd.1b.h")).toBe("593");
  });
});

describe("losses, the $3,000 limit and the carryover to 2026", () => {
  it("a small net loss is fully deductible: -1,200.50 -> line 16 = -1,201, line 21 = 1,201, 1040 line 7a = -1,201, qdcg.3 = 0", () => {
    const out = sd(withCg([row("D", 100_000, 220_050)]));
    expect(amt(out, "schd.15")).toBe("-1201");
    expect(amt(out, "schd.16")).toBe("-1201");
    expect(amt(out, "schd.21")).toBe("1201"); // the form prints it in parentheses: stored as the magnitude
    expect(amt(out, "f1040.7a")).toBe("-1201");
    expect(amt(out, "qdcg.3")).toBe("0");
    expect(out.detail.line17).toBe(false);
    expect(out.detail.line22).toBe(true); // qualified dividends 800 on line 3a
    const ret = computeTy2025Return(withCg([row("D", 100_000, 220_050)]));
    expect(rSt(ret, "schd.18")).toBe("not_applicable"); // the owner stated no collectibles / QSB / QOF
    expect(rAmt(ret, "f1040.7a")).toBe(-1201);
    expect(rAmt(ret, "f1040.11a")).toBe(176_766); // 177,967 - 1,201
    expect(ret.scheduleD?.carryoverOut).toBeNull();
  });

  it("a net loss over $3,000 is limited: 16 = -50,000, line 21 = 3,000, 1040 line 7a = -3,000, carryover 47,000 long-term", () => {
    const f = withCg([row("D", 10_000_000, 15_000_000)]);
    const out = sd(f);
    expect(amt(out, "schd.16")).toBe("-50000");
    expect(amt(out, "schd.21")).toBe("3000");
    expect(amt(out, "f1040.7a")).toBe("-3000");
    const ret = computeTy2025Return(f);
    expect(rAmt(ret, "f1040.7a")).toBe(-3000);
    expect(rAmt(ret, "f1040.11a")).toBe(174_967); // 177,967 - 3,000
    expect(ret.scheduleD?.carryoverOut).toEqual({ shortCents: 0, longCents: 4_700_000, totalCents: 4_700_000 });
    expect(ret.openItems.find((i) => i.id === "schd-carryover-out")?.severity).toBe("advisory");
    // the loss reduces net investment income: 500 + 1,000 - 3,000 = -1,500 -> Form 8960 line 12 = 0
    expect(rAmt(ret, "f8960.nii")).toBe(0);
  });

  it("short-term gain with a long-term loss that nets to a loss: lines 7 = 10,000, 15 = -25,000, 16 = -15,000, limit 3,000, carryover 12,000 long-term", () => {
    const f = withCg([row("A", 2_000_000, 1_000_000), row("D", 500_000, 3_000_000)]);
    const ret = computeTy2025Return(f);
    expect(rAmt(ret, "schd.7")).toBe(10_000);
    expect(rAmt(ret, "schd.15")).toBe(-25_000);
    expect(rAmt(ret, "schd.16")).toBe(-15_000);
    expect(rAmt(ret, "schd.21")).toBe(3000);
    expect(rAmt(ret, "f1040.7a")).toBe(-3000);
    expect(rAmt(ret, "qdcg.3")).toBe(0);
    // Capital Loss Carryover Worksheet: 2) 3,000  3) large  4) 3,000  5) 0 (line 7 is a gain)  9) 25,000  10) 10,000  11) 3,000  12) 13,000  13) 12,000
    expect(ret.scheduleD?.carryoverOut).toEqual({ shortCents: 0, longCents: 1_200_000, totalCents: 1_200_000 });
  });

  it("short-term gain 30,000 and long-term loss -10,000: line 16 is a GAIN of 20,000 (1040 line 7a) but QDCG line 3 is 0 (line 15 is a loss); tax hand-computed", () => {
    const f = withCg([row("A", 4_000_000, 1_000_000), row("D", 1_000_000, 2_000_000)]);
    const ret = computeTy2025Return(f);
    expect(rAmt(ret, "schd.7")).toBe(30_000);
    expect(rAmt(ret, "schd.15")).toBe(-10_000);
    expect(rAmt(ret, "schd.16")).toBe(20_000);
    expect(rAmt(ret, "f1040.7a")).toBe(20_000);
    expect(rAmt(ret, "qdcg.3")).toBe(0);
    expect(ret.scheduleD).toMatchObject({ line17: false, line22: true, carryoverOut: null });
    // AGI 177,967 + 20,000 = 197,967; QBI unchanged (9,293); taxable income 197,967 - 31,500 - 9,293 = 157,174
    expect(rAmt(ret, "f1040.15")).toBe(157_174);
    // QDCG worksheet: 1) 157,174  2) 800  3) 0  4) 800  5) 156,374  ...  16) 800  17) 800  18) 120  19) 800  20) 0  21) 0
    //   22) tax on 156,374 = 11,157 + 22% x 59,424 (13,073.28) = 24,230.28   23) 120 + 24,230.28 = 24,350.28 -> 24,350
    //   24) tax on 157,174 = 11,157 + 22% x 60,224 (13,249.28) = 24,406.28 -> 24,406   25) smaller = 24,350
    expect(rAmt(ret, "f1040.16")).toBe(24_350);
    expect(rAmt(ret, "qdcg.25")).toBe(24_350);
    // using 1040 line 7a (20,000) as worksheet line 3 would have given a different (wrong) tax
    const wrong = qdcgWorksheet(D(157_174), D(800), D(20_000)).tax;
    expect(wrong.toNumber()).not.toBe(24_350);
  });

  it("zero net: line 16 = 0, 1040 line 7a = 0, no loss line", () => {
    const out = sd(withCg([row("A", 500_000, 500_000)]));
    expect(amt(out, "schd.16")).toBe("0");
    expect(amt(out, "f1040.7a")).toBe("0");
    expect(amt(out, "schd.21")).toBe("0");
    expect(amt(out, "qdcg.3")).toBe("0");
    expect(out.detail.line17).toBe(false);
  });

  it("Capital Loss Carryover Worksheet logic: short and long losses, and a negative taxable income adds to the carryover", () => {
    // l7 = -4,000, l15 = -2,000, line 21 = 3,000, plenty of taxable income:
    //   4) 3,000  5) 4,000  6) 0  7) 3,000  8) 1,000  9) 2,000  10) 0  11) 0  12) 0  13) 2,000
    expect(computeCapitalLossCarryoverOut({ line7: D(-4000), line15: D(-2000), line21: D(3000), taxableIncomeBeforeFloor: D(100_000) })).toEqual({ shortCents: 100_000, longCents: 200_000, totalCents: 300_000 });
    // taxable income would be -500: line 3 = 2,500, line 4 = 2,500; 7) 2,500; 8) 1,500; 13) 2,000 -> 3,500 (= 6,000 - 2,500 deducted)
    expect(computeCapitalLossCarryoverOut({ line7: D(-4000), line15: D(-2000), line21: D(3000), taxableIncomeBeforeFloor: D(-500) })).toEqual({ shortCents: 150_000, longCents: 200_000, totalCents: 350_000 });
    // a loss fully used: no carryover
    expect(computeCapitalLossCarryoverOut({ line7: D(-1000), line15: D(0), line21: D(1000), taxableIncomeBeforeFloor: D(50_000) })).toBeNull();
  });
});

describe("carryover from 2024 (lines 6 and 14), line 13 and other Schedule D lines", () => {
  it("a stated 1,000 short-term carryover reduces line 7; 2,000 long-term reduces line 15 (positive amounts on lines 6 and 14)", () => {
    const f = withCg([row("A", 500_000, 100_000), row("D", 900_000, 200_000)], { carryoverShort: owner(100_000), carryoverLong: owner(200_000) });
    const out = sd(f);
    expect(amt(out, "schd.6")).toBe("1000");
    expect(amt(out, "schd.14")).toBe("2000");
    expect(amt(out, "schd.7")).toBe("3000"); // 4,000 - 1,000
    expect(amt(out, "schd.15")).toBe("5000"); // 7,000 - 2,000
    expect(amt(out, "schd.16")).toBe("8000");
  });

  it("'none' = lines 6 and 14 are 0 (not_applicable, answer_owner provenance); unanswered blocks; Not sure needs the CPA", () => {
    const none = sd(withCg([row("D", 600_000, 200_000)]));
    expect(st(none, "schd.6")).toBe("not_applicable");
    expect(line(none, "schd.6").refs?.[0]?.kind).toBe("planning");
    const unanswered = sd(withCg([row("D", 600_000, 200_000)], { carryoverShort: missingLeaf(), carryoverLong: missingLeaf() }));
    expect(st(unanswered, "schd.6")).toBe("missing_input");
    expect(st(unanswered, "schd.7")).toBe("missing_input");
    expect(st(unanswered, "f1040.7a")).toBe("missing_input");
    const unsure = sd(withCg([row("D", 600_000, 200_000)], { carryoverLong: unsureLeaf<number>([]) }));
    expect(st(unsure, "schd.14")).toBe("needs_cpa_judgment");
    expect(st(unsure, "f1040.7a")).toBe("needs_cpa_judgment");
  });

  it("the provisional pass assumes an unanswered carryover (and the other open answers) as $0 and says so", () => {
    const f = withCg(REAL_ROWS(), { carryoverShort: missingLeaf(), carryoverLong: missingLeaf(), salesComplete: missingLeaf(), noBrokerAdjustments: missingLeaf(), otherLinesNone: missingLeaf(), specialRatesNone: missingLeaf() });
    const ret = computeTy2025Return(f);
    expect(rSt(ret, "f1040.7a")).toBe("missing_input");
    expect(ret.headline.complete).toBe(false);
    expect(ret.headline.provisional?.lines["f1040.7a"]).toBe(5557);
    const assumed = ret.headline.provisional?.assumedFacts.join(" | ") ?? "";
    expect(assumed).toContain("short-term capital loss carryover from 2024, not stated, assumed $0");
    expect(assumed).toContain("long-term capital loss carryover from 2024, not stated, assumed $0");
    expect(assumed).toContain("Whether the broker statement lists every sale is not answered");
    expect(assumed).toContain("Whether the broker missed an adjustment is not answered");
  });

  it("a stated carryover with no sales still requires Schedule D: line 16 = -500, 1040 line 7a = -500", () => {
    const out = sd(withCg([], { carryoverShort: owner(50_000) }));
    expect(out.detail.required).toBe(true);
    expect(amt(out, "schd.7")).toBe("-500");
    expect(amt(out, "schd.16")).toBe("-500");
    expect(amt(out, "schd.21")).toBe("500");
    expect(amt(out, "f1040.7a")).toBe("-500");
  });

  it("an unsure carryover answer with no sales cannot rule Schedule D out: required 'blocking', line 7a needs the CPA", () => {
    const f = withCg([], { carryoverShort: unsureLeaf<number>([]) });
    const ret = computeTy2025Return(f);
    expect(ret.scheduleD?.required).toBe("blocking");
    expect(ret.formsRequired.schd?.required).toBe("blocking");
    expect(rSt(ret, "f1040.7a")).toBe("needs_cpa_judgment");
  });

  it("capital gain distributions (1099-DIV box 2a) are added to Schedule D line 13 and flow to 1040 line 7a", () => {
    const f = withCg([row("D", 600_000, 200_000)]);
    f.income.dividends = [dividend({ docId: "div-1", box1aCents: 100_000, box1bCents: 80_000, box2aCents: 30_050 })];
    const out = sd(f);
    expect(amt(out, "schd.13")).toBe("301"); // 300.50 rounds up
    expect(amt(out, "schd.15")).toBe("4301"); // 4,000 + 300.50 = 4,300.50
    expect(ex(out, "schd.15")).toBe("4300.5");
    expect(amt(out, "f1040.7a")).toBe("4301");
  });

  it("unknown capital gain distributions (no dividend document, none confirmed) block line 13 and everything after", () => {
    const f = withCg([row("D", 600_000, 200_000)]);
    f.income.dividends = [];
    f.income.noDividendsConfirmed = missingLeaf();
    const out = sd(f);
    expect(st(out, "schd.13")).toBe("missing_input");
    expect(st(out, "schd.15")).toBe("missing_input");
    expect(st(out, "f1040.7a")).toBe("missing_input");
  });

  it("lines 4, 5, 11, 12 (the capital_gain_other statement): 'none' = 0; 'there is one' = the CPA; 'Not sure' / unanswered = not stated, so line 7 waits", () => {
    const base = [row("D", 600_000, 200_000)];
    const none = computeTy2025Return(withCg(base));
    expect(rSt(none, "schd.4")).toBe("not_applicable");
    expect(rAmt(none, "schd.12")).toBe(0);
    const yes = computeTy2025Return(withCg(base, { otherLinesNone: owner(false) }));
    expect(rSt(yes, "schd.11")).toBe("needs_cpa_judgment");
    expect(rSt(yes, "f1040.7a")).toBe("needs_cpa_judgment");
    expect(rSt(yes, "schd.16")).toBe("needs_cpa_judgment");
    for (const leaf of [unsureLeaf<boolean>([]), missingLeaf<boolean>()]) {
      const ret = computeTy2025Return(withCg(base, { otherLinesNone: leaf }));
      expect(rSt(ret, "schd.5")).toBe("not_yet_computed");
      expect(rSt(ret, "schd.16")).toBe("missing_input"); // Schedule D's own totals need the statement
      expect(rSt(ret, "f1040.7a")).toBe("missing_input");
      expect(ret.openItems.find((i) => i.id === "none:capital_gain_other")?.severity).toBe("blocking");
    }
  });

  it("an owner 'there is a collectibles / QSB / QOF item' with a net LOSS does not block the tax but leaves an advisory for lines 18, 19 and the QOF box", () => {
    const out = sd(withCg([row("D", 100_000, 400_000)], { specialRatesNone: owner(false) }));
    expect(st(out, "f1040.7a")).toBe("computed");
    expect(out.detail.taxWorksheetNeeded).toBe(false);
    expect(out.openItems.find((i) => i.id === "schd-special-rates")?.severity).toBe("advisory");
  });

  it("lines 18 / 19 (collectibles, QSB, section 1250) with both gains: not 'none' -> the Schedule D Tax Worksheet, which is not implemented: tax blocked", () => {
    const base = [row("D", 600_000, 200_000)];
    const no = computeTy2025Return(withCg(base, { specialRatesNone: owner(false) }));
    expect(rSt(no, "schd.18")).toBe("needs_cpa_judgment"); // the owner said Yes: the line cannot be computed here
    expect(rSt(no, "f1040.16")).toBe("needs_cpa_judgment");
    expect(rSt(no, "qdcg.25")).toBe("needs_cpa_judgment");
    expect(no.scheduleD?.taxWorksheetNeeded).toBe(true);
    expect(no.scheduleD?.line20).toBeNull();
    const missing = computeTy2025Return(withCg(base, { specialRatesNone: missingLeaf() }));
    expect(rSt(missing, "schd.19")).toBe("not_yet_computed"); // not stated yet
    expect(rSt(missing, "f1040.16")).toBe("missing_input");
    // with a loss, lines 17-20 are skipped and the answer does not matter for the tax
    const loss = computeTy2025Return(withCg([row("D", 100_000, 400_000)], { specialRatesNone: missingLeaf() }));
    expect(rSt(loss, "f1040.16")).toBe("computed");
    expect(loss.scheduleD?.taxWorksheetNeeded).toBe(false);
  });
});

describe("what is never computed", () => {
  it("a null proceeds / cost / wash sale / discount is never defaulted to 0 (missing_input on the lines and everything after)", () => {
    const cases: [string, TestRow][] = [
      ["proceeds", row("D", null, 100)],
      ["cost", row("D", 100, null)],
      ["wash sale", row("D", 100, 50, { washSaleCents: null })],
      ["accrued market discount", row("D", 100, 50, { accruedMarketDiscountCents: null })],
    ];
    for (const [what, r] of cases) {
      const out = sd(withCg([r]));
      expect(st(out, "schd.8a.h"), what).toBe("missing_input");
      expect(st(out, "schd.15"), what).toBe("missing_input");
      expect(st(out, "f1040.7a"), what).toBe("missing_input");
      expect(st(out, "qdcg.3"), what).toBe("missing_input");
      expect(amt(out, "f1040.7a"), what).toBeNull();
    }
    // an unknown wash sale on a box that could go either way blocks both candidate lines
    const wash = sd(withCg([row("A", 100, 50, { washSaleCents: null })]));
    expect(st(wash, "schd.1a.h")).toBe("missing_input");
    expect(st(wash, "schd.1b.h")).toBe("missing_input");
    expect(wash.detail.form8949Required).toBe("blocking");
    // the provisional pass assumes 0 and lists it
    const prov = sd(withCg([row("D", null, 100)]), true);
    expect(st(prov, "f1040.7a")).toBe("computed");
    expect(prov.assumptions.join(" ")).toContain("proceeds not read, assumed $0");
  });

  it("accrued market discount (code B) needs the CPA", () => {
    const out = sd(withCg([row("D", 600_000, 200_000, { accruedMarketDiscountCents: 1_500 })]));
    expect(st(out, "schd.8b.h")).toBe("needs_cpa_judgment");
    expect(st(out, "f1040.7a")).toBe("needs_cpa_judgment");
    expect(out.result.reasons[0]).toContain("accrued market discount");
  });

  it("boxes C / F / I / L and a form / box mismatch need the CPA", () => {
    expect(st(sd(withCg([row("C", 100, 50)])), "schd.3.h")).toBe("needs_cpa_judgment");
    expect(st(sd(withCg([row("F", 100, 50)])), "schd.10.h")).toBe("needs_cpa_judgment");
    expect(st(sd(withCg([row("A", 100, 50, { form: "1099-DA" })])), "f1040.7a")).toBe("needs_cpa_judgment");
    expect(st(sd(withCg([row("K", 100, 50, { form: "1099-B" })])), "f1040.7a")).toBe("needs_cpa_judgment");
  });

  it("a 1099-DA (digital asset) row is computed (box K -> line 9) but carries blocking items; the digital assets answer must agree", () => {
    const f = withCg([row("K", 100_000, 50_000, { form: "1099-DA" })]);
    const out = sd(f);
    expect(amt(out, "schd.9.d")).toBe("1000");
    expect(amt(out, "schd.9.e")).toBe("500");
    expect(amt(out, "schd.9.h")).toBe("500");
    expect(st(out, "f1040.7a")).toBe("computed");
    expect(out.detail.categories[0]).toMatchObject({ form: "1099-DA", box: "K", line: "9", routing: "form_8949_summary", codes: "M" });
    expect(out.openItems.find((i) => i.id === "schd-1256-or-1099da")?.severity).toBe("blocking");
    expect(out.openItems.find((i) => i.id === "schd-digital-answer")?.severity).toBe("blocking"); // fullFacts answers No
    f.returnAnswers.attestations.digitalAssets = owner(true);
    expect(sd(f).openItems.find((i) => i.id === "schd-digital-answer")).toBeUndefined();
    // a clean 1099-DA box J (basis reported) can go on line 8a
    expect(amt(sd(withCg([row("J", 100_000, 50_000, { form: "1099-DA" })])), "schd.8a.h")).toBe("500");
    // blocking items make the return incomplete
    expect(computeTy2025Return(withCg([row("K", 100_000, 50_000, { form: "1099-DA" })])).headline.complete).toBe(false);
  });

  it("Section 1256 contracts (Form 6781) are never computed: the capital_gain_other lines are forced to the CPA (even with 'none' stated) and a blocking item is raised", () => {
    const f = withCg([row("D", 600_000, 200_000)], { section1256Cents: 123_456 });
    const out = sd(f);
    expect(st(out, "f1040.7a")).toBe("needs_cpa_judgment");
    expect(out.openItems.find((i) => i.id === "schd-1256-or-1099da")?.message).toContain("aggregate $1,234.56");
    const ret = computeTy2025Return(f);
    expect(rSt(ret, "schd.4")).toBe("needs_cpa_judgment");
    expect(rSt(ret, "schd.11")).toBe("needs_cpa_judgment");
    expect(rSt(ret, "f1040.7a")).toBe("needs_cpa_judgment");
    // Section 1256 alone (no sales) still requires Schedule D
    expect(sd(withCg([], { section1256Cents: 123_456 })).detail.required).toBe(true);
    // a printed 0.00 aggregate is "no Section 1256 activity": nothing is blocked
    const zero = withCg(REAL_ROWS(), { section1256Cents: 0 });
    expect(rSt(computeTy2025Return(zero), "f1040.7a")).toBe("computed");
    expect(rSt(computeTy2025Return(zero), "schd.4")).toBe("not_applicable");
  });

  it("a 1099-DA that is present (variantsPresent) but whose rows were not read cannot be ruled out", () => {
    const out = sd(withCg([], { da1099: true }));
    expect(out.detail.required).toBe("blocking");
    expect(out.openItems.find((i) => i.id === "schd-1256-or-1099da")?.severity).toBe("blocking");
    const unread = withCg([], { da1099: true });
    unread.income.brokerSales[0] = { ...unread.income.brokerSales[0]!, summaryRead: false };
    expect(st(sd(unread), "f1040.7a")).toBe("missing_input");
    expect(sd(unread).openItems.find((i) => i.id === "schd-unread")).toBeDefined();
  });

  it("a row whose Form 8949 box or information return was not read cannot be routed: missing_input, never guessed", () => {
    for (const r of [row(null, 100_000, 50_000), row("D", 100_000, 50_000, { form: null })]) {
      const out = sd(withCg([r]));
      expect(st(out, "f1040.7a")).toBe("missing_input");
      expect(st(out, "schd.16")).toBe("missing_input");
      expect(out.result.reasons[0]).toContain("no Form 8949 box or information return");
    }
    // the provisional pass leaves the row out and says so
    expect(sd(withCg([row(null, 100_000, 50_000)]), true).assumptions.join(" ")).toContain("left out");
  });

  it("an unread 1099-B sales summary blocks Schedule D with a re-extract item (and the provisional pass assumes no sales)", () => {
    const f = withCg([], { unread: [{ docId: "rh", payer: "Robinhood Markets, Inc." }] });
    const out = sd(f);
    expect(out.detail.required).toBe("blocking");
    expect(st(out, "f1040.7a")).toBe("missing_input");
    expect(out.openItems.find((i) => i.id === "schd-unread")?.severity).toBe("blocking");
    expect(sd(f, true).assumptions.join(" ")).toContain("not read: assumed no sales");
    const ret = computeTy2025Return(f);
    expect(ret.formsRequired.schd?.required).toBe("blocking");
    expect(ret.headline.complete).toBe(false);
  });

  it("the broker's printed gain is only a cross-check: a mismatch is a blocking reconciliation item, never the computed figure", () => {
    const f = withCg([row("D", 600_000, 200_000, { brokerGainCents: 390_000 })]);
    const out = sd(f);
    expect(amt(out, "schd.8a.h")).toBe("4000"); // computed from proceeds and cost
    const item = out.openItems.find((i) => i.id === "schd-reconciliation:1099-B:D");
    expect(item?.severity).toBe("blocking");
    // either the gain before or after the wash sale add-back reconciles
    expect(sd(withCg([row("B", 100_000, 80_000, { washSaleCents: 5_000, brokerGainCents: 20_000 })])).openItems.some((i) => i.id.startsWith("schd-reconciliation"))).toBe(false);
    expect(sd(withCg([row("B", 100_000, 80_000, { washSaleCents: 5_000, brokerGainCents: 25_000 })])).openItems.some((i) => i.id.startsWith("schd-reconciliation"))).toBe(false);
  });
});

describe("forms required and the NIIT screen", () => {
  it("schd / f8949 verdicts across the cases", () => {
    const v = (f: Ty2025Facts) => computeTy2025Return(f).formsRequired;
    expect(v(fullFacts()).schd?.required).toBe(false);
    expect(v(fullFacts()).f8949?.required).toBe(false);
    expect(v(withCg([row("D", 600_000, 200_000)])).schd?.required).toBe(true);
    expect(v(withCg([row("D", 600_000, 200_000)])).f8949?.required).toBe(false);
    expect(v(withCg([row("E", 600_000, 200_000)])).f8949?.required).toBe(true);
    expect(v(withCg([row("D", 600_000, 200_000)], { noBrokerAdjustments: missingLeaf() })).f8949?.required).toBe("blocking");
    expect(v(withCg([], { carryoverShort: owner(1_000) })).schd?.required).toBe(true);
    expect(v(withCg([], { carryoverShort: owner(1_000) })).f8949?.required).toBe(false);
  });

  it("NIIT: Form 8960 line 5a is the signed 1040 line 7a; net investment income cannot go below zero", () => {
    const lead = (n: number) => ({ amount: D(n), status: "computed" as const });
    const base: Form8960Input = {
      agi: lead(300_000),
      magiExclusionsNone: { state: "answered", value: true },
      interest: lead(500),
      dividends: lead(1000),
      pensions: lead(0),
      gain7a: lead(0),
      sch1Line3: lead(0),
      sch1Line4: lead(0),
      sch1Line5: lead(0),
      sch1Line6: lead(0),
      schA5a: lead(0),
      schA5d: lead(0),
      schA5e: lead(0),
      schA9: lead(0),
      itemizing: false,
      itemizingStatus: undefined,
      statedNoCapitalOther: true,
      niitOther: true,
      otherInvestmentIncomePresent: false,
    };
    const line = (r: ReturnType<typeof computeForm8960>, key: LineKey) => r.lines.find((l) => l.key === key)?.amount?.toString();
    // gain: NII = 500 + 1,000 + 5,557 = 7,057; MAGI excess 50,000; 3.8% x 7,057 = 268.166 -> 268
    const gain = computeForm8960({ ...base, gain7a: lead(5557) });
    expect(line(gain, "f8960.nii")).toBe("7057");
    expect(line(gain, "f8960.niit")).toBe("268");
    // limited loss: 500 + 1,000 - 3,000 = -1,500 -> line 12 = 0 -> no tax
    const loss = computeForm8960({ ...base, gain7a: lead(-3000) });
    expect(line(loss, "f8960.nii")).toBe("0");
    expect(line(loss, "f8960.niit")).toBe("0");
    // a loss that does not exceed the other income: 500 + 1,000 - 1,000 = 500; 3.8% = 19
    const small = computeForm8960({ ...base, gain7a: lead(-1000) });
    expect(line(small, "f8960.niit")).toBe("19");
  });

  it("NIIT through the return above the threshold: MAGI 273,524 -> 3.8% x the smaller of NII 7,057 or the 23,524 excess = 268", () => {
    const f = withCg(REAL_ROWS());
    f.income.w2s[0]!.wagesCents = 18_000_000; // +90,000 of wages: AGI 273,524
    const ret = computeTy2025Return(f);
    expect(rAmt(ret, "f1040.11a")).toBe(273_524);
    expect(rAmt(ret, "f8960.nii")).toBe(7057);
    expect(rAmt(ret, "f8960.niit")).toBe(268); // 0.038 x 7,057 = 268.166
    expect(rAmt(ret, "sch2.12")).toBe(268);
    expect(ret.formsRequired.f8960).toMatchObject({ required: true });
  });

  it("Section 1256 contracts block line 7a, so the NIIT screen cannot conclude (missing input, never a silent 0)", () => {
    const ret = computeTy2025Return(withCg(REAL_ROWS(), { section1256Cents: 5_000 }));
    expect(rSt(ret, "f1040.7a")).toBe("needs_cpa_judgment");
    expect(rSt(ret, "sch2.12")).toBe("missing_input");
  });
});

describe("pure rule shape", () => {
  it("every Schedule D key is emitted exactly once in each branch (Exception 1, computed, blocked)", () => {
    // lines 4, 5, 11, 12, 18, 19 are none-group lines: return.ts emits them from the owner's statements, the rule does not
    const keys = LINE_KEYS.filter((k) => (k.startsWith("schd.") && lineMeta(k).group === undefined) || k === "qdcg.3" || k === "f1040.7a").sort();
    for (const f of [fullFacts(), withCg(REAL_ROWS()), withCg([row("D", null, 1)]), withCg([], { unread: [{ docId: "u", payer: null }] })]) {
      const out = sd(f);
      expect(out.result.lines.map((l) => l.key).sort()).toEqual(keys);
      for (const l of out.result.lines) {
        if (l.status === "computed" || l.status === "not_applicable") {
          expect(l.amount, l.key).not.toBeNull();
          expect(Number.isInteger(l.amount!.toNumber()), l.key).toBe(true);
        } else {
          expect(l.amount, l.key).toBeNull();
          expect(l.reason, l.key).toBeTruthy();
        }
      }
    }
  });
});

describe("end to end with the capture side's resolver: the real Robinhood 1099 summary -> facts -> Schedule D", () => {
  function resolved(): { facts: Ty2025Facts; openItems: { id: string }[] } {
    const stored = normalizeTaxExtraction("1099", { ...ROBINHOOD_2025_RAW, data: { ...ROBINHOOD_2025_RAW.data, div_box1aCents: 238, div_box1bCents: 200, div_box2aCents: 0, int_box1Cents: 120, otherBoxes: [{ variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 2287399 }] } });
    const r = resolveTaxDocForCompute({ docType: "1099", extractionStatus: "complete", extractionData: stored, extractionCorrections: null, extractionConfirmedAt: new Date("2026-10-02T00:00:00Z") });
    const doc: RawDocument = { id: "rh", docType: "1099", taxYear: 2025, extractionStatus: r.extractionStatus, extractionData: r.extractionData, verified: r.verified, legacyFormat: r.legacyFormat, subjectType: "person", subjectUserId: ERIC_ID, documentName: null };
    const rawInputs: RawTy2025Inputs = {
      taxYear: 2025,
      people: [{ userId: ERIC_ID, name: "Eric" }, { userId: EVA_ID, name: "Eva" }],
      scheduleCOwner: { userId: ERIC_ID, basis: "derived", note: "name matches the entity name" },
      documents: [doc],
      planning: { filingStatus: "mfj", householdMembers: "none", evVehicle: "no", businessMileage: "no", homeOfficeEligibility: "no", homeOfficeSqft: null, solarCredit: null, donationsNone: true, fixedAssetsEkcNone: true, retirementContributionCents: null, estimatedPaymentsCombinedCents: null },
      primaryResidence: { address: "27 Old Barry Rd", basis: "derived" },
      paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
      ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
      donations: [],
    };
    return resolveFacts(rawInputs);
  }

  it("the resolver's brokerSales feed the rule: the real figures, the Section 1256 0.00 aggregate blocks nothing, no re-read item", () => {
    const { facts, openItems } = resolved();
    expect(facts.income.brokerSales[0]).toMatchObject({ summaryRead: true, sec1256AggregateCents: 0 });
    expect(openItems.some((o) => o.id.startsWith("broker-"))).toBe(false);
    // the owner's answers (cgco None, cgall Yes, cgadj No, both groups none) on the household's facts
    const f = fullFacts();
    f.income.brokerSales = facts.income.brokerSales;
    f.income.otherIncomeBoxes = facts.income.otherIncomeBoxes;
    f.returnAnswers.capitalGains = { carryoverShortCents: owner(0), carryoverLongCents: owner(0), salesComplete: owner(true), brokerAdjustments: owner(false) };
    const out = sd(f);
    expect(amt(out, "schd.1b.h")).toBe("593");
    expect(amt(out, "schd.8a.h")).toBe("4964");
    expect(amt(out, "schd.16")).toBe("5557");
    expect(amt(out, "f1040.7a")).toBe("5557");
    expect(amt(out, "qdcg.3")).toBe("4964");
    expect(out.openItems.filter((i) => i.severity === "blocking")).toEqual([]);
    const ret = computeTy2025Return(f);
    expect(ret.headline.federal.totalTax.amount).toBe(27_890);
    expect(ret.headline.complete).toBe(true);
  });

  it("with the owner's answers still missing, the strict return blocks and the provisional estimate carries the real numbers", () => {
    const { facts } = resolved();
    const f = fullFacts();
    f.income.brokerSales = facts.income.brokerSales;
    // returnAnswers.capitalGains stays all-missing (nothing answered yet)
    const ret = computeTy2025Return(f);
    expect(rSt(ret, "f1040.7a")).toBe("missing_input");
    expect(ret.headline.complete).toBe(false);
    expect(ret.headline.provisional?.lines["f1040.7a"]).toBe(5557);
  });
});
