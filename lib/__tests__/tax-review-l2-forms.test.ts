// L2 oracle: form by form, against hand-worked examples (the IRS examples printed in the 2025 Form 8959 instructions, the Form 1040
// Standard Deduction Chart, the Schedule 1-A / SE / A / D lines, the CT-1040 Schedule 3). Each expected number is worked out in a comment
// from the printed form lines. Facts are synthetic; the oracle is read through `oracleLedger`, so the engine is only used to produce the
// Schedule C classification the oracle takes as an input.

import { describe, expect, it } from "vitest";
import type { BrokerBox, Ty2025Facts } from "@/lib/tax2025/facts";
import { applyOverrides } from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Decisions } from "@/lib/tax2025/types";
import { oracleLedger } from "@/lib/tax-review/l2";
import { ERIC_ID, EVA_ID, bill, dividend, fullFacts1b, gl, interest, owner, w2 } from "./tax2025-fixtures";

function household(mod: (f: Ty2025Facts) => void = () => undefined): Ty2025Facts {
  const f = fullFacts1b();
  f.income.scheduleC.glLines = [];
  f.income.interest = [];
  f.income.noInterestConfirmed = owner(true);
  f.income.dividends = [];
  f.income.noDividendsConfirmed = owner(true);
  f.deductions.mortgages = [];
  f.deductions.propertyTaxBills = [];
  f.deductions.noPropertyTaxConfirmed = owner(true);
  f.income.w2s = [];
  f.returnAnswers.capitalGains = { carryoverShortCents: owner(0), carryoverLongCents: owner(0), salesComplete: owner(true), brokerAdjustments: owner(false) };
  mod(f);
  return f;
}

/** A W-2 whose Social Security and Medicare boxes follow the wages (dollars in, cents stored). */
function wage(docId: string, person: string, dollars: number, over: Parameters<typeof w2>[0] extends infer P ? Partial<P> : never = {}) {
  const cents = Math.round(dollars * 100);
  const ss = Math.min(cents, 17_610_000);
  const med = Math.round(cents * 0.0145) + Math.max(0, Math.round((cents - 20_000_000) * 0.009));
  return w2({ docId, employer: `Employer ${docId}`, employerEin: `1${docId.length}-0000000`, personUserId: person, wagesCents: cents, socialSecurityWagesCents: ss, socialSecurityWithheldCents: Math.round(ss * 0.062), medicareWagesCents: cents, medicareWithheldCents: med, ...over });
}

function ledgerOf(facts: Ty2025Facts, decisions: Ty2025Decisions = {}) {
  const ret = computeTy2025Return(facts, decisions);
  const effective = applyOverrides(ret, []);
  const L = oracleLedger({ ret, effective, facts });
  const get = (k: string): number | null => L.get(k);
  return { L, ret, get };
}

describe("Form 1040 lines 1a-3b: cents are summed and the line is rounded once", () => {
  it("wages 50,000.49 + 25,000.50 = 75,000.99 -> 75,001; interest 100.40 + 200.30 = 300.70 -> 301; dividends", () => {
    const f = household((x) => {
      x.income.w2s = [wage("a", ERIC_ID, 50_000.49), wage("b", EVA_ID, 25_000.5)];
      x.income.interest = [interest({ docId: "i1", box1Cents: 10_040 }), interest({ docId: "i2", box1Cents: 20_030, box3Cents: 4_000 })];
      x.income.noInterestConfirmed = { value: null, basis: null, refs: [] };
      x.income.dividends = [dividend({ docId: "d1", box1aCents: 100_050, box1bCents: 60_049 }), dividend({ docId: "d2", box1aCents: 9_949, box1bCents: 0 })];
      x.income.noDividendsConfirmed = { value: null, basis: null, refs: [] };
    });
    const { get } = ledgerOf(f);
    expect(get("f1040.1a")).toBe(75_001);
    expect(get("f1040.2b")).toBe(341); // 100.40 + 200.30 + 40.00 (box 3, U.S. savings bond interest)
    expect(get("f1040.3b")).toBe(1_100); // 1,000.50 + 99.49 = 1,099.99
    expect(get("f1040.3a")).toBe(600); // 600.49
  });
});

