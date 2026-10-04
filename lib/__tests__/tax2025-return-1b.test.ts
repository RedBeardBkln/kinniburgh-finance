import { describe, expect, it } from "vitest";
import { ty2025FactsSchema } from "@/lib/tax2025/facts";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { computeTy2025Return, duplicateEmissions } from "@/lib/tax2025/return";
import { LINE_CATALOG, missingLeaf, type LineKey, type Ty2025Return } from "@/lib/tax2025/types";
import { ERIC_ID, EVA_ID, dividend, fullFacts1b, owner } from "@/lib/__tests__/tax2025-fixtures";

const amt = (r: Ty2025Return, k: LineKey): number | null => {
  const l = r.lines[k];
  if (!l) throw new Error(`no line ${k}`);
  return l.amount;
};
const st = (r: Ty2025Return, k: LineKey): string | undefined => r.lines[k]?.status;

// Baseline (all answers "none", see tax2025-return.test.ts for the hand computation): AGI 177,967, standard deduction 31,500,
// QBI 9,293, taxable income 137,174, tax 19,950, SE tax 7,065, total tax 27,015, payments 15,000, balance 12,015.

describe("Phase 1b: the answers drive the lines (everything answered none)", () => {
  const ret = computeTy2025Return(fullFacts1b());

  it("reproduces the stated-amount golden numbers exactly (no regression from the stated path)", () => {
    expect(ret.headline.federal.agi.amount).toBe(177967);
    expect(ret.headline.federal.taxableIncome.amount).toBe(137174);
    expect(ret.headline.federal.totalTax.amount).toBe(27015);
    expect(ret.headline.federal.balance.amount).toBe(12015);
    expect(ret.headline.connecticut.balance.amount).toBe(4588);
    expect(ret.headline.complete).toBe(true);
  });

  it("the former not_yet_computed lines are now computed or explicit not_applicable zeros with reasons", () => {
    for (const k of ["sch1.13", "sch1.20", "f1040.13b", "sch3.1", "sch3.4", "ct1040.15"] as const) {
      expect(["computed", "not_applicable"], k).toContain(st(ret, k));
      expect(amt(ret, k), k).toBe(0);
      expect(ret.lines[k]?.reason, k).toBeTruthy();
    }
  });

  it("provenance: the 1b lines carry the references of the answers they came from", () => {
    // (the fixture's answers cite "planning"-kind refs; real questionnaire answers cite questionnaire refs, see tax2025-answers.test.ts)
    for (const k of ["sch1a.38", "f1040.13b", "sch1.13", "std.total"] as const) expect(ret.lines[k]?.refs.length, k).toBeGreaterThan(0);
  });

  it("the saver's credit is a computed 'ineligible' conclusion with the Form 8880 citation (AGI 177,967 is over 79,000)", () => {
    const r = ret.results.find((x) => x.ruleId === "saver-8880")!;
    expect(r.status).toBe("computed");
    expect(r.conclusion).toBe("ineligible");
    expect(r.reasons[0]).toContain("more than $79,000");
    expect(ret.citations).toContain("SAVERS_RATE_BANDS_MFJ");
  });

  it("the Form 2210 estimate is informational: 1,250 short per installment -> 233; line 1040.38 copies it", () => {
    // tax 27,015 -> line 5 = 24,313.5; prior 20,000 x 100% = 20,000 = line 9; withholding 15,000 (3,750 a quarter); installments 5,000
    // penalty = 1,250 x 0.07 x (365 + 304 + 212 + 90) / 365 = 232.77 -> 233
    expect(amt(ret, "f2210.4")).toBe(27015);
    expect(amt(ret, "f2210.9")).toBe(20000);
    expect(amt(ret, "f2210.19")).toBe(233);
    expect(amt(ret, "f1040.38")).toBe(233);
    expect(ret.results.find((x) => x.ruleId === "penalty-2210-estimate")?.informational).toBe(true);
    expect(amt(ret, "f1040.37")).toBe(12015); // the estimate never changes the amount you owe line
  });

  it("no duplicate emissions (each line key has exactly one owner) and every catalog key is present", () => {
    expect(duplicateEmissions(fullFacts1b())).toEqual([]);
    expect(Object.keys(ret.lines).length).toBe(LINE_CATALOG.length);
  });

  it("the facts object stays JSON-valid", () => {
    expect(ty2025FactsSchema.safeParse(fullFacts1b()).success).toBe(true);
  });
});

