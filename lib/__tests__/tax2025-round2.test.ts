import { describe, expect, it } from "vitest";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { distinctEmployerCount, mortgageNeedsReview } from "@/lib/tax2025/inputs";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { ERIC_ID, EVA_ID, fullFacts } from "@/lib/__tests__/tax2025-fixtures";

// Round 2 (Tester defects D2, D3, D5, D6); D1 lives in tax2025-schedule-c.test.ts, D4 in tax2025-tax-calc.test.ts.

function doc(over: Partial<RawDocument> & { id: string; docType: string; data: Record<string, unknown> }): RawDocument {
  const { data, ...rest } = over;
  return {
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: { summary: "x", data },
    verified: true,
    legacyFormat: false,
    subjectType: "person",
    subjectUserId: ERIC_ID,
    documentName: null,
    ...rest,
  };
}

function raw(over: Partial<RawTy2025Inputs> = {}): RawTy2025Inputs {
  return {
    taxYear: 2025,
    people: [
      { userId: ERIC_ID, name: "Eric" },
      { userId: EVA_ID, name: "Eva" },
    ],
    scheduleCOwner: { userId: ERIC_ID, basis: "derived", note: "name matches the entity name" },
    documents: [],
    planning: {
      filingStatus: "mfj",
      householdMembers: "none",
      evVehicle: "no",
      businessMileage: "no",
      homeOfficeEligibility: "no",
      homeOfficeSqft: null,
      solarCredit: null,
      donationsNone: true,
      fixedAssetsEkcNone: true,
      retirementContributionCents: null,
      estimatedPaymentsCombinedCents: null,
    },
    primaryResidence: { address: "27 Old Barry Rd", basis: "derived", note: "address on the home mortgage Form 1098" },
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
    ...over,
  };
}

const w2doc = (id: string, person: string, data: Record<string, unknown> = {}, over: Partial<RawDocument> = {}) =>
  doc({
    id,
    docType: "w2",
    subjectUserId: person,
    data: {
      employerName: "Alpine Bio",
      employerEIN: "12-3456789",
      wagesCents: 9_000_000,
      federalWithheldCents: 1_100_000,
      socialSecurityWagesCents: 9_000_000,
      socialSecurityWithheldCents: 558_000,
      medicareWagesCents: 9_000_000,
      medicareWithheldCents: 130_500,
      stateLines: [{ stateCode: "CT", stateWagesCents: 9_000_000, stateWithheldCents: 300_000 }],
      ...data,
    },
    ...over,
  });

