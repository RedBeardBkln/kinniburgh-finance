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
  SUDDEN_VALLEY_ONLY_OPPORTUNITY_KEYS,
  type FormPlan,
} from "@/lib/tax-guidance";
import {
  computePersonalFormPlan,
  computePersonalFormPlanBasis,
  type FieldBasis,
  type PersonalFormPlanInput,
} from "@/lib/tax-form-plan";
import type { ExtractionDisplay } from "@/lib/document-extraction-state";
import { TAX_EXTRACTION_POLICY, type TaxExtractionPolicy } from "@/lib/tax-extraction-policy";
import {
  attributionLabel,
  isTaxDocType,
  suggestIssuerFromExtraction,
  type PersonRef,
} from "@/lib/document-attribution";
import { isEntityActiveForYear } from "@/lib/tax-entities";
import { resolveFieldFixes, type FieldFix, type FixContext } from "@/lib/tax-form-fixes";
import {
  buildCardState,
  summarizeQuestionnaires,
  type QuestionnaireCardState,
  type QuestionnaireContext,
  type QuestionnaireCounts,
  type QuestionnaireRowInput,
} from "@/lib/tax-questionnaire";
import {
  ENTITY_CT_QUESTIONNAIRE_ID,
  ENTITY_FEDERAL_QUESTIONNAIRE_ID,
  RETURN_COMPLETENESS_ID,
  questionnaireById,
} from "@/lib/tax-questionnaire-content";

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
  /**
   * Pass 3: owner marked this document's extraction verified, and the
   * describeExtraction state shared with the Documents list. Both optional so
   * existing callers/tests compile unchanged (absent = unverified / unknown).
   * `extractionData` is the EFFECTIVE data (corrections overlaid).
   */
  verified?: boolean;
  extraction?: ExtractionDisplay | null;
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
  /**
   * Saved CPA-input questionnaire rows for this tax year (read-only). Optional so
   * existing callers/tests compile unchanged; absent = nothing answered yet.
   * A questionnaire NEVER changes applicability, readiness, field counts or the
   * summary counters - it only adds a status block to the card.
   */
  questionnaireRows?: QuestionnaireRowInput[];
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
  /** The Documents-list extraction state (label/tone/kind); null when the caller supplied none. */
  extraction: ExtractionDisplay | null;
  /** Owner verified this document's extraction. */
  verified: boolean;
  /** Review screen link, only when there is a reading to review. */
  reviewHref: string | null;
  taxYear: number | null;
  priorYear: boolean;
  href: string;
}

export interface FormFieldStatus {
  line: string;
  source: string;
  haveData: boolean;
  /**
   * Where the data comes from: a verified document, an unverified AI read, a
   * non-document source (answers / books / mileage) or missing. Absent for
   * entries that do not read form-plan lines. `haveData` is true unless "missing".
   */
  basis?: FieldBasis;
  /**
   * For a MISSING line: the ways to supply the data (answer a question, upload /
   * review a document, jump to the books or mileage log). Absent when the line
   * has data, or for entries that do not read form-plan lines.
   */
  fixes?: FieldFix[];
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
  /** Of the ready fields: from verified documents / unverified AI reads / non-document sources. */
  fieldsVerified: number;
  fieldsUnverified: number;
  fieldsOtherSource: number;
  fields: FormFieldStatus[];
  missing: { line: string; source: string }[];
  /** True when the claim hinges on something only the CPA can confirm. */
  confirmWithCpa: boolean;
  cpaNote: string | null;
  opportunity: FormOpportunityRef | null;
  /** Guided CPA-input questionnaire status for this card; null when the card has none. */
  questionnaire: QuestionnaireCardState | null;
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
  /** How this year's tax documents' extractions stand (basis banner). */
  extractionBasis: ExtractionBasisSummary;
  /** Counts over the cards that have a questionnaire. Separate from `summary`, which it never changes. */
  questionnaireSummary: QuestionnaireCounts;
}

