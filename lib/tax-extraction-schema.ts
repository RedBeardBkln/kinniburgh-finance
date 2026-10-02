// Single source of truth for what is extracted from each tax document type
// (document-extraction-status-and-review, pass 2).
//
// ONE registry drives all of:
//   - the AI extraction PROMPT (buildTaxExtractionPrompt)
//   - the post-parse NORMALIZER (normalizeTaxExtraction): drops unknown keys,
//     scrubs SSN/ITIN-shaped text, enforces EIN format, integer cents, list caps
//     and stamps `schemaVersion`
//   - the owner-CORRECTION validator (validateCorrections)
//   - the review form (components/documents/tax-review-client.tsx)
//   - "usable extraction" detection (isUsableTaxExtraction)
//   - Forms readiness / a future PDF field-mapper, via each field's `feeds`
//     (form id + line from the Forms catalog)
//
// Pure and client-safe: no DB, no server imports, no Date.now().
//
// Ground rules honoured here:
//   - money is integer cents, never floats
//   - NO field can hold an SSN/ITIN (not even the last 4): the person is tracked
//     by Document attribution, and no form here needs the number. The prompt
//     says never to output one and the normalizer nulls anything SSN-shaped.
//   - EINs (employer/payer identification numbers) are stored only as NN-NNNNNNN
//   - existing flat keys are KEPT with the same names/meaning so documents
//     extracted before this schema (and every existing resolver) keep working

// ── Types ─────────────────────────────────────────────────────────────────────

/** The schema ("shape") a tax document is extracted into. `mortgage_interest` documents use `form_1098`. */
export type TaxSchemaDocType = "w2" | "1099" | "form_1098" | "property_tax" | "k1" | "tax_return";

export const TAX_SCHEMA_DOC_TYPES: readonly TaxSchemaDocType[] = [
  "w2",
  "1099",
  "form_1098",
  "property_tax",
  "k1",
  "tax_return",
];

export type ScalarKind =
  | "money" // integer cents
  | "int"
  | "decimal" // finite non-negative number (e.g. mill rate)
  | "pct" // 0-100
  | "text"
  | "ein" // NN-NNNNNNN only
  | "mask" // last 4 characters only (loan numbers)
  | "bool"
  | "date" // YYYY-MM-DD
  | "enum";

export type FieldKind = ScalarKind | "enumList" | "list";

export interface ScalarFieldSpec {
  key: string;
  kind: ScalarKind;
  label: string;
  options?: readonly string[];
  /** money only: may be negative (losses, signed K-1 amounts) */
  signed?: boolean;
  /** text only: stored upper-case (state / box 12 codes) */
  uppercase?: boolean;
  /** text only: shape the value SHOULD have; mismatches are non-blocking warnings, never rejections */
  pattern?: RegExp;
  min?: number;
  max?: number;
  maxLen?: number;
}

export interface FormFeed {
  /** Forms catalog id (lib/tax-forms.ts), e.g. "form-1040". */
  formId: string;
  /** The line label as written in lib/tax-guidance.ts PERSONAL_FORM_PLAN. */
  line: string;
}

export interface FieldDef extends Omit<ScalarFieldSpec, "kind"> {
  kind: FieldKind;
  /** Where on the paper form this comes from, e.g. "W-2 box 12". */
  formRef: string;
  /** Group id (see TaxSchema.groups) for the review form. */
  group: string;
  /** Counts toward "this extraction has real data" (money fields the forms read). */
  signal: boolean;
  /** Kept for older documents/resolvers; NOT asked of the model in the current prompt. */
  legacy: boolean;
  /** false = the AI never fills it (owner-entered only); the normalizer forces null. */
  aiFills: boolean;
  /** list / enumList: item cap */
  maxItems?: number;
  /** list: the columns of each row */
  itemFields?: readonly ScalarFieldSpec[];
  /** Extra guidance appended to the prompt's field guide. */
  hint?: string;
  feeds: readonly FormFeed[];
}

export interface FieldGroup {
  id: string;
  label: string;
}

export interface TaxSchema {
  docType: TaxSchemaDocType;
  /** Human title used in the prompt and the review page. */
  title: string;
  /** 2 = expanded schema (stamped on new extractions); 1 = unchanged legacy shape. */
  version: number;
  groups: readonly FieldGroup[];
  fields: readonly FieldDef[];
}

// ── Versioning ────────────────────────────────────────────────────────────────

/** Schema version stamped on expanded schemas. A stored extraction without it (or lower) is "older format". */
export const CURRENT_SCHEMA_VERSION = 2;

const EXPANDED_TYPES: readonly TaxSchemaDocType[] = ["w2", "1099", "form_1098", "property_tax", "k1"];

/** Raw Document.docType values whose schema was expanded (older extractions of these are "older format"). */
export const EXPANDED_RAW_DOC_TYPES: readonly string[] = ["w2", "1099", "mortgage_interest", "property_tax", "k1"];

export function schemaTypeForDocType(docType: string): TaxSchemaDocType | null {
  switch (docType) {
    case "w2":
      return "w2";
    case "1099":
      return "1099";
    case "mortgage_interest":
    case "form_1098":
      return "form_1098";
    case "property_tax":
      return "property_tax";
    case "k1":
      return "k1";
    case "tax_return":
      return "tax_return";
    default:
      return null;
  }
}

export function schemaVersionFor(schemaType: TaxSchemaDocType): number {
  return EXPANDED_TYPES.includes(schemaType) ? CURRENT_SCHEMA_VERSION : 1;
}

// ── Field builders ────────────────────────────────────────────────────────────

const FORM_1040 = "form-1040";
const SCHEDULE_A = "schedule-a";
const CT_1040 = "ct-1040";

function field(
  kind: FieldKind,
  key: string,
  label: string,
  formRef: string,
  group: string,
  over: Partial<FieldDef> = {}
): FieldDef {
  return { kind, key, label, formRef, group, signal: false, legacy: false, aiFills: true, feeds: [], ...over };
}

/** Money fields count as "usable signal" by default (override with signal: false). */
function money(key: string, label: string, formRef: string, group: string, over: Partial<FieldDef> = {}): FieldDef {
  return field("money", key, label, formRef, group, { signal: true, ...over });
}

