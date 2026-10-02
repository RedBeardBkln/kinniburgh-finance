// Pure forms catalog + readiness logic for the per-tax-year Forms page
// (/tax/forms/[year]). No DB, no "use server", no Decimal/Date in the OUTPUT —
// only strings, booleans and counts — so the result can be handed to any
// component. The caller (lib/tax-forms-build.ts) gathers raw data read-only and
// passes it in already resolved.
//
// Honesty rules (CLAUDE.md ground rules 1 and 8):
//   * Only forms the system can actually determine from existing sources are
//     listed as "required" / "conditional" / "not_applicable". Every entry
//     carries a non-empty `source` citation.
//   * Everything the system cannot determine is "needs_cpa_input" — shown, never
//     asserted as required.
//   * Sudden Valley's tax classification is not recorded anywhere, so anything
//     derived from it carries `confirmWithCpa`.
//   * Drafts for a CPA — not tax advice. Per-person document attribution does NOT
//     change any readiness or figure here (household files jointly; engine
//     unchanged).

import {
  baseOpportunitiesForHousehold,
  evaluateAnswers,
  formatOpportunityForDisplay,
  type FormPlan,
} from "@/lib/tax-guidance";
import { computePersonalFormPlan, type PersonalFormPlanInput } from "@/lib/tax-form-plan";
import {
  attributionLabel,
  isTaxDocType,
  suggestIssuerFromExtraction,
  type PersonRef,
} from "@/lib/document-attribution";
import { isEntityActiveForYear } from "@/lib/tax-entities";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FormJurisdiction = "federal" | "ct";
export type FormApplicability = "required" | "conditional" | "needs_cpa_input" | "not_applicable";
export type FormReadiness = "ready" | "partial" | "missing" | "not_assessed";

export interface FormsDocumentInput {
  id: string;
  docType: string;
  documentName: string | null;
  entityId: string;
  taxYear: number | null;
  extractionStatus: string | null;
  extractionData: unknown;
  archivedAt: Date | null;
  subjectType: string | null;
  subjectUser: PersonRef | null;
  issuerName: string | null;
}

export interface FormsEntityInput {
  id: string;
  name: string;
  slug: string | null;
  type: string; // "personal" | "business"
  foundedDate: Date | null;
  taxStatusNotes: string | null;
}

export interface FormsQuestionInput {
  key: string;
  answer: unknown;
  skippedReason: string | null;
}

export type TaxDraftSummary =
  | { status: "available"; deductionMethod: "standard" | "itemized"; selfEmploymentTaxPositive: boolean }
  | { status: "unavailable"; reason: string }
  | { status: "not_computed" }; // the engine only exists for TY2025

export interface FormsCatalogInput {
  taxYear: number;
  people: PersonRef[];
  entities: FormsEntityInput[]; // all non-archived personal + business entities
  documents: FormsDocumentInput[]; // all (archived ones are excluded again defensively)
  questions: FormsQuestionInput[]; // the Personal workspace's questions ([] if no workspace)
  personalWorkspaceExists: boolean;
  /** Entity id -> TaxWorkspace id, for this tax year. */
  workspaceIds: Record<string, string>;
  /** Entity id -> checklist progress for this tax year's workspace. */
  checklists: Record<string, { completed: number; total: number }>;
  /** Data for computePersonalFormPlan (documents here = Personal entity's docs for the year). */
  formPlanInput: PersonalFormPlanInput;
  taxDraft: TaxDraftSummary;
}

export interface FormInputRef {
  id: string;
  docType: string;
  docTypeLabel: string;
  name: string;
  personLabel: string;
  personAssigned: boolean;
  issuer: string | null;
  issuerIsSuggestion: boolean;
  extractionStatus: string | null;
  /** True only when extraction finished — failed/pending/null docs are listed but not "ready". */
  extractionComplete: boolean;
  taxYear: number | null;
  priorYear: boolean;
  href: string;
}

export interface FormFieldStatus {
  line: string;
  source: string;
  haveData: boolean;
}

export interface FormOpportunityRef {
  key: string;
  title: string;
  riskLabel: string;
  riskClass: string;
}

export interface FormEntry {
  id: string;
  formName: string;
  jurisdiction: FormJurisdiction;
  /** Who files it (household return vs. an entity). */
  filer: string;
  applicability: FormApplicability;
  /** Human text: why the form is (or is not) needed. */
  reason: string;
  /** Citation of the repo file / spec / entity record the claim comes from. Never empty. */
  source: string;
  /** Exact PERSONAL_FORM_PLAN.formName this entry reads field data from, if any. */
  planFormName: string | null;
  inputs: FormInputRef[];
  readiness: FormReadiness;
  fieldsReady: number;
  fieldsTotal: number;
  fields: FormFieldStatus[];
  missing: { line: string; source: string }[];
  /** True when the claim hinges on something only the CPA can confirm. */
  confirmWithCpa: boolean;
  cpaNote: string | null;
  opportunity: FormOpportunityRef | null;
}