describe("D2: exact duplicate documents are counted once and block", () => {
  const div1099 = (id: string, over: Partial<RawDocument> = {}) =>
    doc({ id, docType: "1099", data: { formVariant: "1099-DIV", payerName: "Robinhood", div_box1aCents: 100_000, div_box1bCents: 80_000 }, ...over });
  const form1098 = (id: string) =>
    doc({ id, docType: "mortgage_interest", data: { servicerName: "PennyMac", interestCents: 1_888_269, principalBalanceCents: 40_000_000, propertyAddress: "27 Old Barry Rd" } });
  const taxBill = (id: string) =>
    doc({ id, docType: "property_tax", data: { jurisdictionName: "Town", taxType: "real_estate", propertyAddress: "27 Old Barry Rd", totalTaxBilledCents: 600_000, paidInTaxYearCents: 600_000 } });

  it("W-2 duplicate: counted once (the verified copy), one BLOCKING item naming both documents", () => {
    const { facts, openItems } = resolveFacts(
      raw({ documents: [w2doc("a", ERIC_ID, {}, { verified: false }), w2doc("b", ERIC_ID)] })
    );
    expect(facts.income.w2s.map((w) => w.docId)).toEqual(["b"]);
    expect(facts.income.w2s[0]!.wagesCents).toBe(9_000_000); // not 18,000,000
    const item = openItems.find((o) => o.id.startsWith("doc-duplicate:w2:"));
    expect(item?.severity).toBe("blocking");
    expect(item?.id).toBe("doc-duplicate:w2:b:a");
    expect(item?.message).toContain("verified copy");
  });

  it("1099, 1098 and property tax duplicates: counted once, one BLOCKING item each", () => {
    const { facts, openItems } = resolveFacts(
      raw({ documents: [div1099("d1"), div1099("d2"), form1098("m1"), form1098("m2"), taxBill("p1"), taxBill("p2")] })
    );
    expect(facts.income.dividends).toHaveLength(1);
    expect(facts.income.dividends[0]!.box1aCents).toBe(100_000);
    expect(facts.deductions.mortgages).toHaveLength(1);
    expect(facts.deductions.propertyTaxBills).toHaveLength(1);
    const items = openItems.filter((o) => o.id.startsWith("doc-duplicate:"));
    expect(items.map((o) => o.id.split(":")[1]).sort()).toEqual(["1099", "mortgage_interest", "property_tax"]);
    expect(items.every((o) => o.severity === "blocking")).toBe(true);
  });

  it("documents that differ in person, issuer or any key amount are NOT duplicates", () => {
    const { facts, openItems } = resolveFacts(
      raw({
        documents: [
          w2doc("a", ERIC_ID),
          w2doc("other-person", EVA_ID),
          w2doc("other-wages", ERIC_ID, { wagesCents: 9_000_001 }),
          div1099("x"),
          div1099("y", { extractionData: { data: { formVariant: "1099-DIV", payerName: "Robinhood", div_box1aCents: 100_001 } } }),
        ],
      })
    );
    expect(facts.income.w2s).toHaveLength(3);
    expect(facts.income.dividends).toHaveLength(2);
    expect(openItems.some((o) => o.id.startsWith("doc-duplicate:"))).toBe(false);
  });

  it("the verified copy is counted even when listed second; with two unverified copies the first is counted", () => {
    const a = resolveFacts(raw({ documents: [div1099("unverified", { verified: false }), div1099("verified")] }));
    expect(a.facts.income.dividends.map((d) => d.docId)).toEqual(["verified"]);
    const b = resolveFacts(raw({ documents: [div1099("first", { verified: false }), div1099("second", { verified: false })] }));
    expect(b.facts.income.dividends.map((d) => d.docId)).toEqual(["first"]);
  });

  it("headline.complete is false while a duplicate is unresolved even though every amount computes; advisory items do not block", () => {
    const f = fullFacts();
    const clean = computeTy2025Return(f);
    expect(clean.headline.complete).toBe(true);
    const { openItems } = resolveFacts(raw({ documents: [w2doc("a", ERIC_ID), w2doc("b", ERIC_ID)] }));
    const blocked = computeTy2025Return(f, {}, { openItems });
    expect(blocked.headline.federal.totalTax.amount).toBe(27015);
    expect(blocked.headline.complete).toBe(false);
    expect(blocked.headline.blockingItemCount).toBe(1);
    expect(blocked.headline.provisional).not.toBeNull();
    const advisoryOnly = computeTy2025Return(f, {}, { openItems: [{ ...openItems[0]!, severity: "advisory" }] });
    expect(advisoryOnly.headline.complete).toBe(true);
  });
});