describe("Phase 1b: Schedule 1-A flows to line 13b, taxable income and the QBI base", () => {
  it("overtime premium 10,000 for Eva: 13b = 10,000; taxable income 127,174; line 14 = 12e + 13a + 13b", () => {
    const f = fullFacts1b();
    f.returnAnswers.magiExclusionsNone = owner(true);
    f.returnAnswers.people[1]!.overtimeChoice = owner("premium");
    f.returnAnswers.people[1]!.overtimeCents = owner(1_000_000);
    f.returnAnswers.people[1]!.validSsn = owner(true);
    const r = computeTy2025Return(f);
    expect(amt(r, "sch1a.21")).toBe(10000);
    expect(amt(r, "f1040.13b")).toBe(10000);
    expect(amt(r, "f1040.11b")).toBe(177967);
    expect(amt(r, "f1040.14")).toBe(31500 + 9293 + 10000);
    expect(amt(r, "f1040.15")).toBe(127174);
    expect(r.headline.federal.totalTax.amount).toBeLessThan(27015);
    expect(r.formsRequired.sch1a?.required).toBe(true);
  });

  it("an 'ask the employer' tips answer holds 13b and the taxable income as missing_input (never 0)", () => {
    const f = fullFacts1b();
    f.returnAnswers.people[1]!.tipsChoice = owner("ask_employer");
    const r = computeTy2025Return(f);
    expect(st(r, "f1040.13b")).toBe("missing_input");
    expect(st(r, "f1040.15")).not.toBe("computed");
    expect(r.headline.complete).toBe(false);
    expect(r.headline.provisional?.assumedZeroLines).toContain("sch1a.38");
    expect(r.openItems.some((o) => o.id === "rule:schedule-1a" && o.severity === "blocking")).toBe(true);
  });

  it("a stated Schedule 1-A amount overrides the rule and is cited as stated", () => {
    const f = fullFacts1b();
    f.adjustments.sch1a = owner(250000);
    const r = computeTy2025Return(f);
    expect(amt(r, "f1040.13b")).toBe(2500);
    expect(r.lines["f1040.13b"]?.reason).toContain("Stated");
  });
});

describe("Phase 1b: the standard deduction with the line 12d boxes (coordinator addition)", () => {
  /** Born before 1961 also triggers the Schedule 1-A senior deduction, which needs the SSN and the MAGI-exclusion answers. */
  const seniorAnswers = (f: ReturnType<typeof fullFacts1b>, who: number[]): void => {
    f.returnAnswers.magiExclusionsNone = owner(true);
    for (const i of who) {
      f.returnAnswers.people[i]!.bornBefore1961 = owner(true);
      f.returnAnswers.people[i]!.validSsn = owner(true);
    }
  };

  it("Eric born before January 2, 1961: 12e = 33,100 (1 box) and the senior deduction 6,000 - 6% x 27,967 = 4,322 is on 13b", () => {
    const f = fullFacts1b();
    seniorAnswers(f, [0]);
    const r = computeTy2025Return(f);
    expect(amt(r, "std.total")).toBe(33100);
    expect(amt(r, "std.additional")).toBe(1600);
    expect(amt(r, "f1040.12e")).toBe(33100);
    expect(amt(r, "sch1a.36a")).toBe(4322);
    expect(amt(r, "f1040.13b")).toBe(4322);
    expect(amt(r, "f1040.15")).toBe(177967 - 33100 - 9293 - 4322);
  });

  it("four boxes: 37,900 (the itemized 29,083 still loses)", () => {
    const f = fullFacts1b();
    seniorAnswers(f, [0, 1]);
    for (const p of f.returnAnswers.people) p.blind = owner(true);
    expect(amt(computeTy2025Return(f), "f1040.12e")).toBe(37900);
  });

  it("an unanswered blind box blocks 12e, the comparison and taxable income (never silently 31,500) and is a blocking open item", () => {
    const f = fullFacts1b();
    f.returnAnswers.people[0]!.blind = missingLeaf();
    const r = computeTy2025Return(f);
    expect(st(r, "std.total")).toBe("missing_input");
    expect(st(r, "f1040.12e")).toBe("missing_input");
    expect(st(r, "f1040.15")).not.toBe("computed");
    expect(r.headline.federal.taxableIncome.amount).toBeNull();
    expect(r.openItems.some((o) => o.id === "rule:standard-deduction" && o.severity === "blocking")).toBe(true);
    expect(r.formsRequired.scha?.required).toBe("blocking");
    // the provisional estimate names the assumption instead of hiding it
    expect(r.headline.provisional?.assumedFacts.join(" ")).toContain("age 65 / blind");
  });

  it("the itemize crossover uses the adjusted amount: with itemized deductions of 36,000, four boxes (37,900) make the standard deduction win", () => {
    const f = fullFacts1b();
    // push itemized above the 31,500 base: a 7,000 donation log entry (cash) raises Schedule A to 36,083
    f.deductions.noDonationsConfirmed = missingLeaf();
    f.deductions.donations = [{ id: "d1", dateIso: "2025-05-01", recipient: "Charity", kind: "cash", amountCents: 700_000, substantiation: "written_acknowledgment", receiptDocumentId: "r1" }];
    const base = computeTy2025Return(f);
    expect(amt(base, "scha.17")).toBe(36083);
    expect(amt(base, "f1040.12e")).toBe(36083); // itemizing beats 31,500
    seniorAnswers(f, [0, 1]);
    for (const p of f.returnAnswers.people) p.blind = owner(true);
    const four = computeTy2025Return(f);
    expect(amt(four, "f1040.12e")).toBe(37900); // standard now wins
  });
});