describe("Standard deduction (Form 1040 Standard Deduction Chart, married filing jointly)", () => {
  it("$31,500 plus $1,600 per box checked: 33,100 / 34,700 / 36,300 / 37,900", () => {
    const totals: number[] = [];
    for (const boxes of [0, 1, 2, 3, 4]) {
      const f = household((x) => {
        const [a, b] = x.returnAnswers.people;
        a!.bornBefore1961 = owner(boxes >= 1);
        a!.blind = owner(boxes >= 3);
        b!.bornBefore1961 = owner(boxes >= 2);
        b!.blind = owner(boxes >= 4);
      });
      totals.push(ledgerOf(f).get("std.total")!);
    }
    expect(totals).toEqual([31_500, 33_100, 34_700, 36_300, 37_900]);
  });

  it("line 12e is the larger of the standard and the itemized deductions", () => {
    const small = ledgerOf(household((x) => { x.income.w2s = [wage("a", ERIC_ID, 200_000)]; }));
    expect(small.get("f1040.12e")).toBe(31_500);
    const big = ledgerOf(
      household((x) => {
        x.income.w2s = [wage("a", ERIC_ID, 200_000, { ctWithheldCents: 1_000_000 })];
        x.deductions.mortgages = [{ docId: "m", lender: "L", basis: "doc_verified", legacyFormat: false, refs: [], interestCents: 3_500_000, principalCents: 40_000_000, originationDate: "2020-01-01", mortgageInsuranceCents: null, pointsCents: null, box10Cents: null, propertyAddress: "27 Old Barry Rd" }];
      })
    );
    // 5a 10,000 (withholding) + 8a 35,000 = 45,000 > 31,500
    expect(big.get("scha.17")).toBe(45_000);
    expect(big.get("f1040.12e")).toBe(45_000);
  });
});

describe("Schedule SE (hand-worked, 2025 form lines)", () => {
  const sc = (profitDollars: number, ownerSsWages: number) =>
    ledgerOf(
      household((x) => {
        x.income.scheduleC.glLines = [gl("4000", "Services", "revenue", Math.round(profitDollars * 100))];
        x.income.w2s = ownerSsWages > 0 ? [wage("a", ERIC_ID, ownerSsWages)] : [wage("e", EVA_ID, 10_000)];
      })
    );

  it("profit 50,000 with 100,000 of the owner's Social Security wages: 4a 46,175; 9 = 76,100; 10 = 5,726; 11 = 1,339; 12 = 7,065; 13 = 3,533", () => {
    const { get } = sc(50_000, 100_000);
    expect([get("se.4a"), get("se.6"), get("se.8a"), get("se.9"), get("se.10"), get("se.11"), get("se.12"), get("se.13")]).toEqual([46_175, 46_175, 100_000, 76_100, 5_726, 1_339, 7_065, 3_533]);
    expect(get("sch1.15")).toBe(3_533);
    expect(get("sch2.4")).toBe(7_065);
  });

  it("at or above the $176,100 wage base the 12.4% part is zero (line 9 = 0, line 10 = 0)", () => {
    const { get } = sc(50_000, 176_100);
    expect([get("se.9"), get("se.10"), get("se.11"), get("se.12")]).toEqual([0, 0, 1_339, 1_339]);
  });

  it("the $400 floor applies to line 4c: profit 433 -> 4a 399.88 -> 400 owes tax; profit 432 -> 399.0 -> 399 owes none", () => {
    expect(sc(433, 0).get("se.4a")).toBe(400);
    expect(sc(433, 0).get("se.12")).toBe(62); // 400 x 12.4% = 49.60 -> 50; 400 x 2.9% = 11.60 -> 12; 50 + 12
    expect(sc(432, 0).get("se.12")).toBe(0);
    expect(sc(432, 0).get("se.13")).toBe(0);
  });

  it("a net loss owes nothing", () => {
    const { get } = sc(0, 0);
    expect(get("se.12")).toBe(0);
  });
});

describe("Form 8959 (Additional Medicare Tax): the Form 8959 instructions' examples and the withholding reconciliation", () => {
  it("Example 5 (Erin and Frank): wages 150,000 + 175,000 = 325,000 over 250,000 -> 75,000 x 0.9% = 675", () => {
    const { get } = ledgerOf(household((x) => { x.income.w2s = [wage("e", ERIC_ID, 150_000), wage("v", EVA_ID, 175_000)]; }));
    expect([get("f8959.4"), get("f8959.6"), get("f8959.7"), get("f8959.18"), get("sch2.11")]).toEqual([325_000, 75_000, 675, 675, 675]);
    // neither W-2 exceeds 200,000, so nothing was withheld: line 19 = line 21, line 22 = 0
    expect([get("f8959.19"), get("f8959.21"), get("f8959.22"), get("f1040.25c")]).toEqual([4_713, 4_713, 0, 0]);
  });

  it("Kathleen and Liam: wages 130,000 reduce the self-employment threshold to 120,000; 140,000 of SE income -> 20,000 x 0.9% = 180", () => {
    const f = household((x) => {
      x.income.w2s = [wage("k", EVA_ID, 130_000)];
      x.income.scheduleC.glLines = [gl("4000", "Services", "revenue", 15_159_700)]; // 151,597 x 92.35% = 140,000.3 -> line 6 = 140,000
    });
    const { get } = ledgerOf(f);
    expect([get("se.6"), get("f8959.8"), get("f8959.11"), get("f8959.12"), get("f8959.13"), get("f8959.18")]).toEqual([140_000, 140_000, 120_000, 20_000, 180, 180]);
    expect(get("f8959.7")).toBe(0);
  });

  it("one W-2 over 200,000: the employer withheld 0.9% of the excess; the reconciliation returns 900 to line 25c when the tax is 450", () => {
    // Medicare wages 300,000: 1.45% = 4,350 + 0.9% of 100,000 = 900 -> box 6 = 5,250. Tax: (300,000 - 250,000) x 0.9% = 450
    const { get } = ledgerOf(household((x) => { x.income.w2s = [wage("big", EVA_ID, 300_000)]; }));
    expect([get("f8959.7"), get("f8959.19"), get("f8959.21"), get("f8959.22"), get("f1040.25c")]).toEqual([450, 5_250, 4_350, 900, 900]);
  });

  it("not required: wages 190,000 + 40,000 (neither over 200,000, combined under 250,000) -> no Form 8959, zero on Schedule 2 line 11", () => {
    const { get } = ledgerOf(household((x) => { x.income.w2s = [wage("a", ERIC_ID, 190_000), wage("b", EVA_ID, 40_000)]; }));
    expect(get("sch2.11")).toBe(0);
    expect(get("f8959.18")).toBeNull();
  });
});