describe("D3: nothing is dropped silently", () => {
  it("a Form 1098 with no interest read is kept (Schedule A line 8a missing_input) and raises a blocking item", () => {
    const { facts, openItems } = resolveFacts(
      raw({ documents: [doc({ id: "m", docType: "mortgage_interest", data: { servicerName: "PennyMac", principalBalanceCents: 40_000_000, propertyAddress: "27 Old Barry Rd" } })] })
    );
    expect(facts.deductions.mortgages).toHaveLength(1);
    expect(facts.deductions.mortgages[0]!.interestCents).toBeNull();
    expect(openItems.find((o) => o.id === "form1098-no-interest:m")?.severity).toBe("blocking");
    const f = fullFacts();
    f.deductions.mortgages = facts.deductions.mortgages;
    expect(computeTy2025Return(f).lines["scha.8a"]?.status).toBe("missing_input");
  });

  it("two 1098s where one has no interest: the return cannot complete (the old code let that one vanish)", () => {
    const f = fullFacts();
    f.deductions.mortgages = [f.deductions.mortgages[0]!, { ...f.deductions.mortgages[0]!, docId: "m2", interestCents: null }];
    const ret = computeTy2025Return(f);
    expect(ret.lines["scha.8a"]?.status).toBe("missing_input");
    expect(ret.headline.complete).toBe(false);
  });

  it("federal withholding on a legacy-format non-INT 1099 is not counted and raises a BLOCKING item with the amount; with none it is advisory", () => {
    const withheld = resolveFacts(
      raw({ documents: [doc({ id: "l", docType: "1099", legacyFormat: true, data: { formVariant: "1099-DIV", amountCents: 5_000, federalWithheldCents: 1_250 } })] })
    );
    expect(withheld.facts.payments.federal1099WithheldCents).toBe(0);
    const item = withheld.openItems.find((o) => o.id === "legacy-1099-withholding:l");
    expect(item?.severity).toBe("blocking");
    expect(item?.message).toContain("$12.50");
    const none = resolveFacts(raw({ documents: [doc({ id: "l2", docType: "1099", legacyFormat: true, data: { formVariant: "1099-DIV", amountCents: 5_000 } })] }));
    expect(none.openItems.find((o) => o.id === "legacy-1099-withholding:l2")?.severity).toBe("advisory");
    const intDoc = resolveFacts(raw({ documents: [doc({ id: "i", docType: "1099", legacyFormat: true, data: { formVariant: "1099-INT", amountCents: 7_700, federalWithheldCents: 770 } })] }));
    expect(intDoc.facts.payments.federal1099WithheldCents).toBe(770);
    expect(intDoc.openItems.some((o) => o.id.startsWith("legacy-1099-withholding:"))).toBe(false);
  });
});

describe("D5: informational lines never block", () => {
  it("golden fixture: blockingItemCount 0 and complete = true when all data is supplied", () => {
    const ret = computeTy2025Return(fullFacts());
    expect(ret.headline.blockingItemCount).toBe(0);
    expect(ret.headline.complete).toBe(true);
    expect(ret.openItems.filter((o) => o.severity === "blocking")).toEqual([]);
  });

  it("ct1040.27 / ct1040.28 stay uncomputed (needs_cpa_rule_unverified, no amount) but are flagged informational and become advisory items", () => {
    const ret = computeTy2025Return(fullFacts());
    for (const key of ["ct1040.27", "ct1040.28"] as const) {
      const l = ret.lines[key]!;
      expect(l.status).toBe("needs_cpa_rule_unverified");
      expect(l.amount).toBeNull();
      expect(l.informational).toBe(true);
      const item = ret.openItems.find((o) => o.id === `info:${key}`);
      expect(item?.severity).toBe("advisory");
    }
    expect(ret.results.find((r) => r.ruleId === "ct-balance")?.status).toBe("computed");
  });

  it("a real gap still blocks: with the CT balance inputs missing the ct-balance rule is a blocking item again", () => {
    const f = fullFacts();
    f.ct.useTax = { value: null, basis: null, refs: [] };
    const ret = computeTy2025Return(f);
    expect(ret.openItems.some((o) => o.id === "rule:ct-balance" && o.severity === "blocking")).toBe(true);
    expect(ret.headline.complete).toBe(false);
  });
});

