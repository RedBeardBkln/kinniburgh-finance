import { describe, it, expect } from "vitest";
import { computePersonalFormPlan, type PersonalFormPlanInput } from "@/lib/tax-form-plan";
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
    docType: "property_tax",
    extractionStatus: "complete",
    extractionData: { docType: "other", summary: "Property tax bill", data: {} },
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

  // ── property_tax "processed but no numeric data" edge case ──────────────────

  it("a property_tax doc with empty data:{} is still 'processed' for its dependent fields", () => {
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
    const result = computePersonalFormPlan(input);
    const fields = flatten(result);
    expect(fields.find((f) => f.line === "State/local taxes (line 5e)")?.haveData).toBe(true);
    expect(fields.find((f) => f.line === "Property tax credit")?.haveData).toBe(true);
    // Standard/itemized needs BOTH property tax processed AND mortgage interest complete
    expect(fields.find((f) => f.line === "Standard or itemized (line 12)")?.haveData).toBe(false);
  });

  it("property_tax processed + mortgage_interest complete together flip Standard or itemized true", () => {
    const input: PersonalFormPlanInput = {
      ...EMPTY_INPUT,
      documents: [
        {
          docType: "property_tax",
          extractionStatus: "complete",
          extractionData: { docType: "other", summary: "Property tax bill", data: {} },
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
