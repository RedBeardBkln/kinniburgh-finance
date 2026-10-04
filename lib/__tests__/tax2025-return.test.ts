import { describe, expect, it } from "vitest";
import { computeTy2025Return, duplicateEmissions, TY2025_ENGINE_VERSION } from "@/lib/tax2025/return";
import { LINE_CATALOG, LINE_KEYS, NONE_GROUP_IDS, hasAmount, missingLeaf, type LineKey, type Ty2025Return } from "@/lib/tax2025/types";
import { ty2025FactsSchema } from "@/lib/tax2025/facts";
import { ERIC_ID, bill, emptyFacts, fullFacts, gl, owner, w2 } from "@/lib/__tests__/tax2025-fixtures";

function amt(r: Ty2025Return, key: LineKey): number | null {
  const l = r.lines[key];
  if (!l) throw new Error(`no line ${key}`);
  return l.amount;
}
function st(r: Ty2025Return, key: LineKey): string | undefined {
  return r.lines[key]?.status;
}

// Hand-computed golden return for fullFacts() (all inputs answered; every "none" group stated):
//   W-2 wages 90,000 + 40,000 = 130,000; interest 500; dividends 1,000 (qualified 800); Schedule C net 60,000 - 10,000 = 50,000
//   SE (Eric, W-2 SS wages 90,000): 4a 46,175; line 9 86,100; line 10 = 46,175 x .124 = 5,725.70 -> 5,726; line 11 = 1,339.075 -> 1,339;
//     line 12 = 7,065; line 13 = 3,532.5 -> 3,533
//   total income 130,000 + 500 + 1,000 + 50,000 = 181,500; AGI = 181,500 - 3,533 = 177,967
//   Schedule A: SALT 4,200 + 6,000 = 10,200; interest 18,882.69 -> 18,883; itemized 29,083 < 31,500 -> standard 31,500
//   QBI 20% x (50,000 - 3,533) = 9,293.40 -> 9,293 (limit 20% x (146,467 - 800) = 29,133 is larger)
//   taxable income 177,967 - 31,500 - 9,293 = 137,174
//   QDCG worksheet: line 22 tax on 136,374 = 19,830.28; + 15% x 800 = 120 -> 19,950.28 -> 19,950 < tax on 137,174 (20,006)
//   total tax 19,950 + 7,065 = 27,015; payments 15,000 -> owe 12,015
//   CT: AGI 177,967; 4,000 + 5.5% x 77,967 = 8,288.185; Table C 500; -> 8,788; withholding 4,200 -> owe 4,588
describe("computeTy2025Return: golden return for the all-answered fixture", () => {
  const ret = computeTy2025Return(fullFacts());

  it("headline numbers", () => {
    expect(ret.headline.complete).toBe(true);
    expect(ret.headline.provisional).toBeNull();
    expect(ret.headline.federal.agi.amount).toBe(177967);
    expect(ret.headline.federal.taxableIncome.amount).toBe(137174);
    expect(ret.headline.federal.totalTax.amount).toBe(27015);
    expect(ret.headline.federal.totalPayments.amount).toBe(15000);
    expect(ret.headline.federal.balance.amount).toBe(12015);
    expect(ret.headline.connecticut.ctAgi.amount).toBe(177967);
    expect(ret.headline.connecticut.tax.amount).toBe(8788);
    expect(ret.headline.connecticut.totalPayments.amount).toBe(4200);
    expect(ret.headline.connecticut.balance.amount).toBe(4588);
  });

  it("line by line", () => {
    expect(amt(ret, "f1040.1a")).toBe(130000);
    expect(amt(ret, "f1040.2b")).toBe(500);
    expect(amt(ret, "f1040.3a")).toBe(800);
    expect(amt(ret, "f1040.3b")).toBe(1000);
    expect(amt(ret, "schc.31")).toBe(50000);
    expect(amt(ret, "sch1.3")).toBe(50000);
    expect(amt(ret, "se.4a")).toBe(46175);
    expect(amt(ret, "se.9")).toBe(86100);
    expect(amt(ret, "se.10")).toBe(5726);
    expect(amt(ret, "se.11")).toBe(1339);
    expect(amt(ret, "se.12")).toBe(7065);
    expect(amt(ret, "sch1.15")).toBe(3533);
    expect(amt(ret, "f1040.9")).toBe(181500);
    expect(amt(ret, "f1040.10")).toBe(3533);
    expect(amt(ret, "f1040.11a")).toBe(177967);
    expect(amt(ret, "scha.17")).toBe(29083);
    expect(amt(ret, "f1040.12e")).toBe(31500);
    expect(amt(ret, "f1040.13a")).toBe(9293);
    expect(amt(ret, "f1040.14")).toBe(40793);
    expect(amt(ret, "f1040.15")).toBe(137174);
    expect(amt(ret, "f1040.16")).toBe(19950);
    expect(amt(ret, "qdcg.25")).toBe(19950);
    expect(amt(ret, "sch2.2")).toBe(0);
    expect(amt(ret, "sch2.4")).toBe(7065);
    expect(amt(ret, "sch2.21")).toBe(7065);
    expect(amt(ret, "f1040.24")).toBe(27015);
    expect(amt(ret, "f1040.25a")).toBe(15000);
    expect(amt(ret, "f1040.25d")).toBe(15000);
    expect(amt(ret, "f1040.33")).toBe(15000);
    expect(amt(ret, "f1040.37")).toBe(12015);
    expect(amt(ret, "f1040.34")).toBe(0);
    expect(amt(ret, "ct1040.6")).toBe(8788);
    expect(amt(ret, "ct1040.11")).toBe(0);
  });

  it("Form 8959 and NIIT are not required at this income (explicit not_applicable / computed zero, with reasons)", () => {
    expect(st(ret, "sch2.11")).toBe("not_applicable");
    expect(st(ret, "f1040.25c")).toBe("computed");
    expect(amt(ret, "f1040.25c")).toBe(0);
    expect(amt(ret, "sch2.12")).toBe(0);
    expect(ret.lines["sch2.11"]?.reason).toContain("not required");
    expect(ret.formsRequired.f8959?.required).toBe(false);
  });

  it("forms required (C7)", () => {
    expect(ret.formsRequired).toMatchObject({
      f1040: { required: true },
      schc: { required: true },
      schse: { required: true },
      f8995: { required: true },
      scha: { required: false },
      schb: { required: false },
      f6251: { required: false },
      f8960: { required: false },
      f8283: { required: false },
      ct1040: { required: true },
    });
  });

  it("carries the engine version, citations, Schedule C detail and the X1/X3/X5-free decision list", () => {
    expect(ret.engineVersion).toBe(TY2025_ENGINE_VERSION);
    expect(ret.citations).toContain("SE_WAGE_BASE");
    expect(ret.scheduleC?.lines.length).toBeGreaterThan(0);
    // home office "no" -> no X1 decision
    expect(ret.decisions).toEqual([]);
  });
});