/** Every card on the page that has a questionnaire, in page order (federal, CT, needs-CPA, entities). */
export function listQuestionnaireEntries(
  data: Pick<FormsPageData, "federal" | "connecticut" | "needsCpaInput" | "entities">
): { entry: FormEntry; questionnaire: QuestionnaireCardState }[] {
  const all = [
    ...data.federal,
    ...data.connecticut,
    ...data.needsCpaInput,
    ...data.entities.flatMap((s) => s.entries),
  ];
  const out: { entry: FormEntry; questionnaire: QuestionnaireCardState }[] = [];
  for (const entry of all) if (entry.questionnaire) out.push({ entry, questionnaire: entry.questionnaire });
  return out;
}

/** Counts over this tax year's extractable tax documents (documents with no extraction state are skipped). */
export interface ExtractionBasisSummary {
  policy: TaxExtractionPolicy;
  /** Extractable tax documents counted (excludes extension/N-A). */
  documentCount: number;
  verified: number;
  /** Extracted (usable) but not verified - includes older-format ones. */
  unverified: number;
  /** Of the counted documents, how many are in the older extraction format. */
  olderFormat: number;
  /** Failed / not extracted / skipped / processing: no usable reading yet. */
  noReading: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DOC_TYPE_LABELS: Record<string, string> = {
  w2: "W-2",
  "1099": "1099",
  k1: "K-1",
  mortgage_interest: "Mortgage interest (1098)",
  property_tax: "Property tax bill",
  donation_receipt: "Donation receipt",
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

/**
 * Form 1040 plan lines that only exist because of Sudden Valley's rental. For a
 * tax year when Sudden Valley is not active they are left off the page entirely
 * (a line about a "2026 forward" source is not a 2025 requirement).
 */
const SV_ONLY_PLAN_LINES: ReadonlySet<string> = new Set(["Rental income (Schedule 1)"]);

/**
 * CPA_INPUT_FORMS entries whose only driver is Sudden Valley's rental (Form 4562
 * rental depreciation, Form 8582 rental passive-loss limits), keyed by the
 * entry's opportunityKey - the shared list in lib/tax-guidance.ts. Home office
 * (8829) etc. are EK Consulting / household matters and always stay.
 */
const SV_ONLY_CPA_OPPORTUNITIES: ReadonlySet<string> = new Set(SUDDEN_VALLEY_ONLY_OPPORTUNITY_KEYS);

/**
 * Shown on Sudden Valley's FIRST tax year only. Renovation money was spent in the
 * year before the rental began; the app does not decide how it is treated.
 */
const SV_FIRST_YEAR_RENOVATION_NOTE =
  "First year of the rental. Money spent renovating the property before it was first rented (2025) is generally not a deduction on the earlier year's return; whether and how it is added to the property's basis for depreciation is a CPA question — bring the 2025 renovation invoices and proof of payment.";

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
  const extraction = doc.extraction ?? null;
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
    extraction,
    verified: doc.verified === true,
    reviewHref: extraction?.actions.includes("review") ? `/documents/${doc.id}/review` : null,
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
  /** Which registry questionnaire this card opens, scoped to which entity. */
  questionnaire?: { id: string; entityId: string };
}

function makeEntryBase(
  spec: EntrySpec,
  resolveQuestionnaire: (ref: { id: string; entityId: string }) => QuestionnaireCardState | null
): FormEntry {
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
    fieldsVerified: fields.filter((f) => f.basis === "verified").length,
    fieldsUnverified: fields.filter((f) => f.basis === "unverified").length,
    fieldsOtherSource: fields.filter((f) => f.basis === "not_document_based").length,
    fields,
    missing: fields.filter((f) => !f.haveData).map((f) => ({ line: f.line, source: f.source })),
    confirmWithCpa: spec.confirmWithCpa ?? false,
    cpaNote: spec.cpaNote ?? null,
    opportunity: spec.opportunity ?? null,
    questionnaire: spec.questionnaire ? resolveQuestionnaire(spec.questionnaire) : null,
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

function planFields(
  plan: readonly FormPlan[],
  planFormName: string,
  basisByLine: Record<string, FieldBasis>,
  fixCtx: FixContext
): FormFieldStatus[] {
  const form = plan.find((f) => f.formName === planFormName);
  return form
    ? form.fields.map((f) => ({
        line: f.line,
        source: f.source,
        haveData: f.haveData,
        basis: basisByLine[f.line] ?? (f.haveData ? "not_document_based" : "missing"),
        ...(f.haveData ? {} : { fixes: resolveFieldFixes(f.line, fixCtx) }),
      }))
    : [];
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
      "Depreciation would be reported here. The fixed-asset register records cost, placed-in-service date, land value and business-use percent as inputs only; the app does not compute depreciation, choose a class, or decide Section 179 / bonus depreciation - that is a CPA decision.",
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
    reason: "The draft return computes the saver's credit from your retirement-contribution answers and the return's adjusted gross income (no credit above the Form 8880 limit); the CPA reviews it.",
  },
  {
    id: "form-8889",
    formName: "Form 8889 (Health Savings Accounts)",
    opportunityKey: "hsa",
    formMarker: "Form 8889",
    reason: "Only relevant if either spouse has an HSA-eligible plan. The draft return computes the HSA deduction from your Return completeness answers and the W-2 box 12 code W amounts (one Form 8889 per spouse).",
  },
  {
    id: "form-2210",
    formName: "Form 2210 (Underpayment of Estimated Tax)",
    opportunityKey: "safe_harbor",
    formMarker: "Form 2210",
    reason: "The IRS figures any underpayment penalty itself. The draft return shows a regular-method estimate from your payment answers and the 2024 return; the CPA decides whether to attach the form.",
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

  // Questionnaire status is attached to cards but never feeds applicability,
  // readiness or the summary counters (honesty invariant, unit-tested).
  const questionnaireRows = input.questionnaireRows ?? [];
  const resolveQuestionnaire = (ref: { id: string; entityId: string }): QuestionnaireCardState | null => {
    const def = questionnaireById(ref.id);
    if (!def) return null;
    const entity = entities.find((e) => e.id === ref.entityId) ?? null;
    const qctx: QuestionnaireContext = {
      year: taxYear,
      entityName: def.scope === "entity" ? (entity?.name ?? null) : null,
      ekcActive,
      svActive,
    };
    const row =
      questionnaireRows.find(
        (r) => r.taxYear === taxYear && r.entityId === ref.entityId && r.questionnaireId === ref.id
      ) ?? null;
    return buildCardState(def, ref.entityId, qctx, row, questions);
  };
  const makeEntry = (spec: EntrySpec): FormEntry => makeEntryBase(spec, resolveQuestionnaire);
  /** A household questionnaire is scoped to the Personal entity (none exists -> no questionnaire). */
  const householdQuestionnaire = (id: string) =>
    personalEntity ? { id, entityId: personalEntity.id } : undefined;

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
  const basisByLine = computePersonalFormPlanBasis(input.formPlanInput);
  const lineHasData: Record<string, boolean> = {};
  for (const form of plan) for (const field of form.fields) lineHasData[field.line] = field.haveData;
  const fixCtx: FixContext = {
    taxYear,
    personalEntityId: personalEntity?.id ?? null,
    ekcSlug: ekc?.slug ?? null,
    svSlug: sv?.slug ?? null,
    ekcEntityId: ekc?.id ?? null,
    svEntityId: sv?.id ?? null,
    questions,
    documents,
    lineHasData,
  };
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
    fields: planFields(plan, PLAN_FORM.f1040, basisByLine, fixCtx).filter((f) => svActive || !SV_ONLY_PLAN_LINES.has(f.line)),
    inputs: [
      ...refs(personalDocs(["w2", "1099", "extension"])),
      ...priorReturnRefs,
    ],
    cpaNote:
      "W-2s feed wages and withholding; 1099 interest box 1 (or a 1099-INT headline amount on older extractions) feeds line 2b. An extension document is informational.",
    // The guided "Return completeness" flow: none / some for the rare lines, per-person retirement, HSA, tips and overtime,
    // estimated and extension payments, use tax and the header questions. Its answers feed the computed draft return.
    questionnaire: householdQuestionnaire(RETURN_COMPLETENESS_ID),
  });