describe("Form 8960 (net investment income tax) lines 8-17", () => {
  const nii = (agiWages: number, over: (f: Ty2025Facts) => void = () => undefined) =>
    ledgerOf(
      household((x) => {
        x.income.w2s = [wage("a", ERIC_ID, agiWages / 2), wage("b", EVA_ID, agiWages / 2)];
        x.income.interest = [interest({ docId: "i", box1Cents: 4_000_000 })]; // 40,000
        x.income.noInterestConfirmed = { value: null, basis: null, refs: [] };
        x.income.dividends = [dividend({ docId: "d", box1aCents: 2_000_000, box1bCents: 0 })]; // 20,000
        x.income.noDividendsConfirmed = { value: null, basis: null, refs: [] };
        over(x);
      })
    );

  it("standard deduction: AGI 390,000, investment income 60,000 -> line 15 = 140,000, line 16 = 60,000, NIIT 2,280", () => {
    // wages 330,000 + interest 40,000 + dividends 20,000 = 390,000
    const { get } = nii(330_000);
    expect([get("f1040.11a"), get("f8960.8"), get("f8960.9b"), get("f8960.nii"), get("f8960.15"), get("f8960.16"), get("f8960.niit"), get("sch2.12")]).toEqual([390_000, 60_000, 0, 60_000, 140_000, 60_000, 2_280, 2_280]);
  });

  it("itemizing: the state income tax on Schedule A (5a) is allocated by line 8 over AGI: 10,000 x 60,000 / 390,000 = 1,538.46 -> 1,538 (line 9b)", () => {
    const { get } = nii(330_000, (x) => {
      x.income.w2s[0]!.ctWithheldCents = 1_000_000;
      x.deductions.mortgages = [{ docId: "m", lender: "L", basis: "doc_verified", legacyFormat: false, refs: [], interestCents: 3_000_000, principalCents: 40_000_000, originationDate: "2020-01-01", mortgageInsuranceCents: null, pointsCents: null, box10Cents: null, propertyAddress: "27 Old Barry Rd" }];
    });
    // itemized = 10,000 + 30,000 = 40,000 > 31,500
    expect([get("scha.17"), get("f8960.9b"), get("f8960.11"), get("f8960.nii")]).toEqual([40_000, 1_538, 1_538, 58_462]);
    expect(get("f8960.niit")).toBe(2_222); // 58,462 x 3.8% = 2,221.56
  });

  it("the threshold: at AGI 250,000 line 15 is 0 and the tax 0; at 250,001 line 15 is 1 and 1 x 3.8% rounds to 0", () => {
    // wages + 60,000 of investment income = AGI
    const at = nii(190_000);
    expect([at.get("f1040.11a"), at.get("f8960.15"), at.get("f8960.niit")]).toEqual([250_000, 0, 0]);
    const over = nii(190_001);
    expect([over.get("f1040.11a"), over.get("f8960.15"), over.get("f8960.16"), over.get("f8960.niit")]).toEqual([250_001, 1, 1, 0]);
  });

  it("net capital loss limited to 3,000: investment income 1,000 + 500 - 3,000 = -1,500 -> line 12 is 0 and no tax", () => {
    const f = household((x) => {
      x.income.w2s = [wage("a", ERIC_ID, 400_000)];
      x.income.interest = [interest({ docId: "i", box1Cents: 100_000 })];
      x.income.noInterestConfirmed = { value: null, basis: null, refs: [] };
      x.income.dividends = [dividend({ docId: "d", box1aCents: 50_000, box1bCents: 0 })];
      x.income.noDividendsConfirmed = { value: null, basis: null, refs: [] };
      x.income.brokerSales = [brokerDoc("D", 100_000, 2_000_000)];
      x.returnAnswers.capitalGains.carryoverShortCents = owner(0);
    });
    const { get } = ledgerOf(f);
    expect([get("schd.16"), get("schd.21"), get("f1040.7a"), get("f8960.5a"), get("f8960.8"), get("f8960.nii"), get("f8960.niit")]).toEqual([-19_000, 3_000, -3_000, -3_000, -1_500, 0, 0]);
  });
});