export interface EntityFormsSection {
  entityId: string;
  entityName: string;
  slug: string | null;
  activeForYear: boolean;
  taxStatusNotes: string | null;
  /** Household-return forms this entity's activity is reported on (empty if none determined). */
  reportedOn: string[];
  checklist: { completed: number; total: number } | null;
  workspaceHref: string | null;
  entries: FormEntry[];
}

export interface FormsPageData {
  taxYear: number;
  householdLabel: string;
  federal: FormEntry[];
  connecticut: FormEntry[];
  needsCpaInput: FormEntry[];
  entities: EntityFormsSection[];
  summary: { required: number; conditional: number; needsCpaInput: number; notApplicable: number };
  attribution: { taxDocCount: number; unassignedPersonCount: number; missingIssuerCount: number };
  draft: TaxDraftSummary;
  personalWorkspaceExists: boolean;
  unansweredQuestionCount: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DOC_TYPE_LABELS: Record<string, string> = {
  w2: "W-2",
  "1099": "1099",
  k1: "K-1",
  mortgage_interest: "Mortgage interest (1098)",
  property_tax: "Property tax bill",
  tax_return: "Prior-year return",
  extension: "Extension",
  bank_statement: "Bank statement",
};

export function docTypeLabel(docType: string): string {
  return DOC_TYPE_LABELS[docType] ?? docType;
}

/** Exact PERSONAL_FORM_PLAN form names the catalog reads field data from. */
export const PLAN_FORM = {
  f1040: "Form 1040 (U.S. Individual Income Tax Return)",
  scheduleA: "Schedule A (Itemized Deductions)",
  scheduleC: "Schedule C (EK Consulting — LaunchTime Solutions)",
  scheduleE: "Schedule E (Rental Real Estate — 56 Arbor Rd)",
  f5695: "Form 5695 (Residential Clean Energy Credits)",
  ct1040: "CT State Income Tax Return (Form CT-1040)",
} as const;

/** Form 1040 plan lines that are reported through Schedule 1. */
const SCHEDULE_1_LINES = [
  "Business income (Schedule 1)",
  "Rental income (Schedule 1)",
  "Adjustments (Schedule 1, Part II)",
] as const;

const SLUG_EKC = "ek-consulting";
const SLUG_SV = "sudden-valley";

export const CPA_FOOTER =
  "Drafts for your CPA to review — not tax advice. This page does not file or fill any form.";

// ── Document matching ─────────────────────────────────────────────────────────

export interface DocumentMatchQuery {
  taxYear: number;
  docTypes: readonly string[];
  /** Restrict to these entities; omit for any entity. */
  entityIds?: readonly string[];
  /**
   * false (default): documents whose taxYear === taxYear.
   * true: PRIOR-year documents (taxYear < taxYear) — used for prior-year returns.
   * Documents with a null taxYear never match either way.
   */
  priorYear?: boolean;
}

/** Pure matcher: docType + entity + taxYear over non-archived docs. */
export function matchDocuments(docs: readonly FormsDocumentInput[], q: DocumentMatchQuery): FormsDocumentInput[] {
  return docs.filter((d) => {
    if (d.archivedAt !== null) return false;
    if (d.taxYear === null) return false;
    if (!q.docTypes.includes(d.docType)) return false;
    if (q.entityIds && !q.entityIds.includes(d.entityId)) return false;
    return q.priorYear ? d.taxYear < q.taxYear : d.taxYear === q.taxYear;
  });
}

function toInputRef(doc: FormsDocumentInput, people: readonly PersonRef[], year: number): FormInputRef {
  const attribution = attributionLabel({ subjectType: doc.subjectType, subjectUser: doc.subjectUser }, people);
  const suggested = doc.issuerName ? null : suggestIssuerFromExtraction(doc.docType, doc.extractionData);
  const label = docTypeLabel(doc.docType);
  const priorYear = doc.taxYear !== null && doc.taxYear < year;
  return {
    id: doc.id,
    docType: doc.docType,
    docTypeLabel: label,
    name: doc.documentName && doc.documentName.trim() !== "" ? doc.documentName : label,
    personLabel: attribution.label,
    personAssigned: attribution.assigned,
    issuer: doc.issuerName ?? suggested,
    issuerIsSuggestion: !doc.issuerName && suggested !== null,
    extractionStatus: doc.extractionStatus,
    extractionComplete: doc.extractionStatus === "complete",
    taxYear: doc.taxYear,
    priorYear,
    href: `/documents?bucket=taxes&entityId=${encodeURIComponent(doc.entityId)}&docType=${encodeURIComponent(doc.docType)}${
      doc.taxYear !== null ? `&year=${doc.taxYear}` : ""
    }`,
  };
}

// ── Readiness ─────────────────────────────────────────────────────────────────

/** 0 fields ready -> missing; all -> ready; otherwise partial; no fields -> not_assessed. */
export function readinessFromFields(fields: readonly FormFieldStatus[]): {
  readiness: FormReadiness;
  fieldsReady: number;
  fieldsTotal: number;
} {
  const fieldsTotal = fields.length;
  const fieldsReady = fields.filter((f) => f.haveData).length;
  if (fieldsTotal === 0) return { readiness: "not_assessed", fieldsReady, fieldsTotal };
  if (fieldsReady === 0) return { readiness: "missing", fieldsReady, fieldsTotal };
  if (fieldsReady === fieldsTotal) return { readiness: "ready", fieldsReady, fieldsTotal };
  return { readiness: "partial", fieldsReady, fieldsTotal };
}

// ── Entry builder ─────────────────────────────────────────────────────────────

interface EntrySpec {
  id: string;
  formName: string;
  jurisdiction: FormJurisdiction;
  filer: string;
  applicability: FormApplicability;
  reason: string;
  source: string;
  planFormName?: string | null;
  inputs?: FormInputRef[];
  fields?: FormFieldStatus[];
  confirmWithCpa?: boolean;
  cpaNote?: string | null;
  opportunity?: FormOpportunityRef | null;
}

function makeEntry(spec: EntrySpec): FormEntry {
  const fields = spec.fields ?? [];
  const r = readinessFromFields(fields);
  return {
    id: spec.id,
    formName: spec.formName,
    jurisdiction: spec.jurisdiction,
    filer: spec.filer,
    applicability: spec.applicability,
    reason: spec.reason,
    source: spec.source,
    planFormName: spec.planFormName ?? null,
    inputs: spec.inputs ?? [],
    readiness: r.readiness,
    fieldsReady: r.fieldsReady,
    fieldsTotal: r.fieldsTotal,
    fields,
    missing: fields.filter((f) => !f.haveData).map((f) => ({ line: f.line, source: f.source })),
    confirmWithCpa: spec.confirmWithCpa ?? false,
    cpaNote: spec.cpaNote ?? null,
    opportunity: spec.opportunity ?? null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The answer string for a planning question, or null when unanswered/skipped/non-string. */
function answerString(questions: readonly FormsQuestionInput[], key: string): string | null {
  const q = questions.find((x) => x.key === key);
  if (!q || q.skippedReason) return null;
  return typeof q.answer === "string" ? q.answer : null;
}

/** True when the entity's tax-status note says it is a disregarded entity. */
export function noteSaysDisregarded(notes: string | null): boolean {
  return /disregarded/i.test(notes ?? "");
}

function planFields(plan: readonly FormPlan[], planFormName: string): FormFieldStatus[] {
  const form = plan.find((f) => f.formName === planFormName);
  return form ? form.fields.map((f) => ({ line: f.line, source: f.source, haveData: f.haveData })) : [];
}

function opportunityRef(key: string): FormOpportunityRef | null {
  const op = baseOpportunitiesForHousehold().find((o) => o.key === key);
  if (!op) return null;
  const display = formatOpportunityForDisplay(op);
  return { key: op.key, title: op.title, riskLabel: display.riskLabel, riskClass: display.riskClass };
}

/**
 * Forms that the guidance engine names but the system cannot determine today.
 * `opportunityKey` ties each to the existing opportunity that names it, so a
 * rename in lib/tax-guidance.ts fails the catalog test loudly. `formMarker` is
 * the text that must appear in that opportunity's `forms` list.
 */
export const CPA_INPUT_FORMS: readonly {
  id: string;
  formName: string;
  opportunityKey: string;
  formMarker: string;
  reason: string;
}[] = [
  {
    id: "form-8829",
    formName: "Form 8829 (Expenses for Business Use of Your Home)",
    opportunityKey: "home_office",
    formMarker: "Form 8829",
    reason:
      "Only needed if the actual-expense home-office method is used; the draft uses the simplified method. Whether and how to claim it is a CPA decision.",
  },
  {
    id: "form-4562",
    formName: "Form 4562 (Depreciation and Amortization)",
    opportunityKey: "rental_depreciation",
    formMarker: "Form 4562",
    reason:
      "Rental depreciation would be reported here, but no purchase price / land split / placed-in-service data is recorded, so the system cannot tell whether or how it applies.",
  },
  {
    id: "form-8582",
    formName: "Form 8582 (Passive Activity Loss Limitations)",
    opportunityKey: "short_term_rental_loophole",
    formMarker: "Form 8582",
    reason:
      "Depends on rental-loss treatment and material-participation facts the system does not hold. Needs a CPA decision.",
  },
  {
    id: "form-8880",
    formName: "Form 8880 (Credit for Qualified Retirement Savings Contributions)",
    opportunityKey: "retirement_savings_credit",
    formMarker: "Form 8880",
    reason: "Eligibility depends on income and contribution details the system does not determine.",
  },
  {
    id: "form-8889",
    formName: "Form 8889 (Health Savings Accounts)",
    opportunityKey: "hsa",
    formMarker: "Form 8889",
    reason: "Only relevant if either spouse has an HSA-eligible plan and contributed — not recorded in the system.",
  },
  {
    id: "form-2210",
    formName: "Form 2210 (Underpayment of Estimated Tax)",
    opportunityKey: "safe_harbor",
    formMarker: "Form 2210",
    reason: "Depends on whether a safe harbor was met; the system does not decide this.",
  },
  {
    id: "form-1040-es",
    formName: "Form 1040-ES (Estimated Tax for Individuals)",
    opportunityKey: "safe_harbor",
    formMarker: "Form 1040-ES",
    reason: "Relevant to future estimated payments; whether to make them is a CPA / owner decision.",
  },
];

// ── Main builder ──────────────────────────────────────────────────────────────

export function buildFormsPageData(input: FormsCatalogInput): FormsPageData {
  const { taxYear, people, entities, documents, questions, taxDraft } = input;

  const personalEntity = entities.find((e) => e.type === "personal") ?? null;
  const ekc = entities.find((e) => e.slug === SLUG_EKC) ?? null;
  const sv = entities.find((e) => e.slug === SLUG_SV) ?? null;
  const ekcActive = ekc ? isEntityActiveForYear(ekc, taxYear) : false;
  const svActive = sv ? isEntityActiveForYear(sv, taxYear) : false;

  const householdLabel = attributionLabel({ subjectType: "joint", subjectUser: null }, people).label;
  const householdFiler = householdLabel === "Joint" ? "Household" : `Household — ${householdLabel}`;

  const refs = (docs: FormsDocumentInput[]): FormInputRef[] => docs.map((d) => toInputRef(d, people, taxYear));
  const personalIds = personalEntity ? [personalEntity.id] : [];
  const ekcIds = ekc ? [ekc.id] : [];
  const svIds = sv ? [sv.id] : [];
  const personalDocs = (docTypes: string[]) =>
    matchDocuments(documents, { taxYear, docTypes, entityIds: personalIds });
  // Prior-year returns are a reference for every household form (carryforwards, 5695 check).
  const priorReturnRefs = refs(
    matchDocuments(documents, { taxYear, docTypes: ["tax_return"], entityIds: personalIds, priorYear: true })
  );

  const plan = computePersonalFormPlan(input.formPlanInput);
  const answerMap: Record<string, unknown> = {};
  for (const q of questions) answerMap[q.key] = q.answer;
  const { excluded } = evaluateAnswers(answerMap);

  // ── Household: federal ──────────────────────────────────────────────────────
  const f1040 = makeEntry({
    id: "form-1040",
    formName: "Form 1040 (U.S. Individual Income Tax Return)",
    jurisdiction: "federal",
    filer: householdFiler,
    applicability: "required",
    reason: "The core federal return for the household; every other federal schedule attaches to it.",
    source: "lib/tax-guidance.ts PERSONAL_FORM_PLAN (Form 1040); specs/09 (married filing jointly)",
    planFormName: PLAN_FORM.f1040,
    fields: planFields(plan, PLAN_FORM.f1040),
    inputs: [
      ...refs(personalDocs(["w2", "1099", "extension"])),
      ...priorReturnRefs,
    ],
    cpaNote:
      "W-2s feed wages and withholding; only 1099-INT interest is read by the readiness check. An extension document is informational.",
  });

  const schedule1Required = ekcActive || svActive;
  const scheduleOne = makeEntry({
    id: "schedule-1",
    formName: "Schedule 1 (Additional Income and Adjustments to Income)",
    jurisdiction: "federal",
    filer: householdFiler,
    applicability: schedule1Required ? "required" : "conditional",
    reason: schedule1Required
      ? "Business income (EK Consulting Schedule C) and/or rental income (Sudden Valley Schedule E) flow to Form 1040 through Schedule 1."
      : "Would be needed for business/rental income or above-the-line adjustments; none of those entities apply this year.",
    source: "lib/tax-guidance.ts PERSONAL_FORM_PLAN (Form 1040 lines tagged \"Schedule 1\")",
    fields: planFields(plan, PLAN_FORM.f1040).filter((f) => (SCHEDULE_1_LINES as readonly string[]).includes(f.line)),
  });

  // Schedule A
  const propertyTaxNote =
    "Property-tax bills never yield a dollar amount (generic extraction), so an itemized total can be understated.";
  let scheduleAApplicability: FormApplicability = "conditional";
  let scheduleAReason =
    "Depends on whether itemized deductions exceed the standard deduction; the draft engine only exists for tax year 2025.";
  let scheduleAConfirm = false;
  if (taxDraft.status === "available") {
    if (taxDraft.deductionMethod === "itemized") {
      scheduleAApplicability = "required";
      scheduleAReason = "The 2025 draft computes itemized deductions larger than the standard deduction.";
    } else {
      scheduleAApplicability = "not_applicable";
      scheduleAReason = "The 2025 draft computes the standard deduction as larger — Schedule A is not needed per the draft.";
      scheduleAConfirm = true;
    }
  } else if (taxDraft.status === "unavailable") {
    scheduleAReason = `Draft unavailable (${taxDraft.reason}); whether to itemize is undetermined.`;
  }
  const scheduleA = makeEntry({
    id: "schedule-a",
    formName: "Schedule A (Itemized Deductions)",
    jurisdiction: "federal",
    filer: householdFiler,
    applicability: scheduleAApplicability,
    reason: scheduleAReason,
    source: "lib/tax-guidance.ts PERSONAL_FORM_PLAN (Schedule A); lib/tax-compute.ts selectDeductionMethod (TY2025 draft)",
    planFormName: PLAN_FORM.scheduleA,
    fields: planFields(plan, PLAN_FORM.scheduleA),
    inputs: [...refs(personalDocs(["mortgage_interest", "property_tax"])), ...priorReturnRefs],
    confirmWithCpa: scheduleAConfirm,
    cpaNote: propertyTaxNote,
  });

  // Schedule C
  const scheduleC = makeEntry({
    id: "schedule-c",
    formName: "Schedule C (Profit or Loss From Business) — EK Consulting",
    jurisdiction: "federal",
    filer: householdFiler,
    applicability: ekcActive ? "required" : "not_applicable",
    reason: ekcActive
      ? "EK Consulting is a single-member LLC (disregarded entity); its income and expenses are reported on Eric's Form 1040 via Schedule C."
      : "EK Consulting has no filing for this tax year (entity not active for the year).",
    source: "specs/03 + specs/07 item 7; Entity.taxStatusNotes (EK Consulting); lib/tax-guidance.ts PERSONAL_FORM_PLAN (Schedule C)",
    planFormName: PLAN_FORM.scheduleC,
    fields: planFields(plan, PLAN_FORM.scheduleC),
    inputs: ekcActive
      ? [
          ...refs(matchDocuments(documents, { taxYear, docTypes: ["1099", "bank_statement"], entityIds: ekcIds })),
          ...priorReturnRefs,
        ]
      : [],
    cpaNote: ekcActive
      ? "Bank statements are the books source for EK Consulting; 1099s filed under EK Consulting feed gross receipts."
      : null,
  });

  // Schedule SE
  let seApplicability: FormApplicability;
  let seReason: string;
  if (!ekcActive) {
    seApplicability = "not_applicable";
    seReason = "No EK Consulting self-employment activity for this tax year.";
  } else if (taxDraft.status === "available" && taxDraft.selfEmploymentTaxPositive) {
    seApplicability = "required";
    seReason = "The 2025 draft computes self-employment tax greater than $0 on EK Consulting net profit.";
  } else if (taxDraft.status === "available") {
    seApplicability = "needs_cpa_input";
    seReason =
      "The 2025 draft computes $0 self-employment tax; the system holds no filing-threshold rule, so the CPA confirms whether Schedule SE is needed.";
  } else {
    seApplicability = "needs_cpa_input";
    seReason =
      "Self-employment tax is only drafted for tax year 2025 and the filing threshold is not encoded here — the CPA determines whether Schedule SE applies.";
  }
  const scheduleSE = makeEntry({
    id: "schedule-se",
    formName: "Schedule SE (Self-Employment Tax)",
    jurisdiction: "federal",
    filer: householdFiler,
    applicability: seApplicability,
    reason: seReason,
    source: "specs/09 (Self-employment tax / Schedule SE); lib/tax-compute.ts computeSelfEmploymentTax (TY2025 draft)",
    cpaNote: "Readiness is not assessed — it follows EK Consulting's Schedule C net profit.",
  });

  // Schedule E
  const classificationConfirmed = sv ? noteSaysDisregarded(sv.taxStatusNotes) : false;
  const scheduleE = makeEntry({
    id: "schedule-e",
    formName: "Schedule E (Supplemental Income and Loss) — Sudden Valley rental",
    jurisdiction: "federal",
    filer: householdFiler,
    applicability: svActive ? "required" : "not_applicable",
    reason: svActive
      ? classificationConfirmed
        ? "Sudden Valley's Airbnb rental is reported on Schedule E of the household return (entity record: disregarded)."
        : "Per system configuration, Sudden Valley's Airbnb rental is reported on Schedule E of the household return. Sudden Valley's tax classification is not recorded — confirm with CPA."
      : "Sudden Valley was formed in 2026; there is no rental activity for this tax year.",
    source: "specs/09 + specs/03 (Sudden Valley formed Feb 2026); prisma/seed.ts + lib/tax-checklist.ts RENTAL_CHECKLIST (Schedule E); lib/tax-guidance.ts PERSONAL_FORM_PLAN",
    planFormName: PLAN_FORM.scheduleE,
    fields: planFields(plan, PLAN_FORM.scheduleE),
    inputs: svActive
      ? [
          ...refs(
            matchDocuments(documents, {
              taxYear,
              docTypes: ["mortgage_interest", "property_tax", "bank_statement"],
              entityIds: svIds,
            })
          ),
          ...priorReturnRefs,
        ]
      : [],
    confirmWithCpa: svActive && !classificationConfirmed,
  });

  // Form 5695
  const solar = answerString(questions, "solar_credit");
  let f5695Applicability: FormApplicability;
  let f5695Reason: string;
  if (solar === "yes_unclaimed") {
    f5695Applicability = "required";
    f5695Reason = "You answered that the solar system was installed and the credit never claimed.";
  } else if (solar === "claimed_already") {
    f5695Applicability = "not_applicable";
    f5695Reason = "You answered that the credit was already claimed on a prior return (check any carryforward).";
  } else if (solar === "unsure") {
    f5695Applicability = "conditional";
    f5695Reason = "You answered \"Not sure\" — the prior-year Form 5695 shows whether the credit was claimed or carried forward.";
  } else {
    f5695Applicability = "conditional";
    f5695Reason = "Depends on the \"solar credit\" planning question, which is not answered yet.";
  }
  const f5695 = makeEntry({
    id: "form-5695",
    formName: "Form 5695 (Residential Clean Energy Credits)",
    jurisdiction: "federal",
    filer: householdFiler,
    applicability: f5695Applicability,
    reason: f5695Reason,
    source: "lib/tax-guidance.ts TAX_QUESTION_BANK solar_credit + evaluateAnswers; PERSONAL_FORM_PLAN (Form 5695)",
    planFormName: PLAN_FORM.f5695,
    fields: planFields(plan, PLAN_FORM.f5695),
    inputs: priorReturnRefs,
  });

  // ── Household: Connecticut ──────────────────────────────────────────────────
  const ct1040 = makeEntry({
    id: "ct-1040",
    formName: "CT-1040 (Connecticut Resident Return, incl. Tax Calculation Schedule)",
    jurisdiction: "ct",
    filer: householdFiler,
    applicability: "required",
    reason: "The household is a Connecticut resident filer.",
    source: "specs/09 (CT tables A–E); lib/tax-guidance.ts PERSONAL_FORM_PLAN (CT-1040)",
    planFormName: PLAN_FORM.ct1040,
    fields: planFields(plan, PLAN_FORM.ct1040),
    inputs: [...refs(personalDocs(["w2"])), ...priorReturnRefs],
    cpaNote: "W-2 box 17 (CT withholding) feeds this return.",
  });

  const propertyTaxCreditField = planFields(plan, PLAN_FORM.ct1040).filter((f) => f.line === "Property tax credit");
  const ctSchedule3 = makeEntry({
    id: "ct-schedule-3",
    formName: "CT-1040 Schedule 3 (Property Tax Credit)",
    jurisdiction: "ct",
    filer: householdFiler,
    applicability: "conditional",
    reason:
      "Depends on qualifying property tax paid and a nonzero CT-1040 line 10. \"Ready\" here only means a bill was uploaded and processed — the amount cannot be extracted.",
    source: "specs/09 (Property tax credit, Schedule 3); lib/tax-form-plan.ts (Property tax credit field)",
    fields: propertyTaxCreditField,
    inputs: [...refs(personalDocs(["property_tax"])), ...priorReturnRefs],
  });

  // ── Needs CPA input ─────────────────────────────────────────────────────────
  const needsCpa: FormEntry[] = [];
  for (const f of CPA_INPUT_FORMS) {
    const ruledOut = excluded.includes(f.opportunityKey);
    needsCpa.push(
      makeEntry({
        id: f.id,
        formName: f.formName,
        jurisdiction: "federal",
        filer: householdFiler,
        applicability: ruledOut ? "not_applicable" : "needs_cpa_input",
        reason: ruledOut
          ? "Ruled out by your planning-question answers."
          : f.reason,
        source: `lib/tax-guidance.ts baseOpportunitiesForHousehold ("${f.opportunityKey}") + evaluateAnswers`,
        opportunity: opportunityRef(f.opportunityKey),
      })
    );
  }
  needsCpa.push(
    makeEntry({
      id: "schedule-3-federal",
      formName: "Schedule 3 (Additional Credits and Payments)",
      jurisdiction: "federal",
      filer: householdFiler,
      applicability: "needs_cpa_input",
      reason:
        "Credits such as the residential clean energy credit are reported through it, but the system does not determine which credits apply.",
      source: "lib/tax-guidance.ts TAX_QUESTION_BANK solar_credit (note references prior-year Schedule 3 / Form 5695)",
    }),
    makeEntry({
      id: "qbi-deduction",
      formName: "Qualified business income (QBI) deduction — form not identified by this system",
      jurisdiction: "federal",
      filer: householdFiler,
      applicability: "needs_cpa_input",
      reason:
        "The 2025 draft engine computes a QBI deduction amount, but no form is modelled here. The CPA identifies and prepares the form.",
      source: "lib/tax-compute.ts (qbi in the TY2025 draft); no form is named in any repo source",
    }),
    makeEntry({
      id: "additional-medicare-tax",
      formName: "Additional Medicare Tax — form not identified by this system",
      jurisdiction: "federal",
      filer: householdFiler,
      applicability: "needs_cpa_input",
      reason:
        "The 2025 draft engine computes an additional Medicare tax amount, but no form is modelled here. The CPA identifies and prepares the form.",
      source: "lib/tax-compute.ts (additionalMedicareTax in the TY2025 draft); no form is named in any repo source",
    }),
    makeEntry({
      id: "child-dependent-credits",
      formName: "Child / dependent credits — not modelled",
      jurisdiction: "federal",
      filer: householdFiler,
      applicability: excluded.includes("child_credits") ? "not_applicable" : "needs_cpa_input",
      reason: excluded.includes("child_credits")
        ? "Ruled out by your planning-question answers (no dependents)."
        : "Dependent answers are captured, but no form logic consumes them. The CPA determines the credits and forms.",
      source: "lib/tax-guidance.ts TAX_QUESTION_BANK household_members + evaluateAnswers (child_credits)",
    }),
    makeEntry({
      id: "clean-vehicle-credit",
      formName: "Clean vehicle credit — not modelled",
      jurisdiction: "federal",
      filer: householdFiler,
      applicability: excluded.includes("ev_credit") ? "not_applicable" : "needs_cpa_input",
      reason: excluded.includes("ev_credit")
        ? "Ruled out by your planning-question answers (no EV purchase)."
        : "The EV answer is captured, but no form logic consumes it. The CPA determines eligibility and forms.",
      source: "lib/tax-guidance.ts TAX_QUESTION_BANK ev_vehicle + evaluateAnswers (ev_credit)",
    })
  );
  const k1Docs = matchDocuments(documents, { taxYear, docTypes: ["k1"] });
  if (k1Docs.length > 0) {
    needsCpa.push(
      makeEntry({
        id: "k1-handling",
        formName: "Schedule K-1 handling",
        jurisdiction: "federal",
        filer: householdFiler,
        applicability: "needs_cpa_input",
        reason: "K-1 documents are on file for this year, but no form logic consumes K-1s — the CPA handles them.",
        source: "lib/document-attribution.ts TAX_DOC_TYPES (k1); no K-1 handling exists in lib/tax-form-plan.ts / lib/tax-compute.ts",
        inputs: refs(k1Docs),
      })
    );
  }

  // ── Entity sections ─────────────────────────────────────────────────────────
  const businesses = entities
    .filter((e) => e.type === "business")
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const entitySections: EntityFormsSection[] = businesses.map((e) => {
    const active = isEntityActiveForYear(e, taxYear);
    const checklist = input.checklists[e.id] ?? null;
    const wsId = input.workspaceIds[e.id];
    const reportedOn =
      active && e.slug === SLUG_EKC
        ? ["Schedule C", "Schedule SE"]
        : active && e.slug === SLUG_SV
          ? ["Schedule E"]
          : [];
    const entries: FormEntry[] = [];
    if (!active) {
      const reason = e.foundedDate
        ? `Founded ${e.foundedDate.getUTCFullYear()} — after tax year ${taxYear}; no filing for this year.`
        : "The entity record says it is not yet formed; there is no tax workspace until a formation date/state is recorded.";
      entries.push(
        makeEntry({
          id: `${e.id}-no-filing`,
          formName: "Tax filings",
          jurisdiction: "federal",
          filer: e.name,
          applicability: "not_applicable",
          reason,
          source: "Entity.foundedDate / Entity.taxStatusNotes; specs/03",
        })
      );
    } else {
      const disregarded = noteSaysDisregarded(e.taxStatusNotes);
      const isSv = e.slug === SLUG_SV;
      entries.push(
        makeEntry({
          id: `${e.id}-federal-entity-return`,
          formName: "Separate federal entity return",
          jurisdiction: "federal",
          filer: e.name,
          applicability: disregarded ? "not_applicable" : "needs_cpa_input",
          reason: disregarded
            ? "Disregarded single-member LLC per the entity record — no separate return; activity is reported on the household return."
            : "The entity's tax classification is not recorded in the system. If it is not a disregarded entity it files its own return — confirm with CPA.",
          source: "Entity.taxStatusNotes",
          confirmWithCpa: !disregarded,
          cpaNote: isSv && !disregarded ? "Sudden Valley's classification is unconfirmed — confirm with CPA." : null,
        }),
        makeEntry({
          id: `${e.id}-ct-entity-filing`,
          formName: "Connecticut business-entity filing",
          jurisdiction: "ct",
          filer: e.name,
          applicability: "needs_cpa_input",
          reason: "The system does not determine any Connecticut business-entity filing requirement.",
          source: "No CT business-entity rule exists in the repo (specs/09 covers the individual CT-1040 only)",
        })
      );
    }
    return {
      entityId: e.id,
      entityName: e.name,
      slug: e.slug,
      activeForYear: active,
      taxStatusNotes: e.taxStatusNotes,
      reportedOn,
      checklist,
      workspaceHref: wsId ? `/tax/${wsId}` : null,
      entries,
    };
  });

  const federal = [f1040, scheduleOne, scheduleA, scheduleC, scheduleSE, scheduleE, f5695];
  const connecticut = [ct1040, ctSchedule3];

  const all = [...federal, ...connecticut, ...needsCpa, ...entitySections.flatMap((s) => s.entries)];
  const summary = {
    required: all.filter((e) => e.applicability === "required").length,
    conditional: all.filter((e) => e.applicability === "conditional").length,
    needsCpaInput: all.filter((e) => e.applicability === "needs_cpa_input").length,
    notApplicable: all.filter((e) => e.applicability === "not_applicable").length,
  };

  const taxDocsThisYear = documents.filter(
    (d) => d.archivedAt === null && d.taxYear === taxYear && isTaxDocType(d.docType)
  );
  const attribution = {
    taxDocCount: taxDocsThisYear.length,
    unassignedPersonCount: taxDocsThisYear.filter(
      (d) => !attributionLabel({ subjectType: d.subjectType, subjectUser: d.subjectUser }, people).assigned
    ).length,
    missingIssuerCount: taxDocsThisYear.filter((d) => !d.issuerName).length,
  };

  return {
    taxYear,
    householdLabel,
    federal,
    connecticut,
    needsCpaInput: needsCpa,
    entities: entitySections,
    summary,
    attribution,
    draft: taxDraft,
    personalWorkspaceExists: input.personalWorkspaceExists,
    unansweredQuestionCount: questions.filter((q) => q.answer === null).length,
  };
}

/** Exposed for tests: the opportunity keys the catalog relies on must still exist. */
export function opportunityForms(key: string): string[] | null {
  const op = baseOpportunitiesForHousehold().find((o) => o.key === key);
  return op ? op.forms : null;
}