  const schedule1Required = ekcActive || svActive;
  const scheduleOne = makeEntry({
    id: "schedule-1",
    formName: "Schedule 1 (Additional Income and Adjustments to Income)",
    jurisdiction: "federal",
    filer: householdFiler,
    applicability: schedule1Required ? "required" : "conditional",
    reason: schedule1Required
      ? svActive
        ? "Business income (EK Consulting Schedule C) and/or rental income (Sudden Valley Schedule E) flow to Form 1040 through Schedule 1."
        : "Business income (EK Consulting Schedule C) flows to Form 1040 through Schedule 1."
      : "Would be needed for business/rental income or above-the-line adjustments; none of those entities apply this year.",
    source: "lib/tax-guidance.ts PERSONAL_FORM_PLAN (Form 1040 lines tagged \"Schedule 1\")",
    fields: planFields(plan, PLAN_FORM.f1040, basisByLine, fixCtx)
      .filter((f) => (SCHEDULE_1_LINES as readonly string[]).includes(f.line))
      .filter((f) => svActive || !SV_ONLY_PLAN_LINES.has(f.line)),
  });

  // Schedule A
  const propertyTaxNote =
    "A property-tax line only has data once you enter (or verify) the amount actually paid in the tax year on the bill's review screen — the AI never fills it, because a bill shows what is billed and due, not what was paid. Until then the itemized total can be understated. Charitable gifts logged on the donation log are NOT included in the 2025 draft's itemized total; AGI limits and Form 8283 are your CPA's decisions.";
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
    fields: planFields(plan, PLAN_FORM.scheduleA, basisByLine, fixCtx),
    inputs: [...refs(personalDocs(["mortgage_interest", "property_tax", "donation_receipt"])), ...priorReturnRefs],
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
    fields: planFields(plan, PLAN_FORM.scheduleC, basisByLine, fixCtx),
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
    questionnaire: seApplicability === "needs_cpa_input" ? householdQuestionnaire("schedule-se") : undefined,
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
    fields: planFields(plan, PLAN_FORM.scheduleE, basisByLine, fixCtx),
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
    cpaNote:
      svActive && sv?.foundedDate && sv.foundedDate.getUTCFullYear() === taxYear
        ? SV_FIRST_YEAR_RENOVATION_NOTE
        : null,
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
    fields: planFields(plan, PLAN_FORM.f5695, basisByLine, fixCtx),
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
    fields: planFields(plan, PLAN_FORM.ct1040, basisByLine, fixCtx),
    inputs: [...refs(personalDocs(["w2"])), ...priorReturnRefs],
    cpaNote: "W-2 box 17 (CT withholding) feeds this return.",
  });

  const propertyTaxCreditField = planFields(plan, PLAN_FORM.ct1040, basisByLine, fixCtx).filter((f) => f.line === "Property tax credit");
  const ctSchedule3 = makeEntry({
    id: "ct-schedule-3",
    formName: "CT-1040 Schedule 3 (Property Tax Credit)",
    jurisdiction: "ct",
    filer: householdFiler,
    applicability: "conditional",
    reason:
      "Depends on qualifying property tax paid and a nonzero CT-1040 line 10. \"Ready\" here only means you entered the amount paid in the tax year on a property-tax bill's review screen — the AI reads what the bill charges, not what was paid.",
    source: "specs/09 (Property tax credit, Schedule 3); lib/tax-form-plan.ts (Property tax credit field)",
    fields: propertyTaxCreditField,
    inputs: [...refs(personalDocs(["property_tax"])), ...priorReturnRefs],
  });

  // ── Needs CPA input ─────────────────────────────────────────────────────────
  const needsCpa: FormEntry[] = [];
  for (const f of CPA_INPUT_FORMS) {
    // Forms that exist in this list only because of Sudden Valley's rental are
    // omitted for a year when Sudden Valley is not active.
    if (!svActive && SV_ONLY_CPA_OPPORTUNITIES.has(f.opportunityKey)) continue;
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
        // Kept even when ruled out by a planning answer, so the answer can be reopened.
        questionnaire: householdQuestionnaire(f.id),
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
        "The draft return computes the foreign tax credit, the saver's credit, the extension payment and excess Social Security; the residential clean energy credit is not a 2025 item here (installed 2022). Other credits are for the CPA.",
      source: "lib/tax-guidance.ts TAX_QUESTION_BANK solar_credit (note references prior-year Schedule 3 / Form 5695)",
      questionnaire: householdQuestionnaire("schedule-3-federal"),
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
      questionnaire: householdQuestionnaire("qbi-deduction"),
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
      questionnaire: householdQuestionnaire("additional-medicare-tax"),
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
      questionnaire: householdQuestionnaire("child-dependent-credits"),
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
      questionnaire: householdQuestionnaire("clean-vehicle-credit"),
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
        questionnaire: householdQuestionnaire("k1-handling"),
      })
    );
  }

  // ── Entity sections ─────────────────────────────────────────────────────────
  // Sudden Valley has no filing before it was formed: for those years it is left
  // off the page entirely (no "not applicable" block). Other inactive entities
  // (e.g. Mezzo, not yet formed) keep their explanatory row.
  const businesses = entities
    .filter((e) => e.type === "business")
    .filter((e) => e.slug !== SLUG_SV || svActive)
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
          // Only the needs-CPA-input state gets a questionnaire; a recorded disregarded entity has nothing to ask.
          questionnaire: disregarded ? undefined : { id: ENTITY_FEDERAL_QUESTIONNAIRE_ID, entityId: e.id },
        }),
        makeEntry({
          id: `${e.id}-ct-entity-filing`,
          formName: "Connecticut business-entity filing",
          jurisdiction: "ct",
          filer: e.name,
          applicability: "needs_cpa_input",
          reason: "The system does not determine any Connecticut business-entity filing requirement.",
          source: "No CT business-entity rule exists in the repo (specs/09 covers the individual CT-1040 only)",
          questionnaire: { id: ENTITY_CT_QUESTIONNAIRE_ID, entityId: e.id },
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

  // Schedule E exists in this catalog only for Sudden Valley's rental, so it is
  // omitted for years before Sudden Valley existed instead of shown as "not applicable".
  const federal = [f1040, scheduleOne, scheduleA, scheduleC, scheduleSE, ...(svActive ? [scheduleE] : []), f5695];
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

  const extractionBasis: ExtractionBasisSummary = {
    policy: TAX_EXTRACTION_POLICY,
    documentCount: 0,
    verified: 0,
    unverified: 0,
    olderFormat: 0,
    noReading: 0,
  };
  for (const d of taxDocsThisYear) {
    const kind = d.extraction?.kind;
    if (!d.extraction || !kind || kind === "na") continue;
    extractionBasis.documentCount += 1;
    if (kind === "verified") extractionBasis.verified += 1;
    else if (kind === "extracted_unverified" || kind === "extracted_outdated" || kind === "extracted") {
      extractionBasis.unverified += 1;
    } else extractionBasis.noReading += 1;
    if (d.extraction.outdated) extractionBasis.olderFormat += 1;
  }

  const questionnaireSummary = summarizeQuestionnaires(
    listQuestionnaireEntries({
      federal,
      connecticut,
      needsCpaInput: needsCpa,
      entities: entitySections,
    }).map((x) => x.questionnaire)
  );

  return {
    taxYear,
    householdLabel,
    federal,
    connecticut,
    needsCpaInput: needsCpa,
    entities: entitySections,
    summary,
    questionnaireSummary,
    attribution,
    draft: taxDraft,
    personalWorkspaceExists: input.personalWorkspaceExists,
    unansweredQuestionCount: questions.filter((q) => q.answer === null).length,
    extractionBasis,
  };
}

/** Exposed for tests: the opportunity keys the catalog relies on must still exist. */
export function opportunityForms(key: string): string[] | null {
  const op = baseOpportunitiesForHousehold().find((o) => o.key === key);
  return op ? op.forms : null;
}