function brokerDoc(box: BrokerBox, proceedsCents: number, costCents: number, washCents = 0, docId = "b1") {
  return {
    docId,
    payer: "Broker",
    basis: "doc_verified" as const,
    legacyFormat: false,
    refs: [],
    summaryRead: true,
    signalled1099B: true,
    rows: [{ form: "1099-B" as const, box, proceedsCents, costCents, accruedMarketDiscountCents: 0, washSaleLossDisallowedCents: washCents, gainLossCents: null }],
    sec1256AggregateCents: 0,
    forms1099DaPresent: false,
  };
}

describe("Schedule D and Form 8949 totals", () => {
  it("hand-worked: box A 10,000.50 / 8,000.25 direct (line 1a), box E 5,000.00 / 6,000.40, short-term carryover 500", () => {
    // 1a: d = 10,001 (10,000.50 rounds up), e = 8,000, h = 2,000.25 -> 2,000.  line 6 = 500.  line 7 = 2,000.25 - 500 = 1,500.25 -> 1,500.
    // 9: d 5,000, e 6,000, g 0, h = -1,000.40 -> -1,000.  line 15 = -1,000.40 -> -1,000.  line 16 = 1,500.25 - 1,000.40 = 499.85 -> 500.
    const f = household((x) => {
      x.income.w2s = [wage("a", ERIC_ID, 100_000)];
      x.income.brokerSales = [brokerDoc("A", 1_000_050, 800_025), brokerDoc("E", 500_000, 600_040, 0, "b2")];
      x.returnAnswers.capitalGains.carryoverShortCents = owner(50_000);
    });
    const { get } = ledgerOf(f);
    expect([get("schd.1a.d"), get("schd.1a.e"), get("schd.1a.h")]).toEqual([10_001, 8_000, 2_000]);
    expect([get("schd.9.d"), get("schd.9.e"), get("schd.9.g"), get("schd.9.h")]).toEqual([5_000, 6_000, 0, -1_000]);
    expect([get("schd.6"), get("schd.7"), get("schd.15"), get("schd.16"), get("f1040.7a")]).toEqual([500, 1_500, -1_000, 500, 500]);
  });

  it("a wash sale in box B: column (g) 300 is added back, so the gain is -300 + 0 = -300 (proceeds 5,000, cost 5,300 with a 300 disallowed loss reports 0)", () => {
    // 5,000.00 - 5,600.00 + 300.00 = -300.00
    const f = household((x) => {
      x.income.w2s = [wage("a", ERIC_ID, 100_000)];
      x.income.brokerSales = [brokerDoc("B", 500_000, 560_000, 30_000)];
    });
    const { get } = ledgerOf(f);
    expect([get("schd.2.d"), get("schd.2.e"), get("schd.2.g"), get("schd.2.h"), get("schd.7"), get("schd.16"), get("schd.21"), get("f1040.7a")]).toEqual([5_000, 5_600, 300, -300, -300, -300, 300, -300]);
  });

  it("a net loss is limited to 3,000: line 21 = 3,000 and 1040 line 7a = -3,000 (hand-worked: 1,000 - 20,000 = -19,000)", () => {
    const f = household((x) => {
      x.income.w2s = [wage("a", ERIC_ID, 100_000)];
      x.income.brokerSales = [brokerDoc("D", 100_000, 2_000_000)];
    });
    const { get } = ledgerOf(f);
    expect([get("schd.16"), get("schd.21"), get("f1040.7a")]).toEqual([-19_000, 3_000, -3_000]);
  });

  it("capital gain distributions only: Schedule D is not required and line 7a is box 2a (Exception 1)", () => {
    const f = household((x) => {
      x.income.w2s = [wage("a", ERIC_ID, 100_000)];
      x.income.dividends = [dividend({ docId: "d", box1aCents: 300_000, box1bCents: 100_000, box2aCents: 150_049 })];
      x.income.noDividendsConfirmed = { value: null, basis: null, refs: [] };
    });
    const { get } = ledgerOf(f);
    expect(get("f1040.7a")).toBe(1_500);
    expect(get("schd.16")).toBeNull();
  });

  it("long-term carryover and capital gain distributions net on line 15: 800 distributions - 300 carryover = 500", () => {
    const f = household((x) => {
      x.income.w2s = [wage("a", ERIC_ID, 100_000)];
      x.income.dividends = [dividend({ docId: "d", box1aCents: 300_000, box1bCents: 100_000, box2aCents: 80_000 })];
      x.income.noDividendsConfirmed = { value: null, basis: null, refs: [] };
      x.returnAnswers.capitalGains.carryoverLongCents = owner(30_000);
    });
    const { get } = ledgerOf(f);
    expect([get("schd.13"), get("schd.14"), get("schd.15"), get("schd.16"), get("f1040.7a")]).toEqual([800, 300, 500, 500, 500]);
  });
});