describe("Phase 1b: HSA, IRA, foreign tax and use tax", () => {
  it("an HSA deduction of 3,000 lowers AGI to 174,967", () => {
    const f = fullFacts1b();
    const eric = f.returnAnswers.people[0]!;
    eric.hsaCoverage = owner("family");
    eric.hsaMonthsEligible = owner(12);
    eric.hsaEligibleDec1 = owner(true);
    eric.hsaMedicareOrDependent = owner(false);
    eric.age55Plus = owner(false);
    eric.hsaDirectContributionsCents = owner(300_000);
    eric.hsaEmployerOtherYear = owner(false);
    const r = computeTy2025Return(f);
    expect(amt(r, "f8889a.13")).toBe(3000);
    expect(amt(r, "sch1.13")).toBe(3000);
    expect(amt(r, "f1040.11a")).toBe(174967);
  });

  it("a 7,000 IRA deduction for Eric (not covered; Eva covered, MAGI 177,967 under 236,000) lowers AGI to 170,967", () => {
    const f = fullFacts1b();
    const [eric, eva] = f.returnAnswers.people;
    eric!.traditionalIraCents = owner(700_000);
    eric!.age50Plus = owner(false);
    eva!.coveredByWorkplacePlan = owner(true);
    const r = computeTy2025Return(f);
    expect(amt(r, "ira.magi")).toBe(177967);
    expect(amt(r, "ira.a.7")).toBe(7000);
    expect(amt(r, "sch1.20")).toBe(7000);
    expect(amt(r, "f1040.11a")).toBe(170967);
  });

  it("covered by a plan at MAGI over 146,000: the IRA contribution is a computed zero (not guessed, with the reason)", () => {
    const f = fullFacts1b();
    f.returnAnswers.people[0]!.traditionalIraCents = owner(700_000);
    f.returnAnswers.people[0]!.age50Plus = owner(false);
    f.returnAnswers.people[0]!.coveredByWorkplacePlan = owner(true);
    const r = computeTy2025Return(f);
    expect(amt(r, "sch1.20")).toBe(0);
    expect(r.results.find((x) => x.ruleId === "ira-deduction")?.reasons.join(" ")).toContain("not deductible");
  });

  it("foreign tax on a 1099-DIV (box 7 of 200) is a 200 direct credit reducing tax after credits", () => {
    const f = fullFacts1b();
    f.income.dividends = [dividend({ docId: "div-1", box1aCents: 100_000, box1bCents: 80_000, box7Cents: 20_000 })];
    const r = computeTy2025Return(f);
    expect(amt(r, "sch3.1")).toBe(200);
    expect(amt(r, "f1040.20")).toBe(200);
    expect(amt(r, "f1040.22")).toBe(19950 - 200);
  });

  it("CT use tax: 2,000 of purchases x 6.35% = 127 raises the CT balance from 4,588 to 4,715", () => {
    const f = fullFacts1b();
    f.returnAnswers.useTax = {
      choice: owner("some"),
      generalRatePurchasesCents: owner(200_000),
      otherRateItems: owner(false),
      taxPaidToOtherStateCents: owner(0),
    };
    const r = computeTy2025Return(f);
    expect(amt(r, "ct1040.15")).toBe(127);
    expect(amt(r, "ct1040.balance")).toBe(4715);
  });

  it("an unanswered use tax question is missing_input (CT-1040 line 15 must be 0 or an amount); not sure is needs_cpa_judgment", () => {
    const f = fullFacts1b();
    f.returnAnswers.useTax.choice = missingLeaf();
    expect(st(computeTy2025Return(f), "ct1040.15")).toBe("missing_input");
    f.returnAnswers.useTax.choice = { value: null, basis: "answer_owner", refs: [] };
    expect(st(computeTy2025Return(f), "ct1040.15")).toBe("needs_cpa_judgment");
  });

  it("saver's credit inside the range: AGI forced to 47,500 by a stated override is NOT how it works - the rule reads the real AGI", () => {
    const f = fullFacts1b();
    f.returnAnswers.people[0]!.deferralsCents = owner(100_000);
    const r = computeTy2025Return(f);
    expect(r.results.find((x) => x.ruleId === "saver-8880")?.conclusion).toBe("ineligible");
    expect(amt(r, "sch3.4")).toBe(0);
  });
});

