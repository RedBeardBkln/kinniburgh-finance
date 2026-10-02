import { describe, it, expect } from "vitest";
import {
  computePersonalFormPlan,
  computePersonalFormPlanBasis,
  type PersonalFormPlanInput,
} from "@/lib/tax-form-plan";
import { PERSONAL_FORM_PLAN } from "@/lib/tax-guidance";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EMPTY_INPUT: PersonalFormPlanInput = {
  documents: [],
  questions: [],
  ekConsultingPL: null,
  suddenValleyPL: null,
  ekConsultingMileageCount: 0,
  solarLoanOriginalCostCents: null,
};

/** Every document type present, extraction complete, every relevant numeric field set. */
const GOLDEN_DOCUMENTS: PersonalFormPlanInput["documents"] = [
  {
    docType: "w2",
    extractionStatus: "complete",
    extractionData: {
      docType: "w2",
      summary: "W-2",
      data: { wagesCents: 15000000, federalWithheldCents: 2000000, stateWithheldCents: 500000 },
    },
  },
  {
    docType: "1099",
    extractionStatus: "complete",
    extractionData: {
      docType: "1099",
      summary: "1099-INT",
      data: { formVariant: "1099-INT", amountCents: 12000 },
    },
  },
  {
    docType: "mortgage_interest",
    extractionStatus: "complete",
    extractionData: {
      docType: "mortgage_statement",
      summary: "Mortgage statement",
      data: { interestCents: 3000000 },
    },
  },
  {
    // Pass 3: property-tax lines read the owner-entered amount paid in the tax year.
    docType: "property_tax",
    extractionStatus: "complete",
    extractionData: { docType: "property_tax", summary: "Property tax bill", data: { paidInTaxYearCents: 650000 } },
  },
];

const GOLDEN_QUESTIONS: PersonalFormPlanInput["questions"] = [
  { key: "retirement_contributions", answer: "Eric 401k $12,000", skippedReason: null },
  { key: "home_office_ekc", answer: "yes_exclusive", skippedReason: null },
  { key: "filing_status", answer: "mfj", skippedReason: null },
  { key: "estimated_taxes_2025", answer: "Paid Q1-Q4", skippedReason: null },
  { key: "solar_credit", answer: "yes_unclaimed", skippedReason: null },
  { key: "ev_vehicle", answer: "no", skippedReason: null },
  { key: "household_members", answer: "children", skippedReason: null },
];

const GOLDEN_PL = {
  incomeLines: [{ code: "4000" }],
  expenseLines: [{ code: "5030" }, { code: "5040" }],
};

const GOLDEN_INPUT: PersonalFormPlanInput = {
  documents: GOLDEN_DOCUMENTS,
  questions: GOLDEN_QUESTIONS,
  ekConsultingPL: GOLDEN_PL,
  suddenValleyPL: GOLDEN_PL,
  ekConsultingMileageCount: 42,
  solarLoanOriginalCostCents: 11580297,
};

const ALWAYS_FALSE_LINES = [
  "Gifts to charity (line 11)",
  "Depreciation (line 13)",
  "Depreciation (line 18)",
];