describe("computeTy2025Return: coverage and honesty invariants (acceptance 1, 12)", () => {
  const variants: [string, Ty2025Return][] = [
    ["empty facts", computeTy2025Return(emptyFacts())],
    ["full facts", computeTy2025Return(fullFacts())],
    [
      "full facts, no CT estimates, no stated none for other income",
      (() => {
        const f = fullFacts();
        f.payments.ctEstimates = missingLeaf();
        delete f.statedNone.other_income;
        return computeTy2025Return(f);
      })(),
    ],
  ];

  for (const [name, ret] of variants) {
    describe(name, () => {
      it("has a line for EVERY catalog key (no key is absent)", () => {
        for (const key of LINE_KEYS) expect(ret.lines[key], key).toBeDefined();
        expect(Object.keys(ret.lines).length).toBe(LINE_CATALOG.length);
      });

      it("no line is silently 0: amount is present exactly when the status carries one, and a not_applicable zero has a reason", () => {
        for (const key of LINE_KEYS) {
          const l = ret.lines[key]!;
          if (hasAmount(l.status)) {
            expect(l.amount, `${key} amount`).not.toBeNull();
            expect(Number.isInteger(l.amount), `${key} integer`).toBe(true);
          } else {
            expect(l.amount, `${key} must have no amount`).toBeNull();
            expect(l.exact).toBeNull();
            expect(l.reason, `${key} blocked line needs a reason`).toBeTruthy();
          }
          if (l.status === "not_applicable") expect(l.reason, `${key} not_applicable reason`).toBeTruthy();
          expect(["computed", "not_applicable", "missing_input", "needs_cpa_rule_unverified", "needs_cpa_judgment", "not_yet_computed"]).toContain(l.status);
        }
      });

      it("every rule line a result emits is registered exactly once (no duplicate owners)", () => {
        expect(duplicateEmissions(name === "empty facts" ? emptyFacts() : fullFacts())).toEqual([]);
      });

      it("never throws and always reports blocking counts consistent with the open items", () => {
        expect(ret.headline.blockingItemCount).toBe(ret.openItems.filter((o) => o.severity === "blocking").length);
      });
    });
  }
});

