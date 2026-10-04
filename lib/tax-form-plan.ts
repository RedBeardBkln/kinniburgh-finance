// Pure computation of per-field data-availability (`haveData`) for the
// personal tax form-readiness plan. No DB import — the caller (the RSC page)
// fetches all raw data and hands it in already-resolved.
//
// This module clones `PERSONAL_FORM_PLAN` (the static shell/template of 6
// forms / 24 fields) and overwrites each field's `haveData` from real
// household data. It never computes an actual filled-in tax return, AGI, or
// liability figure — only a boolean data-availability signal per field
// (CLAUDE.md ground rule 8: drafts for a tax professional, not tax advice).
//
// Pass 3 (document-extraction-status-and-review) adds `computePersonalFormPlanBasis`:
// the SAME predicates, but reporting where each line's data comes from
// (verified document / unverified AI read / answers-or-books / missing).

import { PERSONAL_FORM_PLAN, type FormPlan } from "@/lib/tax-guidance";
import { NONE_CONFIRMATION_KEYS, isNoneConfirmed } from "@/lib/tax-none-confirmation";

export interface PersonalFormPlanDocumentInput {
  docType: string; // Document.docType raw value, e.g. "w2", "property_tax"
  extractionStatus: string | null; // Document.extractionStatus
  extractionData: unknown; // Document.extractionData JSON — cast internally
  /**
   * True when the owner marked this document's extraction verified. Optional so
   * existing callers/tests compile unchanged; undefined = unverified.
   * `extractionData` is expected to be the EFFECTIVE data (corrections overlaid):
   * the loaders map rows through lib/tax-extraction-policy.ts.
   */
  verified?: boolean;
}

/** Where a form line's availability comes from. */
export type FieldBasis = "verified" | "unverified" | "missing" | "not_document_based";

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
  /** Non-archived Personal donations dated in the tax year (donation log). */
  donationCount: number;
  /** Non-archived EK Consulting fixed assets placed in service in or before the tax year. */
  ekConsultingFixedAssetCount: number;
  /**
   * Non-archived Sudden Valley fixed assets that are real property WITH a recorded
   * land value, placed in service in or before the tax year (Schedule E line 18).
   */
  suddenValleyBuildingAssetCount: number;
}

// ── Helper predicates ────────────────────────────────────────────────────────

function isAnswered(questions: PersonalFormPlanQuestionInput[], key: string): boolean {
  const q = questions.find((q) => q.key === key);
  return !!q && q.answer !== null && !q.skippedReason;
}

/**
 * Availability of one line plus the documents that contribute to it. `docs` is
 * empty for lines fed by answers / P&L / mileage (not document based).
 */
interface Evidence {
  have: boolean;
  docs: PersonalFormPlanDocumentInput[];
}

function dataOf(d: PersonalFormPlanDocumentInput): Record<string, unknown> | undefined {
  return (d.extractionData as { data?: Record<string, unknown> } | null)?.data;
}

/** Docs of `docType` that finished extraction and yielded a numeric `field` in their data payload. */
function extractedEvidence(
  documents: PersonalFormPlanDocumentInput[],
  docType: string,
  field: string
): Evidence {
  const docs = documents.filter((d) => {
    if (d.docType !== docType || d.extractionStatus !== "complete") return false;
    return typeof dataOf(d)?.[field] === "number";
  });
  return { have: docs.length > 0, docs };
}

/**
 * Interest income on Form 1040 line 2b. Prefers 1099 interest box 1
 * (int_box1Cents, present on current-schema extractions - this is how a
 * consolidated 1099 contributes); otherwise the legacy rule: formVariant
 * "1099-INT" with a numeric amountCents (other variants are never interest).
 */
function interestEvidence(documents: PersonalFormPlanDocumentInput[]): Evidence {
  const docs = documents.filter((d) => {
    if (d.docType !== "1099" || d.extractionStatus !== "complete") return false;
    const data = dataOf(d);
    if (typeof data?.int_box1Cents === "number") return true;
    return data?.formVariant === "1099-INT" && typeof data?.amountCents === "number";
  });
  return { have: docs.length > 0, docs };
}

/**
 * Property-tax lines read the amount PAID in the tax year (paidInTaxYearCents),
 * which is owner-entered, never AI-filled: a bill shows what is billed and when
 * it is due, not what was paid. An uploaded bill alone no longer counts as
 * "have data".
 */
function propertyTaxPaidEvidence(documents: PersonalFormPlanDocumentInput[]): Evidence {
  return extractedEvidence(documents, "property_tax", "paidInTaxYearCents");
}

function allOf(...parts: Evidence[]): Evidence {
  return { have: parts.every((p) => p.have), docs: parts.flatMap((p) => p.docs) };
}

function flag(have: boolean): Evidence {
  return { have, docs: [] };
}

function basisOf(e: Evidence): FieldBasis {
  if (!e.have) return "missing";
  if (e.docs.length === 0) return "not_document_based";
  return e.docs.every((d) => d.verified === true) ? "verified" : "unverified";
}

// ── Main computation ─────────────────────────────────────────────────────────