describe("Schedule A: SALT cap, mortgage, property tax", () => {
  const salt = (wages: number, propertyDollars: number) =>
    ledgerOf(
      household((x) => {
        x.income.w2s = [wage("a", ERIC_ID, wages, { ctWithheldCents: 1_500_000 })];
        x.deductions.propertyTaxBills = [bill({ docId: "p", address: "27 Old Barry Rd", paidInYearCents: propertyDollars * 100, kind: "primary_residence" })];
      })
    );

  it("cap = 40,000 - 30% of (MAGI - 500,000), never below 10,000 (State and Local Tax Deduction Worksheet)", () => {
    // 5d = 15,000 (withholding) + 30,000 = 45,000 in every case
    expect(salt(500_000, 30_000).get("scha.5e")).toBe(40_000);
    expect(salt(500_001, 30_000).get("scha.5e")).toBe(40_000); // 30% of 1 = 0.3 -> 0
    expect(salt(510_000, 30_000).get("scha.5e")).toBe(37_000);
    expect(salt(566_666, 30_000).get("scha.5e")).toBe(20_000); // 30% x 66,666 = 19,999.8 -> 20,000
    expect(salt(600_000, 30_000).get("scha.5e")).toBe(10_000);
    expect(salt(900_000, 30_000).get("scha.5e")).toBe(10_000);
  });

  it("a total at or under 10,000 is entered as is, whatever the AGI", () => {
    const f = household((x) => { x.income.w2s = [wage("a", ERIC_ID, 900_000, { ctWithheldCents: 500_000 })]; });
    expect(ledgerOf(f).get("scha.5e")).toBe(5_000);
  });

  it("mortgage interest and 1098 points are line 8a; mortgage insurance premiums (box 5) are not deductible; each tax is rounded on its own line", () => {
    const f = household((x) => {
      x.income.w2s = [wage("a", ERIC_ID, 200_000)];
      x.deductions.mortgages = [{ docId: "m", lender: "L", basis: "doc_verified", legacyFormat: false, refs: [], interestCents: 1_234_567, principalCents: 30_000_000, originationDate: "2020-01-01", mortgageInsuranceCents: 99_900, pointsCents: 100_040, box10Cents: null, propertyAddress: "27 Old Barry Rd" }];
      x.deductions.propertyTaxBills = [
        bill({ docId: "p", address: "27 Old Barry Rd", paidInYearCents: 500_049, kind: "primary_residence" }),
        bill({ docId: "v", address: null, paidInYearCents: 10_050, kind: "motor_vehicle", taxType: "motor_vehicle" }),
      ];
    });
    const { get } = ledgerOf(f);
    expect([get("scha.8a"), get("scha.5b"), get("scha.5c")]).toEqual([13_346, 5_000, 101]); // 12,345.67 + 1,000.40 = 13,346.07
  });

  it("decision X5: the other-real-estate bill is a Schedule A tax only when 'schedule_a' is the recorded choice", () => {
    const f = () =>
      household((x) => {
        x.income.w2s = [wage("a", ERIC_ID, 200_000)];
        x.deductions.propertyTaxBills = [bill({ docId: "p", address: "27 Old Barry Rd", paidInYearCents: 400_000, kind: "primary_residence" }), bill({ docId: "a", address: "56 Arbor Rd", paidInYearCents: 700_000, kind: "other_real_estate" })];
      });
    expect(ledgerOf(f()).get("scha.5b")).toBe(11_000);
    expect(ledgerOf(f(), { arborRoadPropertyTax: { chosen: "capitalize", by: "t", at: "2026-10-01T00:00:00.000Z" } }).get("scha.5b")).toBe(4_000);
  });
});