describe("computeTy2025Return: incomplete facts", () => {
  it("empty facts: nothing is computed that depends on a missing input; a provisional estimate lists what it assumed", () => {
    const ret = computeTy2025Return(emptyFacts());
    expect(ret.headline.complete).toBe(false);
    expect(st(ret, "f1040.1a")).toBe("missing_input");
    expect(st(ret, "f1040.11a")).not.toBe("computed");
    expect(amt(ret, "f1040.24")).toBeNull();
    expect(ret.headline.federal.totalTax.amount).toBeNull();
    expect(ret.headline.blockingItemCount).toBeGreaterThan(5);
    const prov = ret.headline.provisional;
    expect(prov).not.toBeNull();
    expect(prov!.assumedFacts.length).toBeGreaterThan(3);
    expect(prov!.note).toContain("NOT a computed return");
    expect(prov!.assumedZeroLines.length).toBeGreaterThan(0);
  });

  it("D2 / acceptance 9: unknown CT estimates block Schedule A and CT payments but never reach the federal side", () => {
    const f = fullFacts();
    f.payments.ctEstimates = missingLeaf();
    const ret = computeTy2025Return(f);
    expect(st(ret, "scha.5a")).toBe("missing_input");
    expect(st(ret, "f1040.12e")).toBe("missing_input");
    expect(st(ret, "f1040.15")).not.toBe("computed");
    expect(st(ret, "ct1040.19")).toBe("missing_input");
    // federal estimated payments are separate and still fine
    expect(st(ret, "f1040.26")).toBe("computed");
    expect(st(ret, "f1040.11a")).toBe("computed");
    const prov = ret.headline.provisional!;
    expect(prov.assumedFacts.join(" ")).toContain("CT estimated payments");
    expect(prov.agi).toBe(177967);
    expect(prov.taxableIncome).toBe(137174);
    expect(prov.totalTax).toBe(27015);
  });

  it("the legacy combined estimates answer is never used for federal payments", () => {
    const f = fullFacts();
    f.payments.federalEstimates = missingLeaf();
    f.payments.ctEstimates = missingLeaf();
    f.payments.combinedEstimatesAnswer = owner(1_000_000);
    const ret = computeTy2025Return(f);
    expect(st(ret, "f1040.26")).toBe("missing_input");
    expect(ret.headline.provisional!.totalPayments).toBe(15000);
  });

  it("a missing 'none' statement blocks the lines that depend on it and is listed as an open item", () => {
    const f = fullFacts();
    delete f.statedNone.se_other;
    const ret = computeTy2025Return(f);
    expect(st(ret, "se.12")).toBe("not_yet_computed");
    expect(st(ret, "sch2.4")).toBe("not_yet_computed");
    expect(ret.lines["se.12"]?.reason).toContain("statement");
    expect(st(ret, "se.1a")).toBe("not_yet_computed");
    expect(st(ret, "f1040.11a")).not.toBe("computed");
    expect(ret.openItems.some((o) => o.id === "none:se_other" && o.severity === "blocking")).toBe(true);
    // the provisional estimate still shows the numbers
    expect(ret.headline.provisional!.agi).toBe(177967);
  });

  it("an owner statement that a group does NOT hold makes its lines needs_cpa_judgment", () => {
    const f = fullFacts();
    f.statedNone.other_income = owner(false);
    const ret = computeTy2025Return(f);
    expect(st(ret, "sch1.8b")).toBe("needs_cpa_judgment");
    expect(st(ret, "sch1.10")).toBe("needs_cpa_judgment");
  });

  it("every catalog group line is not_applicable (with the statement as reason) when the group is stated", () => {
    const ret = computeTy2025Return(fullFacts());
    for (const meta of LINE_CATALOG) {
      if (!meta.group) continue;
      expect(ret.lines[meta.key]?.status, meta.key).toBe("not_applicable");
      expect(ret.lines[meta.key]?.reason, meta.key).toContain("Stated");
    }
    expect(NONE_GROUP_IDS.length).toBeGreaterThan(10);
  });

  it("the Phase 1b lines are missing_input (never 0) until the owner answers the Return completeness questions or an amount is stated", () => {
    // Phase 1a had these as not_yet_computed; since Phase 1b the rules compute them and an unanswered input is missing_input.
    const f = fullFacts();
    f.adjustments.hsa = missingLeaf();
    f.adjustments.ira = missingLeaf();
    f.adjustments.sch1a = missingLeaf();
    f.credits.savers = missingLeaf();
    const ret = computeTy2025Return(f);
    for (const k of ["sch1.13", "sch1.20", "f1040.13b", "sch3.4"] as const) expect(st(ret, k), k).toBe("missing_input");
    expect(st(ret, "f1040.11a")).not.toBe("computed");
    expect(st(ret, "f1040.38")).toBe("missing_input");
    expect(st(ret, "f1040.35a")).toBe("not_yet_computed");
  });

  it("SE retirement / SE health insurance not stated -> needs_cpa_rule_unverified (eligibility rules not verified)", () => {
    const f = fullFacts();
    f.adjustments.seHealthInsurance = missingLeaf();
    f.adjustments.seRetirement = missingLeaf();
    const ret = computeTy2025Return(f);
    expect(st(ret, "sch1.17")).toBe("needs_cpa_rule_unverified");
    expect(st(ret, "sch1.16")).toBe("needs_cpa_rule_unverified");
    expect(st(ret, "f1040.13a")).toBe("missing_input");
  });
});