const TAX_YEAR = (group: string): FieldDef =>
  field("int", "taxYear", "Tax year", "Tax year", group, { min: 1990, max: 2100 });

const MONEY_ITEM = (key: string, label: string, signed = false): ScalarFieldSpec => ({
  key,
  kind: "money",
  label,
  signed,
});

const TEXT_ITEM = (key: string, label: string, extra: Partial<ScalarFieldSpec> = {}): ScalarFieldSpec => ({
  key,
  kind: "text",
  label,
  ...extra,
});

const STATE_CODE_PATTERN = /^[A-Z]{2}$/;
const BOX12_CODE_PATTERN = /^[A-Z]{1,2}$/;

// ── W-2 ───────────────────────────────────────────────────────────────────────

const W2_SCHEMA: TaxSchema = {
  docType: "w2",
  title: "W-2 form",
  version: CURRENT_SCHEMA_VERSION,
  groups: [
    { id: "employer", label: "Employer" },
    { id: "federal", label: "Federal wages and tax (boxes 1-8)" },
    { id: "other", label: "Other boxes (10-14)" },
    { id: "state", label: "State and local (boxes 15-20)" },
  ],
  fields: [
    TAX_YEAR("employer"),
    field("text", "employerName", "Employer name", "W-2 box c", "employer"),
    field("ein", "employerEIN", "Employer EIN", "W-2 box b", "employer"),
    money("wagesCents", "Wages, tips, other compensation", "W-2 box 1", "federal", {
      feeds: [{ formId: FORM_1040, line: "Wages (line 1a)" }],
    }),
    money("federalWithheldCents", "Federal income tax withheld", "W-2 box 2", "federal", {
      feeds: [{ formId: FORM_1040, line: "Payments/withholding (line 25)" }],
    }),
    money("socialSecurityWagesCents", "Social security wages", "W-2 box 3", "federal"),
    money("socialSecurityWithheldCents", "Social security tax withheld", "W-2 box 4", "federal"),
    money("medicareWagesCents", "Medicare wages and tips", "W-2 box 5", "federal", {
      feeds: [{ formId: "additional-medicare-tax", line: "Medicare wages (W-2 box 5)" }],
    }),
    money("medicareWithheldCents", "Medicare tax withheld", "W-2 box 6", "federal"),
    money("socialSecurityTipsCents", "Social security tips", "W-2 box 7", "federal", { signal: false }),
    money("allocatedTipsCents", "Allocated tips", "W-2 box 8", "federal", { signal: false }),
    money("dependentCareBenefitsCents", "Dependent care benefits", "W-2 box 10", "other", { signal: false }),
    money("nonqualifiedPlansCents", "Nonqualified plans", "W-2 box 11", "other", { signal: false }),
    field("list", "box12", "Box 12 codes", "W-2 box 12", "other", {
      maxItems: 4,
      itemFields: [
        TEXT_ITEM("code", "Code", { uppercase: true, pattern: BOX12_CODE_PATTERN, maxLen: 2 }),
        MONEY_ITEM("amountCents", "Amount"),
      ],
      hint: "Each entry is one box 12 line: the 1-2 letter code (for example D, E, W) and its amount.",
    }),
    field("bool", "statutoryEmployee", "Statutory employee", "W-2 box 13", "other"),
    field("bool", "retirementPlan", "Retirement plan", "W-2 box 13", "other"),
    field("bool", "thirdPartySickPay", "Third-party sick pay", "W-2 box 13", "other"),
    field("list", "box14", "Box 14 other", "W-2 box 14", "other", {
      maxItems: 4,
      itemFields: [TEXT_ITEM("label", "Description"), MONEY_ITEM("amountCents", "Amount")],
    }),
    field("list", "stateLines", "State lines", "W-2 boxes 15-17", "state", {
      maxItems: 4,
      itemFields: [
        TEXT_ITEM("stateCode", "State", { uppercase: true, pattern: STATE_CODE_PATTERN, maxLen: 2 }),
        TEXT_ITEM("stateEmployerId", "State employer ID"),
        MONEY_ITEM("stateWagesCents", "State wages (box 16)"),
        MONEY_ITEM("stateWithheldCents", "State tax withheld (box 17)"),
      ],
      feeds: [{ formId: CT_1040, line: "CT withholding (W-2 box 17)" }],
      hint: "One entry per state in boxes 15-17. stateCode is the two-letter state abbreviation.",
    }),
    field("list", "localLines", "Local lines", "W-2 boxes 18-20", "state", {
      maxItems: 4,
      itemFields: [
        TEXT_ITEM("localityName", "Locality"),
        MONEY_ITEM("localWagesCents", "Local wages (box 18)"),
        MONEY_ITEM("localWithheldCents", "Local tax withheld (box 19)"),
      ],
    }),
    // LEGACY flat key (documents extracted before stateLines existed). Not asked
    // of the model; derived from stateLines (CT lines only) when those exist.
    money("stateWithheldCents", "State tax withheld (older documents)", "W-2 box 17", "state", {
      legacy: true,
      feeds: [{ formId: CT_1040, line: "CT withholding (W-2 box 17)" }],
    }),
  ],
};

// ── 1099 ──────────────────────────────────────────────────────────────────────

const VARIANTS = ["1099-NEC", "1099-INT", "1099-DIV", "1099-MISC", "1099-B", "1099-R", "1099-SSA", "other"] as const;
const FORM_VARIANT_OPTIONS = [...VARIANTS, "consolidated"] as const;