describe("D6: employers and mortgage properties", () => {
  it("distinctEmployerCount: EIN first (formatting ignored), then the employer name, then the document", () => {
    expect(distinctEmployerCount([{ employerEin: "12-3456789", employer: "A", docId: "1" }, { employerEin: "123456789", employer: "B", docId: "2" }])).toBe(1);
    expect(distinctEmployerCount([{ employerEin: "12-3456789", employer: "A", docId: "1" }, { employerEin: "98-7654321", employer: "A", docId: "2" }])).toBe(2);
    expect(distinctEmployerCount([{ employerEin: null, employer: "Alpine Bio", docId: "1" }, { employerEin: null, employer: " alpine bio ", docId: "2" }])).toBe(1);
    expect(distinctEmployerCount([{ employerEin: null, employer: null, docId: "1" }, { employerEin: null, employer: null, docId: "2" }])).toBe(2);
  });

  const twoEric = (ein2: string, name2: string) => {
    const f = fullFacts();
    f.income.w2s[0]!.employerEin = "12-3456789";
    f.income.w2s.push({ ...f.income.w2s[0]!, docId: "w2-eric-b", employer: name2, employerEin: ein2 });
    return f;
  };

  it("two W-2s from ONE employer (same EIN): Social Security withheld 5,580 + 5,580 = 11,160 exceeds 10,918.20 but there is no credit (needs two employers)", () => {
    const ret = computeTy2025Return(twoEric("12-3456789", "Alpine Bio"));
    expect(ret.lines["sch3.11"]?.amount).toBe(0);
    expect(ret.results.find((r) => r.ruleId === "excess-social-security")?.reasons.join(" ")).toContain("no excess");
  });

  it("two DIFFERENT employers (different EIN): credit = 11,160 - 10,918.20 = 241.80 -> 242", () => {
    expect(computeTy2025Return(twoEric("98-7654321", "NUMU Food Group")).lines["sch3.11"]?.amount).toBe(242);
  });

  it("employers without an EIN are told apart by name and the resolver raises an advisory", () => {
    const { facts, openItems } = resolveFacts(
      raw({
        documents: [
          w2doc("a", ERIC_ID, { employerEIN: null, employerName: "Alpine Bio" }),
          w2doc("b", ERIC_ID, { employerEIN: null, employerName: "NUMU Food Group", wagesCents: 1_000_000 }),
        ],
      })
    );
    expect(openItems.find((o) => o.id === `w2-no-ein:${ERIC_ID}`)?.severity).toBe("advisory");
    expect(distinctEmployerCount(facts.income.w2s)).toBe(2);
  });

  it("mortgageNeedsReview: primary known -> other addresses flagged; primary unknown -> flagged only when several properties are on file", () => {
    expect(mortgageNeedsReview("27 Old Barry Rd", ["27 Old Barry Rd"], "27 Old Barry Rd")).toBe(false);
    expect(mortgageNeedsReview("56 Arbor Rd", ["27 Old Barry Rd", "56 Arbor Rd"], "27 Old Barry Rd")).toBe(true);
    expect(mortgageNeedsReview("56 Arbor Rd", ["27 Old Barry Rd", "56 Arbor Rd"], null)).toBe(true);
    expect(mortgageNeedsReview("27 Old Barry Rd", ["27 Old Barry Rd", "27 Old Barry Road"], null)).toBe(false);
    expect(mortgageNeedsReview(null, [null], null)).toBe(false);
  });

  it("two 1098s for different properties: blocking resolver item; Schedule A line 8a and the deduction are needs_cpa_judgment (fail safe)", () => {
    const m = (id: string, addr: string) =>
      doc({ id, docType: "mortgage_interest", data: { servicerName: "Lender", interestCents: 1_000_000, principalBalanceCents: 20_000_000, propertyAddress: addr } });
    const { facts, openItems } = resolveFacts(raw({ primaryResidence: null, documents: [m("a", "27 Old Barry Rd"), m("b", "56 Arbor Rd")] }));
    expect(openItems.find((o) => o.id === "form1098-multiple-properties")?.severity).toBe("blocking");
    const f = fullFacts();
    f.deductions.mortgages = facts.deductions.mortgages;
    f.deductions.primaryResidenceAddress = { value: null, basis: null, refs: [] };
    const ret = computeTy2025Return(f);
    expect(ret.lines["scha.8a"]?.status).toBe("needs_cpa_judgment");
    expect(ret.lines["f1040.12e"]?.status).toBe("needs_cpa_judgment");
    expect(ret.headline.complete).toBe(false);
    // primary residence known: the OTHER property's 1098 is still flagged
    f.deductions.primaryResidenceAddress = { value: "27 Old Barry Rd", basis: "answer_owner", refs: [] };
    expect(computeTy2025Return(f).lines["scha.8a"]?.status).toBe("needs_cpa_judgment");
    // a single 1098 for the primary residence is unaffected
    f.deductions.mortgages = [facts.deductions.mortgages[0]!];
    expect(computeTy2025Return(f).lines["scha.8a"]?.status).toBe("computed");
  });
});