describe("computeTy2025Return: MFJ-only guard", () => {
  it("a filing status answer other than MFJ stops the computation: every line needs_cpa_judgment, no amounts", () => {
    const f = fullFacts();
    f.household.filingStatus = owner("mfs");
    const ret = computeTy2025Return(f);
    for (const key of LINE_KEYS) {
      expect(ret.lines[key]?.status).toBe("needs_cpa_judgment");
      expect(ret.lines[key]?.amount).toBeNull();
    }
    expect(ret.headline.federal.totalTax.amount).toBeNull();
    expect(ret.headline.complete).toBe(false);
  });
  it("an unanswered filing status proceeds as MFJ", () => {
    const f = fullFacts();
    f.household.filingStatus = missingLeaf();
    expect(computeTy2025Return(f).headline.federal.totalTax.amount).toBe(27015);
  });
});

describe("computeTy2025Return: Eric-shaped cases", () => {
  it("D1 / acceptance 2: a second W-2 pushes Eric's Social Security wages past the base -> Medicare-only SE tax; excess Social Security is credited", () => {
    const f = fullFacts();
    f.income.w2s.push(
      w2({
        docId: "w2-eric-b",
        employer: "NUMU Food Group",
        personUserId: ERIC_ID,
        wagesCents: 9_000_000,
        fedWithheldCents: 900_000,
        socialSecurityWagesCents: 9_000_000,
        socialSecurityWithheldCents: 558_000,
        medicareWagesCents: 9_000_000,
        medicareWithheldCents: 130_500,
        ctWithheldCents: 100_000,
      })
    );
    const ret = computeTy2025Return(f);
    // SS wages 90,000 + 90,000 = 180,000 > 176,100 -> line 9 = 0, line 10 = 0, line 11 = 1,339
    expect(amt(ret, "se.8a")).toBe(180000);
    expect(amt(ret, "se.9")).toBe(0);
    expect(amt(ret, "se.10")).toBe(0);
    expect(amt(ret, "se.12")).toBe(1339);
    // box 4 total 5,580 + 5,580 = 11,160 vs maximum 10,918.20 -> excess 241.80 -> 242
    expect(amt(ret, "sch3.11")).toBe(242);
    expect(amt(ret, "f1040.31")).toBe(242);
    expect(amt(ret, "f1040.1a")).toBe(220000);
  });

  it("a W-2 with no person assigned blocks Schedule SE and excess Social Security (open item from the resolver is separate)", () => {
    const f = fullFacts();
    f.income.w2s[0]!.personUserId = null;
    f.income.w2s[0]!.subjectType = null;
    const ret = computeTy2025Return(f);
    expect(st(ret, "se.12")).toBe("missing_input");
    expect(st(ret, "sch3.11")).toBe("missing_input");
    expect(ret.headline.provisional).not.toBeNull();
  });

  it("1099-B boxes -> 1040 line 7a needs_cpa_judgment and the NIIT screen defers to the CPA above the threshold", () => {
    const f = fullFacts();
    f.income.otherIncomeBoxes = [
      { docId: "d1", payer: "Broker", basis: "doc_verified", variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 500_000 },
    ];
    const ret = computeTy2025Return(f);
    expect(st(ret, "f1040.7a")).toBe("needs_cpa_judgment");
    expect(st(ret, "f1040.9")).toBe("needs_cpa_judgment");
  });

  it("a 1099-R / SSA box makes the retirement and Social Security lines needs_cpa_judgment", () => {
    const f = fullFacts();
    f.income.otherIncomeBoxes = [{ docId: "d1", payer: "Fund", basis: "doc_verified", variant: "1099-R", box: "2a", label: "Taxable amount", amountCents: 100_000 }];
    const ret = computeTy2025Return(f);
    expect(st(ret, "f1040.4b")).toBe("needs_cpa_judgment");
  });

  it("dependents reported -> line 19 needs_cpa_judgment; unrecorded -> missing_input", () => {
    const f = fullFacts();
    f.household.noDependents = owner(false);
    expect(st(computeTy2025Return(f), "f1040.19")).toBe("needs_cpa_judgment");
    f.household.noDependents = missingLeaf();
    expect(st(computeTy2025Return(f), "f1040.19")).toBe("missing_input");
  });

  it("decision X1: an eligible home office shows simplified as 'default, undecided'; a recorded decision flips it", () => {
    const f = fullFacts();
    f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive");
    f.income.scheduleC.homeOfficeSqft = owner(1200);
    const undecided = computeTy2025Return(f);
    expect(undecided.decisions).toEqual([expect.objectContaining({ id: "X1", chosen: "simplified", status: "default_undecided" })]);
    expect(amt(undecided, "schc.30")).toBe(1500);
    expect(undecided.openItems.some((o) => o.id === "decision:X1" && o.severity === "advisory")).toBe(true);
    // schedule C net profit 50,000 - 1,500
    expect(amt(undecided, "schc.31")).toBe(48500);
    const decided = computeTy2025Return(f, { homeOfficeMethod: { chosen: "actual", by: "cpa", at: "2026-10-06T00:00:00Z" } });
    expect(decided.decisions[0]).toMatchObject({ chosen: "actual", status: "decided" });
    expect(st(decided, "schc.30")).toBe("not_yet_computed");
    expect(st(decided, "f1040.11a")).not.toBe("computed");
  });

  it("an unmapped GL account makes Schedule C, SE and everything below missing_input, with the account in the open items", () => {
    const f = fullFacts();
    f.income.scheduleC.glLines.push(gl("9999", "Mystery expense", "expense", 10_000));
    const ret = computeTy2025Return(f);
    expect(st(ret, "schc.31")).toBe("missing_input");
    expect(st(ret, "se.12")).toBe("missing_input");
    expect(st(ret, "f1040.11a")).not.toBe("computed");
    expect(ret.openItems.some((o) => o.id === "rule:schedule-c")).toBe(true);
    expect(ret.scheduleC?.unmapped.map((u) => u.name)).toEqual(["Mystery expense"]);
  });

  it("property tax bills: an unpaid / unclassified bill blocks Schedule A; a verified paid primary bill and an Arbor Rd bill both reach SALT", () => {
    const f = fullFacts();
    f.deductions.propertyTaxBills.push(bill({ docId: "pt-2", label: "56 Arbor Rd", address: "56 Arbor Rd", paidInYearCents: 300_000, kind: "other_real_estate" }));
    const ret = computeTy2025Return(f);
    expect(amt(ret, "scha.5b")).toBe(9000);
    expect(ret.decisions.some((d) => d.id === "X5" && d.status === "default_undecided")).toBe(true);
    // not in the CT credit (and credit is 0 at this CT AGI anyway)
    expect(amt(ret, "ct1040.11")).toBe(0);
    f.deductions.propertyTaxBills.push(bill({ docId: "pt-3", label: "Unpaid", paidInYearCents: null }));
    expect(st(computeTy2025Return(f), "scha.5b")).toBe("missing_input");
  });

  it("the facts object stays valid against the schema after computing (no mutation)", () => {
    const f = fullFacts();
    const before = JSON.stringify(f);
    computeTy2025Return(f);
    expect(JSON.stringify(f)).toBe(before);
    expect(ty2025FactsSchema.safeParse(f).success).toBe(true);
  });
});

