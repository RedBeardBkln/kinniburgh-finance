// Pure computation of per-field data-availability (`haveData`) for the
// personal tax form-readiness plan. No DB import — the caller (the RSC page)
// fetches all raw data and hands it in already-resolved.
//
// This module clones `PERSONAL_FORM_PLAN` (the static shell/template of 6
// forms / 24 fields) and overwrites each field's `haveData` from real
// household data. It never computes an actual filled-in tax return, AGI, or
// liability figure — only a boolean data-availability signal per field
// (CLAUDE.md ground rule 8: drafts for a CPA, not tax advice).

import { PERSONAL_FORM_PLAN, type FormPlan } from "@/lib/tax-guidance";

export interface PersonalFormPlanDocumentInput {
  docType: string; // Document.docType raw value, e.g. "w2", "property_tax"
  extractionStatus: string | null; // Document.extractionStatus
  extractionData: unknown; // Document.extractionData JSON — cast internally
}

export interface PersonalFormPlanQuestionInput {
  key: string; // TaxQuestion.key
  answer: unknown; // TaxQuestion.answer (Json | null)
  skippedReason: string | null;
}

export interface PersonalFormPlanPLInput {
  incomeLines: { code: string }[];
  expenseLines: { code: string }[];
}

export interface PersonalFormPlanInput {
  documents: PersonalFormPlanDocumentInput[]; // this tax year's Documents for the PERSONAL entity only
  questions: PersonalFormPlanQuestionInput[]; // this TaxWorkspace's TaxQuestion rows
  ekConsultingPL: PersonalFormPlanPLInput | null; // null = entity lookup failed; treat as "no data"
  suddenValleyPL: PersonalFormPlanPLInput | null;
  ekConsultingMileageCount: number;
  solarLoanOriginalCostCents: number | null; // DebtDetail.originalBalanceCents for the "Solar loan" Account
}

// ── Helper predicates ────────────────────────────────────────────────────────

function isAnswered(questions: PersonalFormPlanQuestionInput[], key: string): boolean {
  const q = questions.find((q) => q.key === key);
  return !!q && q.answer !== null && !q.skippedReason;
}

/** True if a doc of `docType` finished extraction and yielded a numeric `field` in its data payload. */
function hasExtracted(
  documents: PersonalFormPlanDocumentInput[],
  docType: string,
  field: string
): boolean {
  return documents.some((d) => {
    if (d.docType !== docType || d.extractionStatus !== "complete") return false;
    const data = (d.extractionData as { data?: Record<string, unknown> } | null)?.data;
    return typeof data?.[field] === "number";
  });
}

/** True if a doc of `docType` finished extraction, regardless of whether any numeric field was captured. */
function hasDocProcessed(documents: PersonalFormPlanDocumentInput[], docType: string): boolean {
  return documents.some((d) => d.docType === docType && d.extractionStatus === "complete");
}

/** 1099-INT specifically (not 1099-DIV/NEC/MISC) with a numeric amount. */
function has1099Interest(documents: PersonalFormPlanDocumentInput[]): boolean {
  return documents.some((d) => {
    if (d.docType !== "1099" || d.extractionStatus !== "complete") return false;
    const data = (d.extractionData as { data?: Record<string, unknown> } | null)?.data;
    return data?.formVariant === "1099-INT" && typeof data?.amountCents === "number";
  });
}

// ── Main computation ─────────────────────────────────────────────────────────