const F1099_SCHEMA: TaxSchema = {
  docType: "1099",
  title: "1099 form (it may be a consolidated 1099 that contains several 1099 types)",
  version: CURRENT_SCHEMA_VERSION,
  groups: [
    { id: "common", label: "Payer and totals" },
    { id: "nec", label: "1099-NEC (nonemployee compensation)" },
    { id: "int", label: "1099-INT (interest)" },
    { id: "div", label: "1099-DIV (dividends)" },
    { id: "misc", label: "1099-MISC (miscellaneous)" },
    { id: "other", label: "Other forms (1099-B, 1099-R, 1099-SSA, ...) and state" },
  ],
  fields: [
    TAX_YEAR("common"),
    field("enum", "formVariant", "Form type", "1099 form type", "common", {
      options: FORM_VARIANT_OPTIONS,
      hint: "The primary form's type; use consolidated when more than one 1099 form is present.",
    }),
    field("enumList", "variantsPresent", "Forms present", "1099 form types", "common", {
      options: VARIANTS,
      maxItems: 8,
      hint: "Every 1099 form type found in the document.",
    }),
    field("text", "payerName", "Payer name", "1099 payer", "common"),
    field("ein", "payerEIN", "Payer EIN", "1099 payer TIN", "common"),
    money("amountCents", "Headline amount (primary form)", "1099 box 1 (box 1a on a 1099-DIV)", "common", {
      feeds: [{ formId: FORM_1040, line: "Interest income (line 2b)" }],
      hint: "The primary form's headline amount: box 1 of NEC/INT/MISC, box 1a of DIV.",
    }),
    money("federalWithheldCents", "Federal income tax withheld (all forms)", "1099 box 4", "common", {
      feeds: [{ formId: FORM_1040, line: "Payments/withholding (line 25)" }],
      hint: "The SUM of every box 4 federal income tax withheld amount across all forms present.",
    }),
    money("nec_box1Cents", "NEC box 1 nonemployee compensation", "1099-NEC box 1", "nec"),
    money("nec_box4Cents", "NEC box 4 federal tax withheld", "1099-NEC box 4", "nec"),
    money("int_box1Cents", "INT box 1 interest income", "1099-INT box 1", "int", {
      feeds: [{ formId: FORM_1040, line: "Interest income (line 2b)" }],
    }),
    money("int_box2Cents", "INT box 2 early withdrawal penalty", "1099-INT box 2", "int"),
    money("int_box3Cents", "INT box 3 US savings bond and Treasury interest", "1099-INT box 3", "int"),
    money("int_box4Cents", "INT box 4 federal tax withheld", "1099-INT box 4", "int"),
    money("int_box5Cents", "INT box 5 investment expenses", "1099-INT box 5", "int"),
    money("int_box6Cents", "INT box 6 foreign tax paid", "1099-INT box 6", "int"),
    money("int_box8Cents", "INT box 8 tax-exempt interest", "1099-INT box 8", "int"),
    money("int_box9Cents", "INT box 9 private activity bond interest", "1099-INT box 9", "int"),
    money("div_box1aCents", "DIV box 1a total ordinary dividends", "1099-DIV box 1a", "div"),
    money("div_box1bCents", "DIV box 1b qualified dividends", "1099-DIV box 1b", "div"),
    money("div_box2aCents", "DIV box 2a total capital gain distributions", "1099-DIV box 2a", "div"),
    money("div_box3Cents", "DIV box 3 nondividend distributions", "1099-DIV box 3", "div"),
    money("div_box4Cents", "DIV box 4 federal tax withheld", "1099-DIV box 4", "div"),
    money("div_box5Cents", "DIV box 5 section 199A dividends", "1099-DIV box 5", "div"),
    money("div_box7Cents", "DIV box 7 foreign tax paid", "1099-DIV box 7", "div"),
    money("div_box11Cents", "DIV box 11 exempt-interest dividends", "1099-DIV box 11", "div"),
    money("misc_box1Cents", "MISC box 1 rents", "1099-MISC box 1", "misc"),
    money("misc_box2Cents", "MISC box 2 royalties", "1099-MISC box 2", "misc"),
    money("misc_box3Cents", "MISC box 3 other income", "1099-MISC box 3", "misc"),
    money("misc_box4Cents", "MISC box 4 federal tax withheld", "1099-MISC box 4", "misc"),
    field("list", "otherBoxes", "Other boxes (raw)", "1099-B / 1099-R / 1099-SSA / other", "other", {
      maxItems: 20,
      itemFields: [
        TEXT_ITEM("variant", "Form"),
        TEXT_ITEM("box", "Box"),
        TEXT_ITEM("label", "Description"),
        MONEY_ITEM("amountCents", "Amount", true),
      ],
      hint: "Boxes from 1099-B, 1099-R, 1099-SSA or any other form. Captured only; never summed by the app.",
    }),
    field("list", "stateLines", "State lines", "1099 state boxes", "other", {
      maxItems: 4,
      itemFields: [
        TEXT_ITEM("stateCode", "State", { uppercase: true, pattern: STATE_CODE_PATTERN, maxLen: 2 }),
        TEXT_ITEM("statePayerId", "State payer ID"),
        MONEY_ITEM("stateIncomeCents", "State income"),
        MONEY_ITEM("stateWithheldCents", "State tax withheld"),
      ],
    }),
  ],
};

// ── 1098 ──────────────────────────────────────────────────────────────────────

const F1098_SCHEMA: TaxSchema = {
  docType: "form_1098",
  title: "Form 1098 mortgage interest statement",
  version: CURRENT_SCHEMA_VERSION,
  groups: [
    { id: "lender", label: "Lender and loan" },
    { id: "boxes", label: "Form 1098 boxes" },
  ],
  fields: [
    TAX_YEAR("lender"),
    field("text", "servicerName", "Recipient / lender", "1098 recipient", "lender"),
    field("mask", "loanNumber", "Loan number (last 4)", "1098 account number", "lender", {
      hint: "Last 4 characters only.",
    }),
    money("interestCents", "Mortgage interest received", "1098 box 1", "boxes", {
      feeds: [
        { formId: SCHEDULE_A, line: "Home mortgage interest (line 8a)" },
        { formId: FORM_1040, line: "Standard or itemized (line 12)" },
      ],
    }),
    money("principalBalanceCents", "Outstanding mortgage principal", "1098 box 2", "boxes"),
    field("date", "originationDate", "Mortgage origination date", "1098 box 3", "boxes"),
    money("refundedInterestCents", "Refund of overpaid interest", "1098 box 4", "boxes", { signal: false }),
    money("mortgageInsurancePremiumsCents", "Mortgage insurance premiums", "1098 box 5", "boxes", { signal: false }),
    money("pointsPaidCents", "Points paid on purchase", "1098 box 6", "boxes", { signal: false }),
    field("bool", "addressSameAsProperty", "Payer address same as property", "1098 box 7", "boxes"),
    field("text", "propertyAddress", "Property address", "1098 box 8", "boxes", { maxLen: 300 }),
    field("int", "numberOfProperties", "Number of properties securing the mortgage", "1098 box 9", "boxes", {
      min: 0,
      max: 99,
    }),
    field("text", "box10Description", "Box 10 description", "1098 box 10", "boxes"),
    money("box10Cents", "Box 10 other (often real-estate taxes paid from escrow)", "1098 box 10", "boxes", {
      signal: false,
    }),
    field("date", "acquisitionDate", "Mortgage acquisition date", "1098 box 11", "boxes"),
  ],
};