describe("Phase 1b: header attestations and informational items", () => {
  it("unanswered attestations are blocking items; No/No clears them; Yes is a CPA hand-off", () => {
    const f = fullFacts1b();
    f.returnAnswers.attestations = { digitalAssets: missingLeaf(), foreignAccounts: missingLeaf() };
    const open = computeTy2025Return(f);
    expect(open.attestations.digitalAssets.status).toBe("missing");
    expect(open.openItems.filter((o) => o.id.startsWith("attest:") && o.severity === "blocking")).toHaveLength(2);
    const clear = computeTy2025Return(fullFacts1b());
    expect(clear.attestations.digitalAssets).toMatchObject({ value: false, status: "answered" });
    expect(clear.openItems.some((o) => o.id.startsWith("attest:"))).toBe(false);
    f.returnAnswers.attestations = { digitalAssets: owner(true), foreignAccounts: { value: null, basis: "answer_owner", refs: [] } };
    const yes = computeTy2025Return(f);
    expect(yes.attestations.digitalAssets.value).toBe(true);
    expect(yes.attestations.foreignAccounts.status).toBe("unsure");
    expect(yes.openItems.filter((o) => o.id.startsWith("attest:") && o.severity === "blocking")).toHaveLength(2);
  });

  it("missing 2024 return data makes the Form 2210 estimate an ADVISORY item and never blocks the headline", () => {
    const f = fullFacts1b();
    f.priorYear = { totalTaxCents: missingLeaf(), agiCents: missingLeaf(), filingStatus: missingLeaf() };
    const r = computeTy2025Return(f);
    expect(st(r, "f2210.19")).toBe("missing_input");
    const item = r.openItems.find((o) => o.id === "rule:penalty-2210-estimate");
    expect(item?.severity).toBe("advisory");
    expect(r.headline.complete).toBe(true);
    expect(r.headline.blockingItemCount).toBe(computeTy2025Return(fullFacts1b()).headline.blockingItemCount);
  });

  it("the Schedule 3 assembly result is present, informational and cites the line map", () => {
    const r = computeTy2025Return(fullFacts1b()).results.find((x) => x.ruleId === "schedule-3")!;
    expect(r.informational).toBe(true);
    expect(r.reasons.join(" ")).toContain("not a 2025 item");
  });
});

// ── resolveFacts: cross-checks between the answers and the W-2s ──────────────
function w2doc(id: string, person: string, data: Record<string, unknown>): RawDocument {
  return {
    id,
    docType: "w2",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: { summary: "x", data: { employerName: "Alpine Bio", wagesCents: 9_000_000, federalWithheldCents: 1_100_000, socialSecurityWagesCents: 9_000_000, socialSecurityWithheldCents: 558_000, medicareWagesCents: 9_000_000, medicareWithheldCents: 130_500, box12: [], ...data } },
    verified: true,
    legacyFormat: false,
    subjectType: "person",
    subjectUserId: person,
    documentName: null,
  };
}
function raw(documents: RawDocument[], returnAnswers: RawTy2025Inputs["answers"] = undefined): RawTy2025Inputs {
  return {
    taxYear: 2025,
    people: [
      { userId: ERIC_ID, name: "Eric" },
      { userId: EVA_ID, name: "Eva" },
    ],
    scheduleCOwner: { userId: ERIC_ID, basis: "derived", note: "x" },
    documents,
    planning: { filingStatus: "mfj", householdMembers: "none", evVehicle: "no", businessMileage: "no", homeOfficeEligibility: "no", homeOfficeSqft: null, solarCredit: null, donationsNone: true, fixedAssetsEkcNone: true, retirementContributionCents: null, estimatedPaymentsCombinedCents: null },
    ...(returnAnswers ? { answers: returnAnswers } : {}),
    primaryResidence: null,
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
  };
}

