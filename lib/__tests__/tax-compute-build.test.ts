import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  classifyTaxBreakdownLabel,
  classifyAdditionalWithholdingLabel,
  sumPaystubWithholding,
  findUnparseableExtractions,
  sumW2Documents,
  sum1099InterestIncome,
  sumItemizedDocInputs,
  parseDollarAnswerToCents,
  parseSqftAnswer,
  resolveHomeOfficeSqft,
  resolvePersonalTaxComputeInput,
  type PaystubWithholdingInput,
  type W2DocInput,
  type Doc1099Input,
  type ItemizedDocInput,
  type RawPersonalTaxComputeInput,
} from "@/lib/tax-compute-build";

const d = (iso: string) => new Date(iso + "T00:00:00Z");

// ── classifyTaxBreakdownLabel ──────────────────────────────────────────────────

describe("classifyTaxBreakdownLabel", () => {
  it("real live label strings land in the correct bucket", () => {
    expect(classifyTaxBreakdownLabel("Federal Income Tax")).toBe("federal_income_tax");
    expect(classifyTaxBreakdownLabel("Connecticut State Income Tax")).toBe("ct_income_tax");
    expect(classifyTaxBreakdownLabel("CT Income Tax")).toBe("ct_income_tax");
    expect(classifyTaxBreakdownLabel("Connecticut Paid Family")).toBe("fica_or_other_excluded");
    expect(classifyTaxBreakdownLabel("CT PFML")).toBe("fica_or_other_excluded");
    expect(classifyTaxBreakdownLabel("Social Security")).toBe("fica_or_other_excluded");
    expect(classifyTaxBreakdownLabel("Medicare")).toBe("fica_or_other_excluded");
  });

  it("an unrecognized label falls through to unrecognized", () => {
    expect(classifyTaxBreakdownLabel("Local Tax")).toBe("unrecognized");
  });
});

// ── classifyAdditionalWithholdingLabel ─────────────────────────────────────────

describe("classifyAdditionalWithholdingLabel", () => {
  it("real live label strings land in the correct bucket", () => {
    expect(classifyAdditionalWithholdingLabel("Federal Tax (Additional)")).toBe("federal");
    expect(classifyAdditionalWithholdingLabel("State Tax (Additional)")).toBe("state_ct");
  });

  it("an unrecognized label falls through to unrecognized", () => {
    expect(classifyAdditionalWithholdingLabel("Local Tax (Additional)")).toBe("unrecognized");
  });
});

// ── sumPaystubWithholding ───────────────────────────────────────────────────────