// ── Property tax bill ─────────────────────────────────────────────────────────

const PROPERTY_TAX_TYPES = ["real_estate", "motor_vehicle", "personal_property", "other"] as const;

const PROPERTY_TAX_SCHEMA: TaxSchema = {
  docType: "property_tax",
  title: "property tax bill",
  version: CURRENT_SCHEMA_VERSION,
  groups: [
    { id: "bill", label: "Bill" },
    { id: "amounts", label: "Amounts" },
    { id: "paid", label: "Paid in the tax year (you enter this)" },
  ],
  fields: [
    TAX_YEAR("bill"),
    field("enum", "taxType", "Type of tax", "Property tax bill", "bill", { options: PROPERTY_TAX_TYPES }),
    field("text", "jurisdictionName", "Town / jurisdiction", "Property tax bill", "bill"),
    field("text", "jurisdictionState", "State", "Property tax bill", "bill", {
      uppercase: true,
      pattern: STATE_CODE_PATTERN,
      maxLen: 2,
    }),
    field("text", "parcelId", "Parcel / account ID", "Property tax bill", "bill", {
      hint: "A property identifier, not a financial account number.",
    }),
    field("text", "propertyAddress", "Property address", "Property tax bill", "bill", { maxLen: 300 }),
    money("assessedValueCents", "Assessed value", "Property tax bill", "amounts", { signal: false }),
    field("decimal", "millRate", "Mill rate", "Property tax bill", "amounts", { min: 0, max: 1000 }),
    money("totalTaxBilledCents", "Total tax billed", "Property tax bill", "amounts"),
    field("list", "installments", "Installments", "Property tax bill", "amounts", {
      maxItems: 12,
      itemFields: [
        TEXT_ITEM("label", "Installment"),
        { key: "dueDate", kind: "date", label: "Due date" },
        MONEY_ITEM("amountCents", "Amount"),
        { key: "status", kind: "enum", label: "Status", options: ["paid", "unpaid", "unknown"] },
      ],
      hint: "One entry per installment on the bill. status is paid only if the bill itself shows it as paid.",
    }),
    money("totalPaidPerBillCents", "Total paid according to the bill", "Property tax bill", "amounts", {
      signal: false,
      hint: "Only if the bill itself shows payments received; otherwise null.",
    }),
    money("paidInTaxYearCents", "Property tax actually paid in the tax year", "Entered by you", "paid", {
      signal: false,
      aiFills: false,
      feeds: [
        { formId: SCHEDULE_A, line: "State/local taxes (line 5e)" },
        { formId: CT_1040, line: "Property tax credit" },
      ],
      hint: "ALWAYS null. A bill shows what was billed and when it is due, not what was paid; the owner enters this.",
    }),
  ],
};

// ── K-1 ───────────────────────────────────────────────────────────────────────

const K1_SCHEMA: TaxSchema = {
  docType: "k1",
  title: "Schedule K-1",
  version: CURRENT_SCHEMA_VERSION,
  groups: [
    { id: "entity", label: "Entity" },
    { id: "income", label: "Income, deductions and distributions" },
    { id: "other", label: "Other boxes (raw)" },
  ],
  fields: [
    TAX_YEAR("entity"),
    field("enum", "formType", "K-1 form", "Schedule K-1 form", "entity", { options: ["1065", "1120S", "1041"] }),
    field("text", "entityName", "Partnership / S-corp / estate name", "K-1 part I", "entity"),
    field("ein", "entityEIN", "Entity EIN", "K-1 part I", "entity"),
    field("pct", "partnerSharePct", "Ownership share (%)", "K-1 part II", "entity", { min: 0, max: 100 }),
    field("bool", "finalK1", "Final K-1", "K-1 header", "entity"),
    money("ordinaryIncomeCents", "Ordinary business income (loss)", "K-1 line 1", "income", { signed: true }),
    money("netRentalRealEstateCents", "Net rental real estate income (loss)", "K-1 line 2", "income", { signed: true }),
    money("otherNetRentalCents", "Other net rental income (loss)", "K-1 line 3", "income", { signed: true }),
    money("guaranteedPaymentsCents", "Guaranteed payments", "K-1 line 4", "income", { signed: true }),
    money("interestIncomeCents", "Interest income", "K-1 line 5", "income", { signed: true }),
    money("ordinaryDividendsCents", "Ordinary dividends", "K-1 line 6a", "income", { signed: true }),
    money("qualifiedDividendsCents", "Qualified dividends", "K-1 line 6b", "income", { signed: true }),
    money("royaltiesCents", "Royalties", "K-1 line 7", "income", { signed: true }),
    money("netShortTermGainCents", "Net short-term capital gain (loss)", "K-1 line 8", "income", { signed: true }),
    money("netLongTermGainCents", "Net long-term capital gain (loss)", "K-1 line 9a", "income", { signed: true }),
    money("otherIncomeCents", "Other income (loss)", "K-1 line 11", "income", { signed: true }),
    money("section179Cents", "Section 179 deduction", "K-1 line 12", "income", { signed: true }),
    money("otherDeductionsCents", "Other deductions", "K-1 line 13", "income", { signed: true }),
    money("selfEmploymentEarningsCents", "Self-employment earnings (loss)", "K-1 line 14", "income", { signed: true }),
    money("distributionsCents", "Distributions", "K-1 line 19", "income", { signed: true }),
    money("capitalAccountCents", "Ending capital account", "K-1 item L", "income", { signed: true }),
    field("list", "otherBoxes", "Other boxes (raw)", "K-1 other boxes", "other", {
      maxItems: 20,
      itemFields: [
        TEXT_ITEM("box", "Box"),
        TEXT_ITEM("code", "Code", { maxLen: 4 }),
        TEXT_ITEM("label", "Description"),
        MONEY_ITEM("amountCents", "Amount", true),
      ],
      hint: "Any K-1 box not listed above. Captured only; never summed by the app.",
    }),
  ],
};