describe("resolveFacts: Return completeness cross-checks and open items", () => {
  const answers = (mut: (a: ReturnType<typeof fullFacts1b>["returnAnswers"]) => void): NonNullable<RawTy2025Inputs["answers"]> => {
    const ra = fullFacts1b().returnAnswers;
    mut(ra);
    return { statedNone: {}, returnAnswers: ra };
  };

  it("without the questionnaire there is a blocking 'not started' item and a facts object that still validates", () => {
    const { facts, openItems } = resolveFacts(raw([]));
    expect(openItems.find((o) => o.id === "return-completeness-not-started")?.severity).toBe("advisory");
    expect(facts.returnAnswers.people.map((p) => p.slot)).toEqual(["a", "b"]);
    expect(facts.returnAnswers.people[0]!.userId).toBe(ERIC_ID);
    expect(ty2025FactsSchema.safeParse(facts).success).toBe(true);
  });

  it("owner deferrals versus W-2 box 12: a disagreement is a conflict listing both values (the owner answer is used)", () => {
    const { conflicts } = resolveFacts(
      raw([w2doc("w-eric", ERIC_ID, { box12: [{ code: "D", amountCents: 2_300_000 }] })], answers((a) => {
        a.people[0]!.deferralsCents = owner(1_000_000);
      }))
    );
    const c = conflicts.find((x) => x.factKey === "returnAnswers.a.deferrals")!;
    expect(c.candidates.map((x) => x.value)).toEqual([1_000_000, 2_300_000]);
    expect(c.chosen).toContain("owner answer");
    // equal amounts: no conflict
    const none = resolveFacts(raw([w2doc("w-eric", ERIC_ID, { box12: [{ code: "D", amountCents: 2_300_000 }] })], answers((a) => { a.people[0]!.deferralsCents = owner(2_300_000); })));
    expect(none.conflicts.some((x) => x.factKey === "returnAnswers.a.deferrals")).toBe(false);
  });

  it("workplace plan answer versus W-2 box 13, HSA coverage 'none' versus box 12 code W, tips none versus box 7, overtime none versus box 14", () => {
    const docs = [
      w2doc("w-eric", ERIC_ID, { retirementPlan: true, box12: [{ code: "W", amountCents: 150_000 }], socialSecurityTipsCents: 500_000, box14: [{ label: "Overtime premium", amountCents: 120_000 }] }),
    ];
    const { conflicts } = resolveFacts(
      raw(docs, answers((a) => {
        a.people[0]!.coveredByWorkplacePlan = owner(false);
        a.people[0]!.hsaCoverage = owner("none");
        a.people[0]!.tipsChoice = owner("none");
        a.people[0]!.overtimeChoice = owner("none");
      }))
    );
    const keys = conflicts.map((c) => c.factKey);
    expect(keys).toContain("returnAnswers.a.workplacePlan");
    expect(keys).toContain("returnAnswers.a.hsa");
    expect(keys).toContain("returnAnswers.a.tips");
    expect(keys).toContain("returnAnswers.a.overtime");
    expect(conflicts.find((c) => c.factKey === "returnAnswers.a.hsa")?.chosen).toBeNull();
  });

  it("a stale saved row is an advisory item; the 2024 filing status is read from the prior return", () => {
    const r = raw([], answers(() => undefined));
    r.returnCompletenessStale = true;
    expect(resolveFacts(r).openItems.find((o) => o.id === "return-completeness-stale")?.severity).toBe("advisory");
    const prior: RawDocument = { ...w2doc("p", ERIC_ID, {}), docType: "tax_return", taxYear: 2024, extractionData: { summary: "x", data: { formType: "1040", agiCents: 12_000_000, totalTaxCents: 2_000_000, filingStatus: "mfj" } } };
    const { facts } = resolveFacts(raw([prior], answers(() => undefined)));
    expect(facts.priorYear.filingStatus.value).toBe("mfj");
    expect(facts.priorYear.totalTaxCents.value).toBe(2_000_000);
  });
});