describe("sumPaystubWithholding", () => {
  // Shaped exactly like the two real live paystubs found in the investigation.
  const paystubA: PaystubWithholdingInput = {
    id: "paystub-a",
    payDate: d("2026-08-28"),
    extractStatus: "complete",
    taxBreakdown: [
      { label: "Federal Income Tax", amountCents: 400000 },
      { label: "Social Security", amountCents: 50000 },
      { label: "Medicare", amountCents: 20000 },
      { label: "Connecticut State Income Tax", amountCents: 150000 },
      { label: "Connecticut Paid Family", amountCents: 5000 },
    ],
    additionalWithholding: [
      { label: "Federal Tax (Additional)", amountCents: 10000 },
      { label: "State Tax (Additional)", amountCents: 5000 },
    ],
  };
  const paystubB: PaystubWithholdingInput = {
    id: "paystub-b",
    payDate: d("2026-08-31"),
    extractStatus: "complete",
    taxBreakdown: [
      { label: "Social Security", amountCents: 51000 },
      { label: "Medicare", amountCents: 21000 },
      { label: "Federal Income Tax", amountCents: 410000 },
      { label: "CT Income Tax", amountCents: 160000 },
      { label: "CT PFML", amountCents: 5100 },
    ],
    additionalWithholding: [],
  };

  it("sums both real fixtures correctly by category, for their real tax year", () => {
    const result = sumPaystubWithholding([paystubA, paystubB], 2026);
    expect(result.paystubsIncluded).toBe(2);
    expect(result.federalWithholdingCents).toBe(400000 + 10000 + 410000);
    expect(result.ctWithholdingCents).toBe(150000 + 5000 + 160000);
    expect(result.unrecognizedLabels).toEqual([]);
  });

  it("a paystub dated outside taxYear is excluded", () => {
    const result = sumPaystubWithholding([paystubA, paystubB], 2025);
    expect(result.paystubsIncluded).toBe(0);
    expect(result.federalWithholdingCents).toBe(0);
    expect(result.ctWithholdingCents).toBe(0);
  });

  it("extractStatus !== 'complete' is excluded", () => {
    const pending: PaystubWithholdingInput = { ...paystubA, extractStatus: "pending" };
    const result = sumPaystubWithholding([pending], 2026);
    expect(result.paystubsIncluded).toBe(0);
  });

  it("an unrecognized label is excluded from both sums and appears in unrecognizedLabels", () => {
    const withUnrecognized: PaystubWithholdingInput = {
      ...paystubA,
      taxBreakdown: [
        ...(paystubA.taxBreakdown as { label: string; amountCents: number }[]),
        { label: "Local Tax", amountCents: 1234 },
      ],
    };
    const result = sumPaystubWithholding([withUnrecognized], 2026);
    expect(result.unrecognizedLabels).toEqual([{ paystubId: "paystub-a", label: "Local Tax", amountCents: 1234 }]);
    // Federal/CT sums unaffected by the unrecognized entry.
    expect(result.federalWithholdingCents).toBe(400000 + 10000);
    expect(result.ctWithholdingCents).toBe(150000 + 5000);
  });
});

// ── findUnparseableExtractions ───────────────────────────────────────────────────

describe("findUnparseableExtractions", () => {
  it("flags a document shaped exactly like the real mistagged Pennymac-as-w2 case", () => {
    const docs = [
      {
        id: "doc-1",
        docType: "w2",
        taxYear: 2025,
        extractionStatus: "complete",
        extractionData: {
          docType: "other",
          summary: "Could not parse extraction response.",
          data: { raw: "This document is a Form 1098 ... It cannot be extracted into the requested W-2 JSON schema..." },
        },
      },
    ];
    expect(findUnparseableExtractions(docs)).toEqual([{ id: "doc-1", docType: "w2", taxYear: 2025 }]);
  });

  it("a normal complete W2 extraction is not flagged", () => {
    const docs = [
      {
        id: "doc-2",
        docType: "w2",
        taxYear: 2025,
        extractionStatus: "complete",
        extractionData: { docType: "w2", summary: "W-2 for Eric", data: { wagesCents: 18616026 } },
      },
    ];
    expect(findUnparseableExtractions(docs)).toEqual([]);
  });

  it("a summary match with extractionStatus !== 'complete' is not flagged", () => {
    const docs = [
      {
        id: "doc-3",
        docType: "w2",
        taxYear: 2025,
        extractionStatus: "failed",
        extractionData: { docType: "other", summary: "Could not parse extraction response.", data: {} },
      },
    ];
    expect(findUnparseableExtractions(docs)).toEqual([]);
  });
});

// ── sumW2Documents ───────────────────────────────────────────────────────────────