// ── Prior-year tax return (schema unchanged) ──────────────────────────────────

const TAX_RETURN_SCHEMA: TaxSchema = {
  docType: "tax_return",
  title: "tax return",
  version: 1,
  groups: [{ id: "return", label: "Return summary" }],
  fields: [
    TAX_YEAR("return"),
    field("enum", "formType", "Form", "Return form", "return", { options: ["1040", "1065", "1120S", "other"] }),
    field("text", "taxpayerName", "Taxpayer name", "Return header", "return"),
    money("agiCents", "Adjusted gross income", "Form 1040 line 11", "return", { signal: false, signed: true }),
    money("totalTaxCents", "Total tax", "Form 1040 line 24", "return", { signal: false }),
    money("refundCents", "Refund", "Form 1040 line 35a", "return", { signal: false }),
    money("balanceDueCents", "Balance due", "Form 1040 line 37", "return", { signal: false }),
    field("enum", "filingStatus", "Filing status", "Return header", "return", {
      options: ["single", "mfj", "mfs", "hoh", "qw"],
    }),
  ],
};

export const TAX_SCHEMAS: Readonly<Record<TaxSchemaDocType, TaxSchema>> = {
  w2: W2_SCHEMA,
  "1099": F1099_SCHEMA,
  form_1098: F1098_SCHEMA,
  property_tax: PROPERTY_TAX_SCHEMA,
  k1: K1_SCHEMA,
  tax_return: TAX_RETURN_SCHEMA,
};

export function getTaxSchema(schemaType: TaxSchemaDocType): TaxSchema {
  return TAX_SCHEMAS[schemaType];
}

export function getFieldDef(schemaType: TaxSchemaDocType, key: string): FieldDef | undefined {
  return TAX_SCHEMAS[schemaType].fields.find((f) => f.key === key);
}

/** Fields the model is asked to fill (excludes legacy-only keys). */
export function promptFields(schemaType: TaxSchemaDocType): FieldDef[] {
  return TAX_SCHEMAS[schemaType].fields.filter((f) => !f.legacy);
}

// ── Usable-signal detection ───────────────────────────────────────────────────