function flatten(forms: ReturnType<typeof computePersonalFormPlan>) {
  return forms.flatMap((f) => f.fields.map((field) => ({ ...field, formName: f.formName })));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("computePersonalFormPlan", () => {
  it("returns 6 forms / 24 fields", () => {
    const result = computePersonalFormPlan(EMPTY_INPUT);
    expect(result.length).toBe(6);
    expect(flatten(result).length).toBe(24);
  });

  it("all-empty input produces haveData: false for every field", () => {
    const result = computePersonalFormPlan(EMPTY_INPUT);
    for (const field of flatten(result)) {
      expect(field.haveData).toBe(false);
    }
  });

  it("golden path: every field true except the 3 permanently-false ones", () => {
    const result = computePersonalFormPlan(GOLDEN_INPUT);
    for (const field of flatten(result)) {
      if (ALWAYS_FALSE_LINES.includes(field.line)) {
        expect(field.haveData).toBe(false);
      } else {
        expect(field.haveData, `expected ${field.line} to be true`).toBe(true);
      }
    }
  });

  it("permanently-false fields stay false even in the maximally-populated fixture", () => {
    const result = computePersonalFormPlan(GOLDEN_INPUT);
    const byLine = new Map(flatten(result).map((f) => [f.line, f.haveData]));
    for (const line of ALWAYS_FALSE_LINES) {
      expect(byLine.get(line)).toBe(false);
    }
  });

  it("shell fidelity: formName/purpose/whereToGet/line/source match PERSONAL_FORM_PLAN exactly", () => {
    const result = computePersonalFormPlan(EMPTY_INPUT);
    expect(result.length).toBe(PERSONAL_FORM_PLAN.length);
    result.forEach((form, i) => {
      const expected = PERSONAL_FORM_PLAN[i];
      expect(expected).toBeDefined();
      if (!expected) return;
      expect(form.formName).toBe(expected.formName);
      expect(form.purpose).toBe(expected.purpose);
      expect(form.whereToGet).toBe(expected.whereToGet);
      expect(form.fields.length).toBe(expected.fields.length);
      form.fields.forEach((field, j) => {
        const expectedField = expected.fields[j];
        expect(expectedField).toBeDefined();
        if (!expectedField) return;
        expect(field.line).toBe(expectedField.line);
        expect(field.source).toBe(expectedField.source);
      });
    });
  });

  it("does not mutate PERSONAL_FORM_PLAN", () => {
    computePersonalFormPlan(GOLDEN_INPUT);
    for (const form of PERSONAL_FORM_PLAN) {
      for (const field of form.fields) {
        expect(field.haveData).toBe(false);
      }
    }
  });

  // ── Wage/withholding: extraction status gates the fact ──────────────────────

  it("a w2 doc with extractionStatus 'processing' keeps wage fields false", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      documents: [
        {
          docType: "w2",
          extractionStatus: "processing",
          extractionData: { docType: "w2", summary: "", data: { wagesCents: 15000000 } },
        },
      ],
    };
    const result = computePersonalFormPlan(input);
    const wages = flatten(result).find((f) => f.line === "Wages (line 1a)");
    expect(wages?.haveData).toBe(false);
  });

  it("a w2 doc with extractionStatus 'failed' keeps wage fields false", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      documents: [
        {
          docType: "w2",
          extractionStatus: "failed",
          extractionData: { docType: "w2", summary: "", data: { wagesCents: 15000000 } },
        },
      ],
    };
    const result = computePersonalFormPlan(input);
    const wages = flatten(result).find((f) => f.line === "Wages (line 1a)");
    expect(wages?.haveData).toBe(false);
  });

  it("a complete w2 doc flips only Wages (line 1a), not other fields", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      documents: [
        {
          docType: "w2",
          extractionStatus: "complete",
          extractionData: { docType: "w2", summary: "", data: { wagesCents: 15000000 } },
        },
      ],
    };
    const result = computePersonalFormPlan(input);
    const fields = flatten(result);
    for (const field of fields) {
      if (field.line === "Wages (line 1a)") {
        expect(field.haveData).toBe(true);
      } else {
        expect(field.haveData, `expected ${field.line} to stay false`).toBe(false);
      }
    }
  });

  it("null-safe extraction data: wagesCents: null keeps hasW2Wages false", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      documents: [
        {
          docType: "w2",
          extractionStatus: "complete",
          extractionData: { docType: "w2", summary: "", data: { wagesCents: null } },
        },
      ],
    };
    const result = computePersonalFormPlan(input);
    const wages = flatten(result).find((f) => f.line === "Wages (line 1a)");
    expect(wages?.haveData).toBe(false);
  });

  // ── 1099 variant discrimination ──────────────────────────────────────────────

  it("a 1099-DIV doc leaves Interest income false", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      documents: [
        {
          docType: "1099",
          extractionStatus: "complete",
          extractionData: {
            docType: "1099",
            summary: "",
            data: { formVariant: "1099-DIV", amountCents: 5000 },
          },
        },
      ],
    };
    const result = computePersonalFormPlan(input);
    const interest = flatten(result).find((f) => f.line === "Interest income (line 2b)");
    expect(interest?.haveData).toBe(false);
  });

  it("a 1099-INT doc with numeric amountCents flips Interest income true", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      documents: [
        {
          docType: "1099",
          extractionStatus: "complete",
          extractionData: {
            docType: "1099",
            summary: "",
            data: { formVariant: "1099-INT", amountCents: 5000 },
          },
        },
      ],
    };
    const result = computePersonalFormPlan(input);
    const interest = flatten(result).find((f) => f.line === "Interest income (line 2b)");
    expect(interest?.haveData).toBe(true);
  });

  // ── property_tax: only an owner-entered "paid in the tax year" amount counts (pass 3) ──

  it("a property_tax doc with empty data:{} (legacy / bill only) no longer makes its lines 'have data'", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      documents: [
        {
          docType: "property_tax",
          extractionStatus: "complete",
          extractionData: { docType: "other", summary: "Property tax bill", data: {} },
        },
      ],
    };
    const fields = flatten(computePersonalFormPlan(input));
    expect(fields.find((f) => f.line === "State/local taxes (line 5e)")?.haveData).toBe(false);
    expect(fields.find((f) => f.line === "Property tax credit")?.haveData).toBe(false);
    expect(fields.find((f) => f.line === "Standard or itemized (line 12)")?.haveData).toBe(false);
  });

  it("a property_tax doc with an effective paidInTaxYearCents flips its dependent fields", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      documents: [
        {
          docType: "property_tax",
          extractionStatus: "complete",
          extractionData: {
            docType: "property_tax",
            summary: "",
            data: { totalTaxBilledCents: 900000, paidInTaxYearCents: 450000 },
          },
        },
      ],
    };
    const fields = flatten(computePersonalFormPlan(input));
    expect(fields.find((f) => f.line === "State/local taxes (line 5e)")?.haveData).toBe(true);
    expect(fields.find((f) => f.line === "Property tax credit")?.haveData).toBe(true);
    // Standard/itemized needs BOTH the paid property tax AND mortgage interest
    expect(fields.find((f) => f.line === "Standard or itemized (line 12)")?.haveData).toBe(false);
  });

  it("property tax paid + mortgage_interest complete together flip Standard or itemized true", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      documents: [
        {
          docType: "property_tax",
          extractionStatus: "complete",
          extractionData: { docType: "property_tax", summary: "", data: { paidInTaxYearCents: 450000 } },
        },
        {
          docType: "mortgage_interest",
          extractionStatus: "complete",
          extractionData: { docType: "mortgage_statement", summary: "", data: { interestCents: 3000000 } },
        },
      ],
    };
    const result = computePersonalFormPlan(input);
    const field = flatten(result).find((f) => f.line === "Standard or itemized (line 12)");
    expect(field?.haveData).toBe(true);
  });

  // ── 1099 interest box 1 (pass 3) ──────────────────────────────────────────────

  it("a current-schema 1099 with int_box1Cents counts as interest even when the variant is consolidated", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      documents: [
        {
          docType: "1099",
          extractionStatus: "complete",
          extractionData: { docType: "1099", summary: "", data: { formVariant: "consolidated", int_box1Cents: 4200 } },
        },
      ],
    };
    const interest = flatten(computePersonalFormPlan(input)).find((f) => f.line === "Interest income (line 2b)");
    expect(interest?.haveData).toBe(true);
  });

  // ── Skipped vs answered vs unanswered questions ──────────────────────────────

  it("a skipped question (answer + skippedReason set) is treated as NOT answered", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      questions: [{ key: "home_office_ekc", answer: "yes_exclusive", skippedReason: "Skipped for now" }],
    };
    const result = computePersonalFormPlan(input);
    const field = flatten(result).find((f) => f.line === "Home office (line 30)");
    expect(field?.haveData).toBe(false);
  });

  it("a real non-null answer with no skippedReason is treated as answered", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      questions: [{ key: "home_office_ekc", answer: "yes_exclusive", skippedReason: null }],
    };
    const result = computePersonalFormPlan(input);
    const field = flatten(result).find((f) => f.line === "Home office (line 30)");
    expect(field?.haveData).toBe(true);
  });

  it("a question absent from the array is treated as unanswered", () => {
    const result = computePersonalFormPlan(EMPTY_INPUT);
    const field = flatten(result).find((f) => f.line === "Home office (line 30)");
    expect(field?.haveData).toBe(false);
  });

  // ── null PL entities ──────────────────────────────────────────────────────────

  it("ekConsultingPL: null and suddenValleyPL: null keep business/rental fields false, no throw", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      ekConsultingPL: null,
      suddenValleyPL: null,
    };
    expect(() => computePersonalFormPlan(input)).not.toThrow();
    const result = computePersonalFormPlan(input);
    const fields = flatten(result);
    expect(fields.find((f) => f.line === "Business income (Schedule 1)")?.haveData).toBe(false);
    expect(fields.find((f) => f.line === "Gross receipts (line 1)")?.haveData).toBe(false);
    expect(fields.find((f) => f.line === "Rental income (Schedule 1)")?.haveData).toBe(false);
    expect(fields.find((f) => f.line === "Rents received (line 3)")?.haveData).toBe(false);
    expect(fields.find((f) => f.line === "Taxes (line 16)")?.haveData).toBe(false);
    expect(fields.find((f) => f.line === "Insurance (line 15)")?.haveData).toBe(false);
  });

  // ── GL-code cross-contamination ───────────────────────────────────────────────

  it("Sudden Valley expenseLines with only '5040' flips Taxes true, Insurance stays false", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      suddenValleyPL: { incomeLines: [], expenseLines: [{ code: "5040" }] },
    };
    const result = computePersonalFormPlan(input);
    const fields = flatten(result);
    expect(fields.find((f) => f.line === "Taxes (line 16)")?.haveData).toBe(true);
    expect(fields.find((f) => f.line === "Insurance (line 15)")?.haveData).toBe(false);
  });

  it("Sudden Valley expenseLines with only '5030' flips Insurance true, Taxes stays false", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      suddenValleyPL: { incomeLines: [], expenseLines: [{ code: "5030" }] },
    };
    const result = computePersonalFormPlan(input);
    const fields = flatten(result);
    expect(fields.find((f) => f.line === "Insurance (line 15)")?.haveData).toBe(true);
    expect(fields.find((f) => f.line === "Taxes (line 16)")?.haveData).toBe(false);
  });

  it("EK Consulting's own '5030' code (Home Office) never drives Sudden Valley's Insurance field", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      ekConsultingPL: { incomeLines: [], expenseLines: [{ code: "5030" }] },
      suddenValleyPL: null,
    };
    const result = computePersonalFormPlan(input);
    const field = flatten(result).find((f) => f.line === "Insurance (line 15)");
    expect(field?.haveData).toBe(false);
  });

  // ── Solar cost boundary ────────────────────────────────────────────────────────

  it("solarLoanOriginalCostCents: 0 is treated as no data, same as null", () => {
    const zeroInput = { ...EMPTY_INPUT, solarLoanOriginalCostCents: 0 };
    const nullInput = { ...EMPTY_INPUT, solarLoanOriginalCostCents: null };
    const zeroResult = flatten(computePersonalFormPlan(zeroInput));
    const nullResult = flatten(computePersonalFormPlan(nullInput));
    for (const line of ["Qualified solar electric property cost (line 1)", "Credit (30%)"]) {
      expect(zeroResult.find((f) => f.line === line)?.haveData).toBe(false);
      expect(nullResult.find((f) => f.line === line)?.haveData).toBe(false);
    }
  });

  it("a positive solarLoanOriginalCostCents flips both Form 5695 fields true", () => {
    const input = { ...EMPTY_INPUT, solarLoanOriginalCostCents: 11580297 };
    const result = flatten(computePersonalFormPlan(input));
    expect(result.find((f) => f.line === "Qualified solar electric property cost (line 1)")?.haveData).toBe(
      true
    );
    expect(result.find((f) => f.line === "Credit (30%)")?.haveData).toBe(true);
  });

  // ── Credits (AND logic across 4 questions) ────────────────────────────────────

  it("Credits (lines 19-21) requires ALL 4 named questions answered, not just one", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      questions: [{ key: "solar_credit", answer: "yes_unclaimed", skippedReason: null }],
    };
    const result = flatten(computePersonalFormPlan(input));
    expect(result.find((f) => f.line === "Credits (lines 19-21)")?.haveData).toBe(false);
  });

  it("Credits (lines 19-21) is true once all 4 questions are answered", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      questions: [
        { key: "solar_credit", answer: "yes_unclaimed", skippedReason: null },
        { key: "ev_vehicle", answer: "no", skippedReason: null },
        { key: "household_members", answer: "none", skippedReason: null },
        { key: "retirement_contributions", answer: "none", skippedReason: null },
      ],
    };
    const result = flatten(computePersonalFormPlan(input));
    expect(result.find((f) => f.line === "Credits (lines 19-21)")?.haveData).toBe(true);
  });
});