describe("computeTy2025Return: forms required (C7) and open-item wording", () => {
  it("itemizing, Schedule B, Form 8283 and Form 8959 become required when their triggers are met", () => {
    const f = fullFacts();
    f.deductions.mortgages[0]!.interestCents = 3_500_000; // itemized 10,200 + 35,000 = 45,200 > 31,500
    f.income.interest[0]!.box1Cents = 160_000; // 1,600 > 1,500
    f.deductions.noDonationsConfirmed = { value: null, basis: null, refs: [] };
    f.deductions.donations = [{ id: "d", dateIso: "2025-06-01", recipient: "Library", kind: "noncash", amountCents: 60_000, substantiation: "written_acknowledgment", receiptDocumentId: "r" }];
    const ret = computeTy2025Return(f);
    expect(ret.formsRequired.scha?.required).toBe(true);
    expect(ret.formsRequired.schb?.required).toBe(true);
    expect(ret.formsRequired.f8283?.required).toBe(true);
    // 8959: one W-2 over $200,000
    const g = fullFacts();
    g.income.w2s[0]!.medicareWagesCents = 25_000_000;
    g.income.w2s[0]!.wagesCents = 25_000_000;
    g.income.w2s[0]!.socialSecurityWagesCents = 17_610_000;
    expect(computeTy2025Return(g).formsRequired.f8959?.required).toBe(true);
  });

  it("Schedule SE is not required under the $400 floor; blocking items make forms 'blocking', never silently false", () => {
    const f = fullFacts();
    f.income.scheduleC.glLines = [gl("4000", "Services", "revenue", 40_000)]; // $400 revenue, no expenses -> net 400 -> 369 < 400
    expect(computeTy2025Return(f).formsRequired.schse).toMatchObject({ required: false });
    const e = computeTy2025Return(emptyFacts());
    expect(e.formsRequired.schse?.required).toBe("blocking");
    expect(e.formsRequired.scha?.required).toBe("blocking");
    expect(e.formsRequired.f1040?.required).toBe(true);
  });

  it("a rule held back by a missing 'none' statement says so first, instead of quoting its unrelated narrative", () => {
    const f = fullFacts();
    delete f.statedNone.se_other;
    const ret = computeTy2025Return(f);
    const item = ret.openItems.find((o) => o.id === "rule:schedule-se");
    expect(item?.message).toContain("Not final yet");
  });
});