describe("sumW2Documents", () => {
  const w2Eric: W2DocInput = {
    id: "w2-eric",
    docType: "w2",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: {
      docType: "w2",
      summary: "W-2",
      data: {
        employerName: "Rippling PEO",
        wagesCents: 18616026,
        federalWithheldCents: 4095831,
        stateWithheldCents: 1112390,
        medicareWagesCents: 18616026,
      },
    },
  };
  const w2Eva: W2DocInput = {
    id: "w2-eva",
    docType: "w2",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: {
      docType: "w2",
      summary: "W-2",
      data: {
        employerName: "Seacoast Mushrooms",
        wagesCents: 4330900,
        federalWithheldCents: 420203,
        stateWithheldCents: 194513,
        medicareWagesCents: 4330900,
      },
    },
  };

  it("multiple valid W2s summed correctly", () => {
    const result = sumW2Documents([w2Eric, w2Eva], 2025);
    expect(result.wagesCents).toBe(18616026 + 4330900);
    expect(result.federalWithheldCents).toBe(4095831 + 420203);
    expect(result.ctWithheldCents).toBe(1112390 + 194513);
    expect(result.medicareWagesCents).toBe(18616026 + 4330900);
    expect(result.includedDocs).toHaveLength(2);
    expect(result.unusableDocs).toHaveLength(0);
  });

  it("a doc with a different taxYear is excluded", () => {
    const wrongYear: W2DocInput = { ...w2Eva, id: "w2-2026", taxYear: 2026 };
    const result = sumW2Documents([wrongYear], 2025);
    expect(result.wagesCents).toBe(0);
    expect(result.includedDocs).toHaveLength(0);
  });

  it("an incomplete-status doc is excluded", () => {
    const pending: W2DocInput = { ...w2Eva, id: "w2-pending", extractionStatus: "pending" };
    const result = sumW2Documents([pending], 2025);
    expect(result.wagesCents).toBe(0);
    expect(result.unusableDocs).toHaveLength(0);
  });

  it("a doc whose extractionData.data has no numeric wagesCents is pushed to unusableDocs, never counted as $0", () => {
    // The real mistagged-1098-as-w2 shape.
    const mistagged: W2DocInput = {
      id: "mistagged-1098",
      docType: "w2",
      taxYear: 2025,
      extractionStatus: "complete",
      extractionData: {
        docType: "other",
        summary: "Could not parse extraction response.",
        data: { raw: "This document is a Form 1098..." },
      },
    };
    const result = sumW2Documents([mistagged], 2025);
    expect(result.wagesCents).toBe(0);
    expect(result.includedDocs).toHaveLength(0);
    expect(result.unusableDocs).toEqual([
      {
        id: "mistagged-1098",
        reason:
          "extraction has no numeric wagesCents — likely a mistagged/garbled document; excluded, never counted as $0",
      },
    ]);
  });
});

// ── sum1099InterestIncome ─────────────────────────────────────────────────────────

describe("sum1099InterestIncome", () => {
  const int1099: Doc1099Input = {
    id: "1099-td",
    docType: "1099",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: {
      docType: "1099",
      summary: "1099-INT",
      data: { formVariant: "1099-INT", payerName: "TD Bank", amountCents: 112432 },
    },
  };
  const div1099: Doc1099Input = {
    id: "1099-rh",
    docType: "1099",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: {
      docType: "1099",
      summary: "1099-DIV",
      data: { formVariant: "1099-DIV", payerName: "Robinhood", amountCents: 358 },
    },
  };

  it("a 1099-INT doc is summed into interestIncomeCents", () => {
    const result = sum1099InterestIncome([int1099], 2025);
    expect(result.interestIncomeCents).toBe(112432);
    expect(result.includedDocs).toEqual([{ id: "1099-td", payerName: "TD Bank", amountCents: 112432 }]);
  });

  it("a 1099-DIV doc is excluded and pushed to excludedNonInterestDocs", () => {
    const result = sum1099InterestIncome([div1099], 2025);
    expect(result.interestIncomeCents).toBe(0);
    expect(result.excludedNonInterestDocs).toEqual([{ id: "1099-rh", formVariant: "1099-DIV", amountCents: 358 }]);
  });

  it("a wrong-taxYear doc is excluded", () => {
    const wrongYear: Doc1099Input = { ...int1099, taxYear: 2026 };
    const result = sum1099InterestIncome([wrongYear], 2025);
    expect(result.interestIncomeCents).toBe(0);
  });
});