export function computePersonalFormPlan(input: PersonalFormPlanInput): FormPlan[] {
  const {
    documents,
    questions,
    ekConsultingPL,
    suddenValleyPL,
    ekConsultingMileageCount,
    solarLoanOriginalCostCents,
  } = input;

  const hasW2Wages = hasExtracted(documents, "w2", "wagesCents");
  const hasW2FederalWithholding = hasExtracted(documents, "w2", "federalWithheldCents");
  const hasW2StateWithholding = hasExtracted(documents, "w2", "stateWithheldCents");
  const hasInterestIncome = has1099Interest(documents);
  const mortgageInterestDocComplete = hasExtracted(documents, "mortgage_interest", "interestCents");
  // "processed" not "extracted": property_tax docs classify to doc-extract.ts's
  // "other" shape, whose `data` is always `{}` — no numeric field is ever
  // available, so "have data" here can only mean "the bill was uploaded and
  // Claude finished processing it."
  const propertyTaxDocProcessed = hasDocProcessed(documents, "property_tax");

  const ekcHasIncomeLines = !!ekConsultingPL && ekConsultingPL.incomeLines.length > 0;
  const svHasIncomeLines = !!suddenValleyPL && suddenValleyPL.incomeLines.length > 0;
  // Sudden Valley's seeded GL codes: "5040" = Property Tax, "5030" = Insurance.
  // These codes are entity-specific — EK Consulting's own "5030" means "Home
  // Office," a different account entirely. Only apply this mapping to
  // suddenValleyPL, never to ekConsultingPL.
  const svHasPropertyTaxExpense =
    !!suddenValleyPL && suddenValleyPL.expenseLines.some((l) => l.code === "5040");
  const svHasInsuranceExpense =
    !!suddenValleyPL && suddenValleyPL.expenseLines.some((l) => l.code === "5030");

  const mileageLogged = ekConsultingMileageCount > 0;

  const retirementAnswered = isAnswered(questions, "retirement_contributions");
  const homeOfficeAnswered = isAnswered(questions, "home_office_ekc");
  const filingStatusAnswered = isAnswered(questions, "filing_status");
  const estimatedTaxesAnswered = isAnswered(questions, "estimated_taxes_2025");
  // The 4 questions the Form 1040 Credits line's source text names: solar,
  // EV, saver's (retirement), child (household_members) credits.
  const allCreditQuestionsAnswered =
    isAnswered(questions, "solar_credit") &&
    isAnswered(questions, "ev_vehicle") &&
    isAnswered(questions, "household_members") &&
    isAnswered(questions, "retirement_contributions");

  const solarCostKnown = solarLoanOriginalCostCents != null && solarLoanOriginalCostCents > 0;

  // Lookup table keyed by the exact `line` text in PERSONAL_FORM_PLAN.
  // IMPORTANT: if a `line` string in PERSONAL_FORM_PLAN is ever edited, this
  // map's key must be updated too, or that field will silently fall back to
  // `haveData: false`.
  const haveDataByLine: Record<string, boolean> = {
    // Form 1040
    "Wages (line 1a)": hasW2Wages,
    "Interest income (line 2b)": hasInterestIncome,
    "Business income (Schedule 1)": ekcHasIncomeLines,
    "Rental income (Schedule 1)": svHasIncomeLines,
    "Adjustments (Schedule 1, Part II)": retirementAnswered,
    "Standard or itemized (line 12)": mortgageInterestDocComplete && propertyTaxDocProcessed,
    "Credits (lines 19-21)": allCreditQuestionsAnswered,
    "Payments/withholding (line 25)": hasW2FederalWithholding || estimatedTaxesAnswered,

    // Schedule A
    "Home mortgage interest (line 8a)": mortgageInterestDocComplete,
    "State/local taxes (line 5e)": propertyTaxDocProcessed,
    "Gifts to charity (line 11)": false, // no donation-log data source exists

    // Schedule C
    "Gross receipts (line 1)": ekcHasIncomeLines,
    "Car and truck expenses (line 9)": mileageLogged,
    "Home office (line 30)": homeOfficeAnswered,
    "Depreciation (line 13)": false, // no Form-4562/fixed-asset data source exists

    // Schedule E
    "Rents received (line 3)": svHasIncomeLines,
    "Taxes (line 16)": svHasPropertyTaxExpense,
    "Insurance (line 15)": svHasInsuranceExpense,
    "Depreciation (line 18)": false, // no purchase-price/land-split figure recorded anywhere

    // Form 5695
    "Qualified solar electric property cost (line 1)": solarCostKnown,
    "Credit (30%)": solarCostKnown,

    // CT-1040
    "CT adjusted gross income":
      filingStatusAnswered && (hasW2Wages || ekcHasIncomeLines || svHasIncomeLines),
    "Property tax credit": propertyTaxDocProcessed,
    "CT withholding (W-2 box 17)": hasW2StateWithholding,
  };

  return PERSONAL_FORM_PLAN.map((form) => ({
    ...form,
    fields: form.fields.map((field) => ({
      ...field,
      haveData: haveDataByLine[field.line] ?? false,
    })),
  }));
}