/** Evidence keyed by the exact `line` text in PERSONAL_FORM_PLAN. */
function computeLineEvidence(input: PersonalFormPlanInput): Record<string, Evidence> {
  const {
    documents,
    questions,
    ekConsultingPL,
    suddenValleyPL,
    ekConsultingMileageCount,
    solarLoanOriginalCostCents,
    donationCount,
    ekConsultingFixedAssetCount,
    suddenValleyBuildingAssetCount,
  } = input;

  const w2Wages = extractedEvidence(documents, "w2", "wagesCents");
  const w2FederalWithholding = extractedEvidence(documents, "w2", "federalWithheldCents");
  const w2StateWithholding = extractedEvidence(documents, "w2", "stateWithheldCents");
  const interestIncome = interestEvidence(documents);
  const mortgageInterestDoc = extractedEvidence(documents, "mortgage_interest", "interestCents");
  const propertyTaxPaid = propertyTaxPaidEvidence(documents);

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
  // "No business driving" is a first-class answer: with no trips logged, the owner can state there were none
  // (planning question business_mileage = "no", not skipped) and the line reads as done with $0 car expenses.
  const mileageQuestion = questions.find((q) => q.key === "business_mileage");
  const noBusinessMileageConfirmed =
    !!mileageQuestion && mileageQuestion.answer === "no" && !mileageQuestion.skippedReason;

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

  // IMPORTANT: if a `line` string in PERSONAL_FORM_PLAN is ever edited, this
  // map's key must be updated too, or that field will silently fall back to
  // `haveData: false`.
  return {
    // Form 1040
    "Wages (line 1a)": w2Wages,
    "Interest income (line 2b)": interestIncome,
    "Business income (Schedule 1)": flag(ekcHasIncomeLines),
    "Rental income (Schedule 1)": flag(svHasIncomeLines),
    "Adjustments (Schedule 1, Part II)": flag(retirementAnswered),
    "Standard or itemized (line 12)": allOf(mortgageInterestDoc, propertyTaxPaid),
    "Credits (lines 19-21)": flag(allCreditQuestionsAnswered),
    // Document evidence wins when present; "estimated payments answered" is the non-document fallback.
    "Payments/withholding (line 25)": w2FederalWithholding.have
      ? w2FederalWithholding
      : flag(estimatedTaxesAnswered),

    // Schedule A
    "Home mortgage interest (line 8a)": mortgageInterestDoc,
    "State/local taxes (line 5e)": propertyTaxPaid,
    // Donation log entries exist for the year, OR the owner confirmed "none". The
    // basis is "not_document_based": a linked receipt is never extracted/verified.
    "Gifts to charity (line 11)": flag(
      donationCount > 0 || isNoneConfirmed(questions, NONE_CONFIRMATION_KEYS.donations)
    ),

    // Schedule C
    "Gross receipts (line 1)": flag(ekcHasIncomeLines),
    "Car and truck expenses (line 9)": flag(mileageLogged || noBusinessMileageConfirmed),
    "Home office (line 30)": flag(homeOfficeAnswered),
    "Depreciation (line 13)": flag(
      ekConsultingFixedAssetCount > 0 || isNoneConfirmed(questions, NONE_CONFIRMATION_KEYS.fixedAssetsEkc)
    ),

    // Schedule E
    "Rents received (line 3)": flag(svHasIncomeLines),
    "Taxes (line 16)": flag(svHasPropertyTaxExpense),
    "Insurance (line 15)": flag(svHasInsuranceExpense),
    // Needs a real-property asset WITH a land split (the line's source text), or "none".
    "Depreciation (line 18)": flag(
      suddenValleyBuildingAssetCount > 0 || isNoneConfirmed(questions, NONE_CONFIRMATION_KEYS.fixedAssetsSv)
    ),

    // Form 5695
    "Qualified solar electric property cost (line 1)": flag(solarCostKnown),
    "Credit (30%)": flag(solarCostKnown),

    // CT-1040
    "CT adjusted gross income": {
      have: filingStatusAnswered && (w2Wages.have || ekcHasIncomeLines || svHasIncomeLines),
      // Wages are the only document-based source of this line.
      docs: filingStatusAnswered && w2Wages.have ? w2Wages.docs : [],
    },
    "Property tax credit": propertyTaxPaid,
    "CT withholding (W-2 box 17)": w2StateWithholding,
  };
}

export function computePersonalFormPlan(input: PersonalFormPlanInput): FormPlan[] {
  const evidenceByLine = computeLineEvidence(input);
  return PERSONAL_FORM_PLAN.map((form) => ({
    ...form,
    fields: form.fields.map((field) => ({
      ...field,
      haveData: evidenceByLine[field.line]?.have ?? false,
    })),
  }));
}

/**
 * Per form line: where its data comes from. "verified"/"unverified" apply to
 * document-fed lines (a line aggregating several documents is "verified" only
 * if EVERY contributing document is verified); "not_document_based" = answers,
 * the books or mileage; "missing" = no data. Uses the same predicates as
 * computePersonalFormPlan, so `basis !== "missing"` <=> `haveData`.
 */
export function computePersonalFormPlanBasis(input: PersonalFormPlanInput): Record<string, FieldBasis> {
  const evidenceByLine = computeLineEvidence(input);
  const out: Record<string, FieldBasis> = {};
  for (const form of PERSONAL_FORM_PLAN) {
    for (const field of form.fields) {
      const evidence = evidenceByLine[field.line];
      out[field.line] = evidence ? basisOf(evidence) : "missing";
    }
  }
  return out;
}