// ── sumItemizedDocInputs ───────────────────────────────────────────────────────────

describe("sumItemizedDocInputs", () => {
  it("0 mortgage_interest docs -> $0 + the '0 docs' note", () => {
    const result = sumItemizedDocInputs([], 2025);
    expect(result.mortgageInterestCents).toBe(0);
    expect(result.mortgageInterestDocCount).toBe(0);
    expect(result.notes.some((n) => n.includes("0 mortgage_interest documents"))).toBe(true);
  });

  it("1+ mortgage_interest docs -> summed + the standing monthly-vs-annual ambiguity note", () => {
    const docs: ItemizedDocInput[] = [
      {
        id: "1098-pennymac",
        docType: "mortgage_interest",
        taxYear: 2025,
        extractionStatus: "complete",
        extractionData: { docType: "mortgage_statement", summary: "1098", data: { interestCents: 3000000 } },
      },
    ];
    const result = sumItemizedDocInputs(docs, 2025);
    expect(result.mortgageInterestCents).toBe(3000000);
    expect(result.mortgageInterestDocCount).toBe(1);
    expect(result.notes.some((n) => n.includes("monthly-statement-vs-annual-1098"))).toBe(true);
  });

  it("property_tax docs, any count including 0, -> always $0 + a note distinguishing the reason", () => {
    const zeroDocsResult = sumItemizedDocInputs([], 2025);
    expect(zeroDocsResult.propertyTaxCents).toBe(0);
    expect(zeroDocsResult.notes.some((n) => n.includes("0 property_tax documents"))).toBe(true);

    const withDocs: ItemizedDocInput[] = [
      {
        id: "prop-tax-1",
        docType: "property_tax",
        taxYear: 2025,
        extractionStatus: "complete",
        extractionData: { docType: "other", summary: "Property tax bill", data: {} },
      },
    ];
    const withDocsResult = sumItemizedDocInputs(withDocs, 2025);
    expect(withDocsResult.propertyTaxCents).toBe(0);
    expect(withDocsResult.propertyTaxDocCount).toBe(1);
    expect(withDocsResult.notes.some((n) => n.includes("never yields a numeric field"))).toBe(true);
  });
});

// ── parseDollarAnswerToCents ─────────────────────────────────────────────────────

describe("parseDollarAnswerToCents", () => {
  it("'12000' -> 1,200,000 cents", () => {
    expect(parseDollarAnswerToCents("12000", null)).toEqual({ cents: 1200000, unparseable: false });
  });

  it("'$12,000' -> 1,200,000 cents", () => {
    expect(parseDollarAnswerToCents("$12,000", null)).toEqual({ cents: 1200000, unparseable: false });
  });

  it("'12,000.50' -> 1,200,050 cents", () => {
    expect(parseDollarAnswerToCents("12,000.50", null)).toEqual({ cents: 1200050, unparseable: false });
  });

  it("null answer -> {cents: null, unparseable: false}", () => {
    expect(parseDollarAnswerToCents(null, null)).toEqual({ cents: null, unparseable: false });
  });

  it("the real live 'skipped' shape -> {cents: null, unparseable: false}, not flagged as garbage", () => {
    expect(parseDollarAnswerToCents("skipped", "Skipped for now")).toEqual({ cents: null, unparseable: false });
  });

  it("'Yes' with no skippedReason -> {cents: null, unparseable: true}", () => {
    expect(parseDollarAnswerToCents("Yes", null)).toEqual({ cents: null, unparseable: true });
  });
});

// ── parseSqftAnswer ───────────────────────────────────────────────────────────────

describe("parseSqftAnswer", () => {
  it("'180' -> 180", () => {
    expect(parseSqftAnswer("180", null)).toEqual({ sqft: 180, unparseable: false });
  });

  it("'180 sq ft' -> 180", () => {
    expect(parseSqftAnswer("180 sq ft", null)).toEqual({ sqft: 180, unparseable: false });
  });

  it("'large' -> unparseable", () => {
    expect(parseSqftAnswer("large", null)).toEqual({ sqft: null, unparseable: true });
  });

  it("null -> not answered", () => {
    expect(parseSqftAnswer(null, null)).toEqual({ sqft: null, unparseable: false });
  });
});