/** Money keys that count as "this extraction has real data" for a tax docType (raw or schema name). */
export function usableSignalKeys(docType: string): string[] {
  const schemaType = schemaTypeForDocType(docType);
  if (!schemaType) return [];
  return TAX_SCHEMAS[schemaType].fields.filter((f) => f.signal).map((f) => f.key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when at least one signal money field in `extractionData.data` is
 * non-null. Types with no signal fields (tax_return) are always "usable" here;
 * the caller still applies the generic hasUsableExtraction check.
 */
export function isUsableTaxExtraction(docType: string, extractionData: unknown): boolean {
  const keys = usableSignalKeys(docType);
  if (keys.length === 0) return true;
  if (!isRecord(extractionData)) return false;
  const data = extractionData.data;
  if (!isRecord(data)) return false;
  return keys.some((key) => data[key] !== null && data[key] !== undefined);
}

// ── SSN / ITIN scrubbing ──────────────────────────────────────────────────────

// 9 digits standing alone, either bare or grouped 3-2-4 with an optional single
// separator between groups: hyphen, whitespace, dot, any Unicode dash U+2010-2015
// (hyphen, non-breaking hyphen, figure dash, en/em dash, horizontal bar) or the
// minus sign U+2212. Text is NFKC-normalized first so fullwidth digits/hyphens
// and non-breaking spaces collapse to their ASCII forms. Requires \b before the
// 3-digit group and after the 4-digit group, so longer digit runs (amounts, IDs
// with 10+ digits), EINs (2-7) and dates (4-2-2) do not match.
const SSN_LIKE = /\b\d{3}[-\s.‐-―−]?\d{2}[-\s.‐-―−]?\d{4}\b/;

export function containsSsnLikeText(text: string): boolean {
  return SSN_LIKE.test(text.normalize("NFKC"));
}

const SSN_WARNING = "removed text that looked like an SSN";
const SSN_SUMMARY_PLACEHOLDER = "Summary withheld: it contained text that looked like a Social Security Number.";

// ── Scalar conversion (shared by the normalizer and the correction validator) ──

type Converted = { ok: true; value: unknown } | { ok: false; reason: string; ssn?: boolean };

const ok = (value: unknown): Converted => ({ ok: true, value });
const bad = (reason: string): Converted => ({ ok: false, reason });

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const DEFAULT_TEXT_MAX = 200;

function isRealDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

function convertScalar(spec: ScalarFieldSpec, raw: unknown, strict: boolean): Converted {
  if (raw === null || raw === undefined) return ok(null);
  switch (spec.kind) {
    case "money": {
      let n: number;
      if (typeof raw === "number") n = raw;
      else if (!strict && typeof raw === "string" && /^-?\d+$/.test(raw.trim())) n = Number(raw.trim());
      else return bad("must be a whole number of cents");
      if (!Number.isSafeInteger(n)) return bad("must be a whole number of cents");
      if (n < 0 && !spec.signed) return bad("cannot be negative");
      return ok(n === 0 ? 0 : n);
    }
    case "int": {
      let n: number;
      if (typeof raw === "number") n = raw;
      else if (!strict && typeof raw === "string" && /^-?\d+$/.test(raw.trim())) n = Number(raw.trim());
      else return bad("must be a whole number");
      if (!Number.isSafeInteger(n)) return bad("must be a whole number");
      if (spec.min !== undefined && n < spec.min) return bad(`must be at least ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) return bad(`must be at most ${spec.max}`);
      return ok(n);
    }
    case "decimal":
    case "pct": {
      let n: number;
      if (typeof raw === "number") n = raw;
      else if (!strict && typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())) n = Number(raw.trim());
      else return bad("must be a number");
      if (!Number.isFinite(n)) return bad("must be a number");
      const min = spec.min ?? 0;
      const max = spec.max ?? (spec.kind === "pct" ? 100 : 1_000_000);
      if (n < min || n > max) return bad(`must be between ${min} and ${max}`);
      return ok(n);
    }
    case "bool": {
      if (typeof raw === "boolean") return ok(raw);
      if (!strict && typeof raw === "string") {
        const s = raw.trim().toLowerCase();
        if (s === "true") return ok(true);
        if (s === "false") return ok(false);
      }
      return bad("must be yes or no");
    }
    case "date": {
      if (typeof raw !== "string" || !isRealDate(raw.trim())) return bad("must be a date (YYYY-MM-DD)");
      return ok(raw.trim());
    }
    case "enum": {
      if (typeof raw !== "string") return bad("is not one of the allowed values");
      const options = spec.options ?? [];
      const trimmed = raw.trim();
      if (options.includes(trimmed)) return ok(trimmed);
      if (!strict) {
        const found = options.find((o) => o.toLowerCase() === trimmed.toLowerCase());
        if (found) return ok(found);
      }
      return bad("is not one of the allowed values");
    }
    case "ein": {
      if (typeof raw !== "string") return bad("must be formatted NN-NNNNNNN");
      const trimmed = raw.trim();
      if (!/^\d{2}-\d{7}$/.test(trimmed)) return bad("must be formatted NN-NNNNNNN");
      return ok(trimmed);
    }
    case "mask": {
      if (typeof raw !== "string" && typeof raw !== "number") return bad("must be text");
      const alnum = String(raw).replace(/[^A-Za-z0-9]/g, "");
      if (alnum === "") return ok(null);
      return ok(alnum.slice(-4));
    }
    case "text": {
      let s: string;
      if (typeof raw === "string") s = raw;
      else if (!strict && typeof raw === "number" && Number.isFinite(raw)) s = String(raw);
      else return bad("must be text");
      s = s.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
      if (s === "") return ok(null);
      if (containsSsnLikeText(s)) return { ok: false, reason: "looks like a Social Security Number", ssn: true };
      const maxLen = spec.maxLen ?? DEFAULT_TEXT_MAX;
      if (s.length > maxLen) {
        if (strict) return bad(`must be at most ${maxLen} characters`);
        s = s.slice(0, maxLen);
      }
      if (spec.uppercase) s = s.toUpperCase();
      return ok(s);
    }
  }
}

function convertField(def: FieldDef, raw: unknown, strict: boolean, warnings: string[]): Converted {
  if (raw === null || raw === undefined) return ok(null);

  if (def.kind === "enumList") {
    if (!Array.isArray(raw)) return bad("must be a list");
    const max = def.maxItems ?? 8;
    if (strict && raw.length > max) return bad(`can have at most ${max} entries`);
    const out: string[] = [];
    for (const item of raw.slice(0, max)) {
      const c = convertScalar({ key: def.key, kind: "enum", label: def.label, options: def.options }, item, strict);
      if (!c.ok) {
        if (strict) return bad(`has an entry that ${c.reason}`);
        continue;
      }
      if (typeof c.value === "string" && !out.includes(c.value)) out.push(c.value);
    }
    return ok(out);
  }

  if (def.kind === "list") {
    if (!Array.isArray(raw)) return bad("must be a list");
    const max = def.maxItems ?? 4;
    if (raw.length > max) {
      if (strict) return bad(`can have at most ${max} rows`);
      warnings.push(`${def.label}: kept the first ${max} of ${raw.length} rows`);
    }
    const items = def.itemFields ?? [];
    const rows: Record<string, unknown>[] = [];
    for (const rawRow of raw.slice(0, max)) {
      if (!isRecord(rawRow)) {
        if (strict) return bad("has a row that is not a set of fields");
        continue;
      }
      if (strict) {
        const unknown = Object.keys(rawRow).find((k) => !items.some((i) => i.key === k));
        if (unknown) return bad(`has an unknown column "${unknown}"`);
      }
      const row: Record<string, unknown> = {};
      let anyValue = false;
      for (const item of items) {
        const c = convertScalar(item, rawRow[item.key], strict);
        if (!c.ok) {
          if (strict) return bad(`${item.label} ${c.reason}`);
          row[item.key] = null;
          warnings.push(c.ssn ? SSN_WARNING : `${def.label} / ${item.label}: ${c.reason} - cleared`);
          continue;
        }
        row[item.key] = c.value;
        if (c.value !== null) anyValue = true;
      }
      if (anyValue) rows.push(row);
    }
    return ok(rows);
  }

  // list / enumList were handled above, so what is left is a scalar kind.
  return convertScalar(def as ScalarFieldSpec, raw, strict);
}

// ── Legacy-key derivation ─────────────────────────────────────────────────────

/**
 * W-2 legacy `stateWithheldCents` = withholding on the CT state lines (the
 * existing compute treats it as CT withholding). null when there are no state
 * lines at all; 0 when there are lines but none is CT.
 */
export function sumCtWithholding(stateLines: unknown): number | null {
  if (!Array.isArray(stateLines) || stateLines.length === 0) return null;
  let sum = 0;
  for (const line of stateLines) {
    if (!isRecord(line) || line.stateCode !== "CT") continue;
    const amount = line.stateWithheldCents;
    if (typeof amount === "number" && Number.isSafeInteger(amount)) sum += amount;
  }
  return sum;
}

/**
 * Fills legacy flat keys that older resolvers still read from the new
 * structured fields. Returns a new object; only W-2 `stateWithheldCents` today.
 * An explicit existing non-null legacy value is left alone unless `force`.
 */
export function deriveLegacyKeys(
  schemaType: TaxSchemaDocType,
  data: Record<string, unknown>,
  force = false
): Record<string, unknown> {
  if (schemaType !== "w2") return data;
  const lines = data.stateLines;
  if (!Array.isArray(lines) || lines.length === 0) return data;
  if (!force && data.stateWithheldCents !== null && data.stateWithheldCents !== undefined) return data;
  return { ...data, stateWithheldCents: sumCtWithholding(lines) };
}

// ── Normalizer ────────────────────────────────────────────────────────────────

export interface NormalizedTaxExtraction {
  docType: TaxSchemaDocType;
  summary: string;
  data: Record<string, unknown>;
  warnings: string[];
  schemaVersion: number;
}

const SUMMARY_MAX = 500;

/**
 * Post-parse clean-up of a model response, in ONE place (called from both
 * extract functions in lib/doc-extract.ts). Defense in depth, because the model
 * can ignore instructions:
 *   - drops every key not in the registry
 *   - nulls any string value that looks like an SSN/ITIN (including list rows)
 *     and replaces an SSN-bearing summary
 *   - accepts *EIN fields only as NN-NNNNNNN
 *   - requires integer cents, caps list lengths, forces owner-entered fields to null
 *   - stamps `schemaVersion`
 * Never throws; problems become `warnings`.
 */
export function normalizeTaxExtraction(schemaType: TaxSchemaDocType, parsed: unknown): NormalizedTaxExtraction {
  const schema = TAX_SCHEMAS[schemaType];
  const warnings: string[] = [];
  const addWarning = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  const obj = isRecord(parsed) ? parsed : {};
  const rawData = isRecord(obj.data) ? obj.data : {};

  let data: Record<string, unknown> = {};
  for (const def of schema.fields) {
    const present = def.key in rawData;
    if (!def.aiFills) {
      data[def.key] = null;
      continue;
    }
    if (!present) {
      if (!def.legacy) data[def.key] = null;
      continue;
    }
    const local: string[] = [];
    const c = convertField(def, rawData[def.key], false, local);
    local.forEach(addWarning);
    if (c.ok) {
      data[def.key] = c.value;
    } else {
      data[def.key] = null;
      addWarning(c.ssn ? SSN_WARNING : `${def.label}: ${c.reason} - cleared`);
    }
  }
  data = deriveLegacyKeys(schemaType, data);

  let summary = "";
  if (typeof obj.summary === "string") {
    const cleaned = obj.summary.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX);
    if (containsSsnLikeText(cleaned)) {
      summary = SSN_SUMMARY_PLACEHOLDER;
      addWarning(SSN_WARNING);
    } else {
      summary = cleaned;
    }
  }

  return { docType: schemaType, summary, data, warnings, schemaVersion: schemaVersionFor(schemaType) };
}

// ── Correction validation ─────────────────────────────────────────────────────

export type CorrectionsValidation =
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Strict validation of owner-entered values (key -> value). Rejects unknown
 * keys, wrong kinds, non-integer cents, malformed EIN/date/enum values and any
 * SSN-shaped text. `null` is always allowed ("blank on the form"). Returns the
 * cleaned values (text trimmed, upper-cased where the field requires it).
 */
export function validateCorrections(schemaType: TaxSchemaDocType, fields: unknown): CorrectionsValidation {
  if (!isRecord(fields)) return { ok: false, error: "Corrections must be a set of fields" };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const def = getFieldDef(schemaType, key);
    if (!def) return { ok: false, error: `Unknown field: ${key}` };
    const c = convertField(def, value, true, []);
    if (!c.ok) return { ok: false, error: `${def.label} ${c.reason}` };
    out[key] = c.value;
  }
  return { ok: true, fields: out };
}

// ── Non-blocking cross-field warnings ─────────────────────────────────────────

export interface WarningContext {
  /** Document.taxYear (the year the owner filed it under). */
  documentTaxYear?: number | null;
}

/**
 * Plausibility warnings for the review screen. NEVER blocks a save: the owner
 * may know better than the heuristic. Operates on effective (corrected) data.
 */
export function crossFieldWarnings(
  schemaType: TaxSchemaDocType,
  data: Record<string, unknown>,
  context: WarningContext = {}
): string[] {
  const out: string[] = [];
  const num = (key: string): number | null => {
    const v = data[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  const taxYear = num("taxYear");
  if (taxYear !== null && context.documentTaxYear != null && taxYear !== context.documentTaxYear) {
    out.push(`The form says tax year ${taxYear} but this document is filed under ${context.documentTaxYear}.`);
  }

  if (schemaType === "1099") {
    const a = num("div_box1aCents");
    const b = num("div_box1bCents");
    if (a !== null && b !== null && b > a) {
      out.push("DIV box 1b (qualified dividends) is larger than box 1a (total ordinary dividends).");
    }
  }

  if (schemaType === "w2") {
    const lines = data.box12;
    if (Array.isArray(lines)) {
      for (const line of lines) {
        const code = isRecord(line) ? line.code : null;
        if (typeof code === "string" && !BOX12_CODE_PATTERN.test(code)) {
          out.push(`Box 12 code "${code}" is not a 1-2 letter code.`);
        }
      }
    }
  }

  if (schemaType === "w2" || schemaType === "1099") {
    const lines = data.stateLines;
    if (Array.isArray(lines) && lines.some((l) => isRecord(l) && !l.stateCode)) {
      out.push("A state line has no state code, so it cannot be matched to a state return.");
    }
  }

  if (schemaType === "property_tax") {
    const installments = data.installments;
    const total = num("totalTaxBilledCents");
    if (Array.isArray(installments) && installments.length > 0 && total !== null) {
      const sum = installments.reduce<number>(
        (acc, i) => acc + (isRecord(i) && typeof i.amountCents === "number" ? i.amountCents : 0),
        0
      );
      if (sum !== total) {
        out.push("The installments do not add up to the total tax billed.");
      }
    }
  }
  return out;
}

/**
 * Sum of property-tax installments whose due date falls in `taxYear`
 * (calendar year). A SUGGESTION only: it assumes each was paid when due, which
 * the bill itself cannot show. null when there is nothing to sum.
 */
export function sumInstallmentsDueInYear(installments: unknown, taxYear: number): number | null {
  if (!Array.isArray(installments)) return null;
  let sum = 0;
  let count = 0;
  for (const i of installments) {
    if (!isRecord(i)) continue;
    const due = i.dueDate;
    const amount = i.amountCents;
    if (typeof due === "string" && due.startsWith(`${taxYear}-`) && typeof amount === "number") {
      sum += amount;
      count += 1;
    }
  }
  return count > 0 ? sum : null;
}

// ── Dollar input <-> cents ────────────────────────────────────────────────────

const DOLLARS_RE = /^(-?)\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * Strict dollars-input parser for the review form. Accepts an optional leading
 * `-`, an optional `$`, digits with optional thousands commas, and 0-2 decimal
 * places. Returns integer cents, or null for anything else (never NaN, never a
 * float computation).
 */
export function dollarsInputToCents(input: string, options: { allowNegative?: boolean } = {}): number | null {
  const match = DOLLARS_RE.exec(input.trim());
  if (!match) return null;
  const negative = match[1] === "-";
  if (negative && !options.allowNegative) return null;
  const whole = Number((match[2] ?? "").replace(/,/g, ""));
  const fraction = Number(((match[3] ?? "") + "00").slice(0, 2));
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? (cents === 0 ? 0 : -cents) : cents;
}

/** Integer cents -> "1234.56" (no commas, suitable for an editable input). */
export function centsToDollarsInput(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Integer cents -> "$1,234.56" for display. */
export function formatCentsDisplay(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

// ── Prompt generation ─────────────────────────────────────────────────────────

function scalarPlaceholder(spec: ScalarFieldSpec): string {
  switch (spec.kind) {
    case "money":
    case "int":
      return "0";
    case "decimal":
    case "pct":
      return "0.0";
    case "bool":
      return "false";
    case "date":
      return '"YYYY-MM-DD"';
    case "ein":
      return '"XX-XXXXXXX"';
    case "mask":
      return '"last 4 only"';
    case "enum":
      return `"${(spec.options ?? []).join("|")}"`;
    case "text":
      return '"text"';
  }
}

function fieldPlaceholder(def: FieldDef): string {
  if (def.kind === "enumList") return `["${(def.options ?? []).join("|")}"]`;
  if (def.kind === "list") {
    const cols = (def.itemFields ?? []).map((i) => `"${i.key}": ${scalarPlaceholder(i)}`).join(", ");
    return `[ { ${cols} } ]`;
  }
  return scalarPlaceholder(def as ScalarFieldSpec);
}

const PROMPT_RULES = [
  "Rules:",
  "- All dollar amounts are integer cents (for example $1,234.56 is 123456). Never use decimals for money.",
  "- Use null for any box that is blank, not present on this document, or unreadable. Never guess and never invent a value.",
  "- taxYear is an integer. Dates are YYYY-MM-DD. Lists are empty arrays when there is nothing to list.",
  "- PRIVACY: never output a Social Security Number, ITIN or taxpayer ID of an individual in any field, including summary. Ignore W-2 box a and any recipient, borrower, partner or shareholder identification number.",
  "- Employer/payer/entity identification numbers (EINs) only as NN-NNNNNNN, and only for businesses, never for an individual.",
  "- Loan and account numbers: last 4 characters only.",
];

const TYPE_RULES: Partial<Record<TaxSchemaDocType, string[]>> = {
  "1099": [
    "- A consolidated 1099 contains several forms. Fill the boxes of EACH form present using the nec_, int_, div_ and misc_ prefixed fields, list every form found in variantsPresent, and set formVariant to consolidated when more than one form is present.",
    "- amountCents is the primary form's headline amount; federalWithheldCents is the SUM of every box 4 amount across all forms.",
    "- 1099-B, 1099-R, 1099-SSA and any other form: put their boxes in otherBoxes only, never in the prefixed fields.",
  ],
  form_1098: [
    "- This is the annual Form 1098 (not a monthly statement). interestCents is box 1; principalBalanceCents is box 2 (outstanding principal).",
  ],
  property_tax: [
    "- paidInTaxYearCents must ALWAYS be null: a bill shows what was billed and when it is due, not what was paid.",
    "- totalPaidPerBillCents only if the bill itself shows payments received; otherwise null.",
  ],
  w2: [
    "- Put each box 12 line (code and amount) in box12, each box 14 line in box14, and each state/local line in stateLines/localLines. Do not repeat box 17 anywhere else.",
  ],
  k1: [
    "- partnerSharePct is the ownership percentage as a number from 0 to 100. Amounts can be negative (losses).",
    "- Any K-1 box not listed goes in otherBoxes.",
  ],
};

/**
 * The extraction prompt for a tax schema, GENERATED from the registry so the
 * prompt, normalizer and review form cannot drift apart. The JSON template
 * lists exactly the registry's non-legacy keys.
 */
export function buildTaxExtractionPrompt(schemaType: TaxSchemaDocType): string {
  const schema = TAX_SCHEMAS[schemaType];
  const fields = promptFields(schemaType);
  const dataLines = fields.map((f, i) => `    "${f.key}": ${fieldPlaceholder(f)}${i < fields.length - 1 ? "," : ""}`);
  const guide = fields.map((f) => {
    const kindNote =
      f.kind === "money" ? " (integer cents)" : f.kind === "ein" ? " (NN-NNNNNNN)" : f.kind === "mask" ? " (last 4 only)" : "";
    return `- ${f.key}: ${f.label} - ${f.formRef}${kindNote}${f.hint ? `. ${f.hint}` : ""}`;
  });

  return [
    `Extract from this ${schema.title} and return ONLY valid JSON:`,
    "{",
    `  "docType": "${schemaType}",`,
    '  "summary": "1-2 sentence description (no Social Security Number or taxpayer ID)",',
    '  "data": {',
    ...dataLines,
    "  }",
    "}",
    "Field guide:",
    ...guide,
    ...PROMPT_RULES,
    ...(TYPE_RULES[schemaType] ?? []),
  ].join("\n");
}