// ── computePersonalFormPlanBasis (pass 3) ────────────────────────────────────────

describe("computePersonalFormPlanBasis", () => {
  const w2 = (verified: boolean | undefined, wages = 1000000): PersonalFormPlanInput["documents"][number] => ({
    docType: "w2",
    extractionStatus: "complete",
    extractionData: { docType: "w2", summary: "", data: { wagesCents: wages, federalWithheldCents: 100000 } },
    verified,
  });

  it("has exactly the same keys as the plan and agrees with haveData (basis !== 'missing' <=> haveData)", () => {
    for (const input of [EMPTY_INPUT, GOLDEN_INPUT]) {
      const plan = computePersonalFormPlan(input);
      const basis = computePersonalFormPlanBasis(input);
      for (const form of plan) {
        for (const field of form.fields) {
          expect(basis[field.line], field.line).toBeDefined();
          expect(basis[field.line] !== "missing", field.line).toBe(field.haveData);
        }
      }
    }
  });

  it("all-empty input: every line is missing", () => {
    const basis = computePersonalFormPlanBasis(EMPTY_INPUT);
    expect(Object.values(basis).every((b) => b === "missing")).toBe(true);
  });

  it("a verified W-2 makes its lines 'verified'; an unverified or flag-less one 'unverified'", () => {
    const verified = computePersonalFormPlanBasis({ ...EMPTY_INPUT, documents: [w2(true)] });
    expect(verified["Wages (line 1a)"]).toBe("verified");
    expect(verified["Payments/withholding (line 25)"]).toBe("verified");
    const unverified = computePersonalFormPlanBasis({ ...EMPTY_INPUT, documents: [w2(false)] });
    expect(unverified["Wages (line 1a)"]).toBe("unverified");
    const noFlag = computePersonalFormPlanBasis({ ...EMPTY_INPUT, documents: [w2(undefined)] });
    expect(noFlag["Wages (line 1a)"]).toBe("unverified");
  });

  it("a line aggregating several documents is verified only if EVERY contributing document is verified", () => {
    const mixed = computePersonalFormPlanBasis({ ...EMPTY_INPUT, documents: [w2(true), w2(false, 500000)] });
    expect(mixed["Wages (line 1a)"]).toBe("unverified");
    const allVerified = computePersonalFormPlanBasis({ ...EMPTY_INPUT, documents: [w2(true), w2(true, 500000)] });
    expect(allVerified["Wages (line 1a)"]).toBe("verified");
  });

  it("answers/books/mileage-fed lines are not_document_based, never verified/unverified", () => {
    const basis = computePersonalFormPlanBasis(GOLDEN_INPUT);
    expect(basis["Home office (line 30)"]).toBe("not_document_based");
    expect(basis["Business income (Schedule 1)"]).toBe("not_document_based");
    expect(basis["Car and truck expenses (line 9)"]).toBe("not_document_based");
    expect(basis["Gifts to charity (line 11)"]).toBe("missing");
  });

  it("Payments/withholding falls back to the estimated-payments answer when no W-2 withholding exists", () => {
    const basis = computePersonalFormPlanBasis({
      ...EMPTY_INPUT,
      questions: [{ key: "estimated_taxes_2025", answer: "Paid Q1-Q4", skippedReason: null }],
    });
    expect(basis["Payments/withholding (line 25)"]).toBe("not_document_based");
  });

  it("Standard or itemized aggregates the mortgage and property-tax documents", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      documents: [
        {
          docType: "mortgage_interest",
          extractionStatus: "complete",
          extractionData: { data: { interestCents: 3000000 } },
          verified: true,
        },
        {
          docType: "property_tax",
          extractionStatus: "complete",
          extractionData: { data: { paidInTaxYearCents: 450000 } },
          verified: false,
        },
      ],
    };
    const basis = computePersonalFormPlanBasis(input);
    expect(basis["Home mortgage interest (line 8a)"]).toBe("verified");
    expect(basis["State/local taxes (line 5e)"]).toBe("unverified");
    expect(basis["Standard or itemized (line 12)"]).toBe("unverified");
  });

  it("CT AGI is document-based only when wages (not the books) supply it", () => {
    const answers = [{ key: "filing_status", answer: "mfj", skippedReason: null }];
    const viaBooks = computePersonalFormPlanBasis({
      ...EMPTY_INPUT,
      questions: answers,
      ekConsultingPL: { incomeLines: [{ code: "4000" }], expenseLines: [] },
    });
    expect(viaBooks["CT adjusted gross income"]).toBe("not_document_based");
    const viaWages = computePersonalFormPlanBasis({ ...EMPTY_INPUT, questions: answers, documents: [w2(true)] });
    expect(viaWages["CT adjusted gross income"]).toBe("verified");
  });

  it("does not change computePersonalFormPlan's own output", () => {
    const before = JSON.stringify(computePersonalFormPlan(GOLDEN_INPUT));
    computePersonalFormPlanBasis(GOLDEN_INPUT);
    expect(JSON.stringify(computePersonalFormPlan(GOLDEN_INPUT))).toBe(before);
  });
});