// ── resolveHomeOfficeSqft ───────────────────────────────────────────────────────

describe("resolveHomeOfficeSqft", () => {
  it("'yes_exclusive' + valid sqft -> sqft returned, no note", () => {
    expect(resolveHomeOfficeSqft("yes_exclusive", "180", null)).toEqual({ sqft: 180, note: null });
  });

  it("'yes_exclusive' + no sqft answer -> null + 'eligible but not yet answered' note", () => {
    const result = resolveHomeOfficeSqft("yes_exclusive", null, null);
    expect(result.sqft).toBeNull();
    expect(result.note).toContain("not been answered yet");
  });

  it("'no' + a stray valid sqft answer -> null + 'not eligible, sqft ignored' note", () => {
    const result = resolveHomeOfficeSqft("no", "180", null);
    expect(result.sqft).toBeNull();
    expect(result.note).toContain("is ignored");
  });

  it("unanswered eligibility -> null + note", () => {
    const result = resolveHomeOfficeSqft(null, null, null);
    expect(result.sqft).toBeNull();
    expect(result.note).not.toBeNull();
  });
});

// ── resolvePersonalTaxComputeInput (end-to-end, pure) ───────────────────────────

describe("resolvePersonalTaxComputeInput", () => {
  const w2Eric: W2DocInput & Doc1099Input & ItemizedDocInput = {
    id: "w2-eric",
    docType: "w2",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: {
      docType: "w2",
      summary: "W-2",
      data: {
        employerName: "Rippling PEO",
        wagesCents: 18616026,
        federalWithheldCents: 4095831,
        stateWithheldCents: 1112390,
        medicareWagesCents: 18616026,
      },
    },
  };
  const w2Eva: W2DocInput & Doc1099Input & ItemizedDocInput = {
    id: "w2-eva",
    docType: "w2",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: {
      docType: "w2",
      summary: "W-2",
      data: {
        employerName: "Seacoast Mushrooms",
        wagesCents: 4330900,
        federalWithheldCents: 420203,
        stateWithheldCents: 194513,
        medicareWagesCents: 4330900,
      },
    },
  };
  // Real mistagged-1098-as-w2 shape.
  const unusableW2: W2DocInput & Doc1099Input & ItemizedDocInput = {
    id: "mistagged-1098",
    docType: "w2",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: {
      docType: "other",
      summary: "Could not parse extraction response.",
      data: { raw: "This document is a Form 1098..." },
    },
  };
  const int1099: W2DocInput & Doc1099Input & ItemizedDocInput = {
    id: "1099-td",
    docType: "1099",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: {
      docType: "1099",
      summary: "1099-INT",
      data: { formVariant: "1099-INT", payerName: "TD Bank", amountCents: 112432 },
    },
  };
  const div1099: W2DocInput & Doc1099Input & ItemizedDocInput = {
    id: "1099-rh",
    docType: "1099",
    taxYear: 2025,
    extractionStatus: "complete",
    extractionData: {
      docType: "1099",
      summary: "1099-DIV",
      data: { formVariant: "1099-DIV", payerName: "Robinhood", amountCents: 358 },
    },
  };

  const BASE_RAW: RawPersonalTaxComputeInput = {
    taxYear: 2025,
    personalDocuments: [w2Eric, w2Eva, unusableW2, int1099, div1099],
    paystubs: [],
    taxQuestions: [
      { key: "retirement_contributions", answer: "skipped", skippedReason: "Skipped for now" },
      { key: "estimated_taxes_2025", answer: "Yes", skippedReason: null },
      { key: "home_office_ekc", answer: "yes_exclusive", skippedReason: null },
      // no retirement_contribution_amount / estimated_tax_payments_amount / home_office_sqft answers yet
    ],
    mileageEntries: [],
    ekConsultingGlIncomeTotal: new Decimal(0),
    ekConsultingGlExpenseTotal: new Decimal(0),
  };

  it("real-shaped fixture: exact ComputePersonalTaxReturnInput fields + every expected buildGaps entry + scheduleCDataMissing true", () => {
    const result = resolvePersonalTaxComputeInput(BASE_RAW);

    expect(result.input.wages.toString()).toBe(new Decimal(18616026 + 4330900).div(100).toString());
    expect(result.input.interestIncome.toString()).toBe(new Decimal(112432).div(100).toString());
    expect(result.input.federalWithholdingCents).toBe(4095831 + 420203);
    expect(result.input.ctWithholdingCents).toBe(1112390 + 194513);
    expect(result.input.ctIncomeTaxWithheldCents).toBe(1112390 + 194513);
    expect(result.input.mortgageInterestCents).toBe(0);
    expect(result.input.propertyTaxCents).toBe(0);
    expect(result.input.homeOfficeSqft).toBeNull();
    expect(result.input.estimatedPaymentsCents).toBeNull();
    expect(result.input.charitableCents).toBeNull();
    expect(result.input.glIncomeTotal.isZero()).toBe(true);
    expect(result.input.glExpenseTotal.isZero()).toBe(true);

    expect(result.scheduleCDataMissing).toBe(true);

    const gaps = result.buildGaps.join("\n");
    expect(gaps).toContain("mistagged-1098"); // unusable-W2 note
    expect(gaps).toContain("1099-rh"); // excluded-1099-DIV note
    expect(gaps).toContain("0 mortgage_interest documents"); // zero-mortgage-docs note
    expect(gaps).toContain("0 property_tax documents"); // zero-property-tax note
    expect(gaps).toContain("retirement contribution amount not yet answered"); // unanswered-retirement note
    // estimated_tax_payments_amount was never answered (not "Yes" — that's the
    // unrelated narrative question) -> resolves the same as unanswered, not
    // unparseable, since no answer at all exists for the new structured key.
    expect(gaps).toContain("estimated tax payments amount not yet answered");
    expect(gaps).toContain("not been answered yet"); // eligible-but-no-sqft note
    expect(gaps).toContain("EK Consulting LLC has zero GL-coded transactions"); // scheduleCDataMissing message
  });

  it("home_office_sqft answered + nonzero EKC GL totals -> sqft used, scheduleCDataMissing false, message absent", () => {
    const raw: RawPersonalTaxComputeInput = {
      ...BASE_RAW,
      taxQuestions: [...BASE_RAW.taxQuestions, { key: "home_office_sqft", answer: "180", skippedReason: null }],
      ekConsultingGlIncomeTotal: new Decimal(50000),
      ekConsultingGlExpenseTotal: new Decimal(10000),
    };
    const result = resolvePersonalTaxComputeInput(raw);

    expect(result.input.homeOfficeSqft).toBe(180);
    expect(result.scheduleCDataMissing).toBe(false);
    expect(result.buildGaps.some((g) => g.includes("EK Consulting LLC has zero GL-coded transactions"))).toBe(false);
  });

  it("an unparseable estimated_tax_payments_amount answer is flagged as unparseable, not silently unanswered", () => {
    const raw: RawPersonalTaxComputeInput = {
      ...BASE_RAW,
      taxQuestions: [
        ...BASE_RAW.taxQuestions,
        { key: "estimated_tax_payments_amount", answer: "some amount", skippedReason: null },
      ],
    };
    const result = resolvePersonalTaxComputeInput(raw);
    expect(result.input.estimatedPaymentsCents).toBeNull();
    expect(result.buildGaps.some((g) => g.includes("could not be parsed as a plain dollar figure"))).toBe(true);
  });
});