describe("Schedule 1-A (tips, overtime, car loan interest, seniors) and Form 1040 line 13b", () => {
  const withMagi = (magi: number, mod: (f: Ty2025Facts) => void) =>
    ledgerOf(
      household((x) => {
        x.income.w2s = [wage("a", ERIC_ID, magi)];
        x.returnAnswers.magiExclusionsNone = owner(true);
        for (const p of x.returnAnswers.people) p.validSsn = owner(true);
        mod(x);
      })
    );
  const evaTips = (cents: number) => (x: Ty2025Facts) => {
    const eva = x.returnAnswers.people.find((p) => p.userId === EVA_ID)!;
    eva.tipsChoice = owner("some");
    eva.tipsCents = owner(cents);
  };

  it("golden: tips 4,545.80 + overtime 2,408 at MAGI 270,980 = 4,546 + 2,408 = 6,954", () => {
    const { get } = withMagi(270_980, (x) => {
      evaTips(454_580)(x);
      const eva = x.returnAnswers.people.find((p) => p.userId === EVA_ID)!;
      eva.overtimeChoice = owner("premium");
      eva.overtimeCents = owner(240_800);
    });
    expect([get("sch1a.3"), get("sch1a.4c"), get("sch1a.7"), get("sch1a.13"), get("sch1a.14c"), get("sch1a.21"), get("sch1a.38"), get("f1040.13b")]).toEqual([270_980, 4_546, 4_546, 4_546, 2_408, 2_408, 6_954, 6_954]);
  });

  it("tips phase-out: nothing at MAGI 300,000; 301,000 reduces by 100 per $1,000 (line 11 rounds DOWN)", () => {
    const at = withMagi(300_000, evaTips(500_000));
    expect([at.get("sch1a.10"), at.get("sch1a.13")]).toEqual([null, 5_000]); // lines 10-12 are skipped
    const over1 = withMagi(300_001, evaTips(500_000));
    expect([over1.get("sch1a.10"), over1.get("sch1a.11"), over1.get("sch1a.12"), over1.get("sch1a.13")]).toEqual([1, 0, 0, 5_000]);
    const over = withMagi(301_000, evaTips(500_000));
    expect([over.get("sch1a.10"), over.get("sch1a.11"), over.get("sch1a.12"), over.get("sch1a.13")]).toEqual([1_000, 1, 100, 4_900]);
    const gone = withMagi(350_000, evaTips(500_000));
    expect(gone.get("sch1a.13")).toBe(0); // 50 x 100 = 5,000 reduction
  });

  it("the tips maximum is 25,000 for the whole return; overtime 25,000 married filing jointly ('total' overtime is divided by three)", () => {
    const tips = withMagi(100_000, evaTips(3_500_000));
    expect([tips.get("sch1a.6"), tips.get("sch1a.7"), tips.get("sch1a.13")]).toEqual([35_000, 25_000, 25_000]);
    const ot = withMagi(100_000, (x) => {
      const eva = x.returnAnswers.people.find((p) => p.userId === EVA_ID)!;
      eva.overtimeChoice = owner("total");
      eva.overtimeCents = owner(10_000_000); // 100,000 total -> 33,333.33 premium
    });
    expect([ot.get("sch1a.14c"), ot.get("sch1a.15"), ot.get("sch1a.21")]).toEqual([33_333, 25_000, 25_000]);
  });

  it("car loan interest: the phase-out step rounds UP ($200 per $1,000 over 200,000): MAGI 200,001 -> 200 off; 201,000 -> 200; 201,001 -> 400", () => {
    const loan = (x: Ty2025Facts) => {
      x.returnAnswers.carLoan = { choice: owner("some"), qualifies: owner(true), interestPaidCents: owner(900_000), deductedElsewhereCents: owner(0) };
    };
    expect(withMagi(200_000, loan).get("sch1a.30")).toBe(9_000);
    const a = withMagi(200_001, loan);
    expect([a.get("sch1a.27"), a.get("sch1a.28"), a.get("sch1a.29"), a.get("sch1a.30")]).toEqual([1, 1, 200, 8_800]);
    expect(withMagi(201_000, loan).get("sch1a.30")).toBe(8_800);
    expect(withMagi(201_001, loan).get("sch1a.30")).toBe(8_600);
    // the 10,000 maximum
    const big = (x: Ty2025Facts) => {
      x.returnAnswers.carLoan = { choice: owner("some"), qualifies: owner(true), interestPaidCents: owner(1_500_000), deductedElsewhereCents: owner(0) };
    };
    expect(withMagi(100_000, big).get("sch1a.24")).toBe(10_000);
  });

  it("seniors: 6,000 each, less 6% of MAGI over 150,000: 200,000 -> 3,000 each; 250,000 -> 0; a missing valid SSN removes the person's amount", () => {
    const seniors = (n: 1 | 2, ssn = true) => (x: Ty2025Facts) => {
      x.returnAnswers.people[0]!.bornBefore1961 = owner(true);
      x.returnAnswers.people[0]!.validSsn = owner(ssn);
      x.returnAnswers.people[1]!.bornBefore1961 = owner(n === 2);
    };
    expect(withMagi(150_000, seniors(2)).get("sch1a.37")).toBe(12_000);
    const mid = withMagi(200_000, seniors(1));
    expect([mid.get("sch1a.35"), mid.get("sch1a.37")]).toEqual([3_000, 3_000]);
    expect(withMagi(200_000, seniors(2)).get("sch1a.37")).toBe(6_000);
    expect(withMagi(250_000, seniors(2)).get("sch1a.37")).toBe(0);
    expect(withMagi(150_000, seniors(1, false)).get("sch1a.37")).toBe(0);
  });
});

describe("Form 8995 (qualified business income deduction)", () => {
  it("20% of (profit 50,000 - half of SE tax 670 = 49,330) = 9,866, limited by 20% of taxable income less net capital gain", () => {
    const f = household((x) => {
      x.income.w2s = [wage("e", EVA_ID, 120_000)];
      x.income.scheduleC.glLines = [gl("4000", "Services", "revenue", 5_000_000)];
    });
    const { get } = ledgerOf(f);
    // SE: 4a = 46,175; Eva's wages do not count (the owner is Eric): 10 = 5,726; 11 = 1,339 -> 7,065; half = 3,533 -> QBI = 50,000 - 3,533 = 46,467 -> 9,293
    expect([get("sch1.15"), get("f8995.2"), get("f8995.5"), get("f8995.10")]).toEqual([3_533, 46_467, 9_293, 9_293]);
    // taxable income before the deduction: 11a 166,467 - 31,500 = 134,967; line 14 = 20% x 134,967 = 26,993 -> the smaller is line 10
    expect([get("f8995.11"), get("f8995.12"), get("f8995.13"), get("f8995.14"), get("f8995.15"), get("f1040.13a")]).toEqual([134_967, 0, 134_967, 26_993, 9_293, 9_293]);
  });

  it("line 11 is Form 1040 line 11a less lines 12e AND 13b (the 2025 Form 8995 instructions)", () => {
    const f = household((x) => {
      x.income.w2s = [wage("e", EVA_ID, 100_000)];
      x.income.scheduleC.glLines = [gl("4000", "Services", "revenue", 3_000_000)];
      x.adjustments.sch1a = owner(500_000); // a stated 5,000 Schedule 1-A total
    });
    const { get } = ledgerOf(f);
    // 11a = 100,000 + 30,000 - SE half; compute: 4a = 27,705; 10 = 3,435.42 -> 3,435; 11 = 803.4 -> 803; 12 = 4,238; 13 = 2,119
    expect(get("sch1.15")).toBe(2_119);
    expect(get("f1040.11a")).toBe(127_881);
    expect(get("f8995.11")).toBe(127_881 - 31_500 - 5_000);
  });

  it("above the $394,600 threshold Form 8995-A is needed and the oracle does not recompute it", () => {
    const f = household((x) => {
      x.income.w2s = [wage("e", EVA_ID, 500_000)];
      x.income.scheduleC.glLines = [gl("4000", "Services", "revenue", 5_000_000)];
    });
    const { get, L } = ledgerOf(f);
    expect(get("f1040.13a")).toBeNull();
    expect(L.abstentions.some((a) => a.area === "Form 8995")).toBe(true);
  });
});

describe("Schedule C: meals, mileage, home office", () => {
  const sched = (mod: (f: Ty2025Facts) => void) => ledgerOf(household((x) => { x.income.w2s = [wage("a", ERIC_ID, 100_000)]; mod(x); }));

  it("meals: 50% of the booked amount once on the cent-accurate total: (1,234.57 + 1,000.01) x 50% = 1,117.29 -> 1,117", () => {
    const { get } = sched((x) => {
      x.income.scheduleC.glLines = [gl("4000", "Services", "revenue", 6_000_000), gl("5900", "Meals", "expense", 123_457), gl("5901", "Meals:Travel meals", "expense", 100_001)];
    });
    expect([get("schc.24b"), get("schc.28"), get("schc.31")]).toEqual([1_117, 1_117, 58_883]);
  });

  it("standard mileage: miles x the rate captured with each entry: 1,000 x 0.700 + 333 x 0.67 = 700 + 223.11 = 923.11 -> 923", () => {
    const { get } = sched((x) => {
      x.income.scheduleC.glLines = [gl("4000", "Services", "revenue", 6_000_000)];
      x.income.scheduleC.mileage = [
        { miles: 1000, ratePerMile: "0.700", dateIso: "2025-03-01" },
        { miles: 333, ratePerMile: "0.67", dateIso: "2025-04-01" },
      ];
      x.income.scheduleC.mileageNoneConfirmed = owner(false);
    });
    expect(get("schc.9")).toBe(923);
  });

  it("simplified home office: $5 x square feet up to 300, limited to the Schedule C line 29 profit", () => {
    const base = (sqft: number, revenue: number) =>
      sched((x) => {
        x.income.scheduleC.glLines = [gl("4000", "Services", "revenue", revenue)];
        x.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive");
        x.income.scheduleC.homeOfficeSqft = owner(sqft);
      });
    expect(base(200, 6_000_000).get("schc.30")).toBe(1_000);
    expect(base(450, 6_000_000).get("schc.30")).toBe(1_500); // 300 x $5
    expect(base(300, 90_000).get("schc.30")).toBe(900); // limited to the 900 of profit
    expect(base(300, 0).get("schc.30")).toBe(0);
  });

  it("interest earned on the business bank account is routed to Form 1040 line 2b, not Schedule C", () => {
    const { get } = sched((x) => {
      x.income.scheduleC.glLines = [gl("4000", "Services", "revenue", 6_000_000), gl("7000", "Other income:Interest earned", "revenue", 4_049)];
    });
    expect([get("schc.7"), get("f1040.2b")]).toEqual([60_000, 40]);
  });
});

describe("Schedule 3 line 11: excess Social Security tax withheld", () => {
  it("two employers: 6,200 + 6,200 = 12,400 withheld against a 10,918.20 maximum -> 1,481.80 -> 1,482; one employer gets no credit", () => {
    const two = ledgerOf(household((x) => { x.income.w2s = [wage("a", ERIC_ID, 100_000), wage("bb", ERIC_ID, 100_000)]; }));
    expect(two.get("sch3.11")).toBe(1_482);
    expect(two.get("f1040.31")).toBe(1_482);
    const one = ledgerOf(household((x) => { x.income.w2s = [wage("a", ERIC_ID, 300_000)]; }));
    expect(one.get("sch3.11")).toBe(0);
  });
});

describe("Connecticut: Schedule 3 property tax credit and lines 18-26", () => {
  const ct = (agiWages: number, bills: Parameters<typeof bill>[0][]) =>
    ledgerOf(
      household((x) => {
        x.income.w2s = [wage("a", ERIC_ID, agiWages, { ctWithheldCents: 10_050 }), wage("b", EVA_ID, 0, { ctWithheldCents: 10_050 })];
        x.deductions.propertyTaxBills = bills.map((b) => bill(b));
      })
    );

  it("line 18 is the sum of one whole-dollar amount per W-2: 100.50 + 100.50 = 101 + 101 = 202 (not 201)", () => {
    expect(ct(200_000, []).get("ct1040.18")).toBe(202);
  });

  it("CT AGI 110,000: decimal .60; bills 4,000.49 (home) + 150 (car) = 4,150 -> line 65 = 300, 67 = 180, credit 120", () => {
    const { get } = ct(110_000, [
      { docId: "h", address: "27 Old Barry Rd", paidInYearCents: 400_049, kind: "primary_residence" },
      { docId: "v", address: null, paidInYearCents: 15_000, kind: "motor_vehicle", taxType: "motor_vehicle" },
    ]);
    expect([get("ct1040.ctAgi"), get("ct1040.s3.63"), get("ct1040.s3.65"), get("ct1040.s3.67"), get("ct1040.11")]).toEqual([110_000, 4_150, 300, 180, 120]);
    expect(get("ct1040.12")! + 120).toBe(get("ct1040.10")!);
  });

  it("the credit rounds in form order (Schedule 3): 65 = 10, decimal .75 -> 67 = round(7.5) = 8, credit = 2 (the CT-1040 instructions' line 67 'multiply line 65 by line 66')", () => {
    const { get } = ct(115_000, [{ docId: "v", address: null, paidInYearCents: 1_000, kind: "motor_vehicle", taxType: "motor_vehicle" }]);
    expect([get("ct1040.s3.65"), get("ct1040.s3.67"), get("ct1040.11")]).toEqual([10, 8, 2]);
  });

  it("at the top of the table: CT AGI 130,500 keeps 30 of a 300 credit (decimal .90); 130,501 gets none (decimal 1.00)", () => {
    const bills = [{ docId: "h", address: "27 Old Barry Rd", paidInYearCents: 900_000, kind: "primary_residence" as const }];
    expect(ct(130_500, bills).get("ct1040.11")).toBe(30);
    expect(ct(130_501, bills).get("ct1040.11")).toBe(0);
  });

  it("only two motor vehicles count (the larger two)", () => {
    const { get } = ct(110_000, [
      { docId: "v1", address: null, paidInYearCents: 5_000, kind: "motor_vehicle", taxType: "motor_vehicle" },
      { docId: "v2", address: null, paidInYearCents: 9_000, kind: "motor_vehicle", taxType: "motor_vehicle" },
      { docId: "v3", address: null, paidInYearCents: 7_000, kind: "motor_vehicle", taxType: "motor_vehicle" },
    ]);
    expect(get("ct1040.s3.63")).toBe(160); // 90 + 70
  });

  it("Connecticut AGI between 24,001 and 102,000 is not recomputed (the DRS Tax Tables are not in the source pack)", () => {
    const { get, L } = ct(60_000, []);
    expect(get("ct1040.6")).toBeNull();
    expect(L.abstentions.some((a) => a.area === "CT-1040 line 6")).toBe(true);
  });

  it("at or below 24,000 the tax is 0 (CT-1040 instructions, line 6)", () => {
    expect(ct(20_000, []).get("ct1040.6")).toBe(0);
  });
});
