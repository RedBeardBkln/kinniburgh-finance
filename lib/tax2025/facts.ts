// Ty2025Facts: THE single input to the return engine. Built only by
// resolveFacts() (lib/tax2025/resolve-facts.ts) from plain rows; never from the DB
// directly. Everything here is JSON-serializable (integer cents, strings, arrays)
// so the zod schema below validates the whole object, and a later phase can store
// or ship it unchanged.
//
// Convention: a nullable number = "not read / not answered" = MISSING (never 0).
// Scalar facts that come from answers or are derived carry full provenance
// (`Sourced<T>`); facts that come from a document row carry the document's
// provenance once on the row (`basis`, `refs`, `legacyFormat`).

import { z } from "zod";
import { NONE_GROUP_IDS, type NoneGroupId } from "@/lib/tax2025/line-catalog";
import { BASES, type Basis } from "@/lib/tax2025/types";

const refKindSchema = z.enum([
  "document",
  "questionnaire",
  "planning",
  "gl",
  "fixed_asset",
  "donation",
  "mileage",
  "paystub",
  "constant",
  "decision",
]);

export const refSchema = z.object({
  kind: refKindSchema,
  id: z.string(),
  label: z.string(),
});

const basisSchema = z.enum(BASES as unknown as [Basis, ...Basis[]]);
/** Document-derived rows are only ever one of these two. */
const docBasisSchema = z.enum(["doc_verified", "doc_unverified"]);

/** `Sourced<T>` as a zod schema. */
export function sourcedSchema<T extends z.ZodTypeAny>(inner: T) {
  return z.object({
    value: inner.nullable(),
    basis: basisSchema.nullable(),
    refs: z.array(refSchema),
    note: z.string().optional(),
  });
}

const cents = z.number().int();
const centsOrNull = cents.nullable();

export const estimatedPaymentSchema = z.object({
  /** YYYY-MM-DD the payment was made (cash basis decides Schedule A). */
  paidOn: z.string(),
  amountCents: cents,
  /** The tax year the payment is for (a Jan 2026 payment can be for 2025). */
  appliesToTaxYear: z.number().int(),
});
export type EstimatedPayment = z.infer<typeof estimatedPaymentSchema>;

// ── Income ────────────────────────────────────────────────────────────────────

export const w2FactSchema = z.object({
  docId: z.string(),
  employer: z.string().nullable(),
  /** Employer EIN as printed (NN-NNNNNNN). Needed for CT withholding rows and the Form 8995 trade row. */
  employerEin: z.string().nullable(),
  /** Document.subjectUserId; null = not assigned to a person (open item). */
  personUserId: z.string().nullable(),
  subjectType: z.string().nullable(),
  basis: docBasisSchema,
  legacyFormat: z.boolean(),
  refs: z.array(refSchema),
  wagesCents: centsOrNull,
  fedWithheldCents: centsOrNull,
  socialSecurityWagesCents: centsOrNull,
  socialSecurityWithheldCents: centsOrNull,
  medicareWagesCents: centsOrNull,
  medicareWithheldCents: centsOrNull,
  socialSecurityTipsCents: centsOrNull,
  dependentCareBenefitsCents: centsOrNull,
  box12: z.array(z.object({ code: z.string(), amountCents: cents })),
  retirementPlan: z.boolean().nullable(),
  box14: z.array(z.object({ label: z.string(), amountCents: cents })),
  stateLines: z.array(
    z.object({
      stateCode: z.string().nullable(),
      wagesCents: centsOrNull,
      withheldCents: centsOrNull,
    })
  ),
  /** CT-only withholding (state lines coded CT; legacy flat amount for old docs); null = nothing read. */
  ctWithheldCents: centsOrNull,
});
export type W2Fact = z.infer<typeof w2FactSchema>;

export const interestFactSchema = z.object({
  docId: z.string(),
  payer: z.string().nullable(),
  basis: docBasisSchema,
  legacyFormat: z.boolean(),
  refs: z.array(refSchema),
  /** Interest box 1 (or the legacy headline amount of a 1099-INT when box 1 was never read). */
  box1Cents: centsOrNull,
  usedLegacyHeadline: z.boolean(),
  box3Cents: centsOrNull, // US savings bond / Treasury interest (federal taxable, CT subtraction)
  box4Cents: centsOrNull,
  box6Cents: centsOrNull,
  box8Cents: centsOrNull,
  box9Cents: centsOrNull,
});
export type InterestFact = z.infer<typeof interestFactSchema>;

export const dividendFactSchema = z.object({
  docId: z.string(),
  payer: z.string().nullable(),
  basis: docBasisSchema,
  legacyFormat: z.boolean(),
  refs: z.array(refSchema),
  box1aCents: centsOrNull,
  box1bCents: centsOrNull,
  box2aCents: centsOrNull,
  box3Cents: centsOrNull,
  box4Cents: centsOrNull,
  box5Cents: centsOrNull,
  box7Cents: centsOrNull,
  box11Cents: centsOrNull,
});
export type DividendFact = z.infer<typeof dividendFactSchema>;

/** Income this engine does not compute (1099-B / R / SSA / MISC / NEC boxes): captured so it is never lost. */
export const otherIncomeBoxSchema = z.object({
  docId: z.string(),
  payer: z.string().nullable(),
  basis: docBasisSchema,
  variant: z.string(),
  box: z.string(),
  label: z.string(),
  amountCents: centsOrNull,
});
export type OtherIncomeBox = z.infer<typeof otherIncomeBoxSchema>;

export const glLineFactSchema = z.object({
  /** The GL code row's id and code as stored. */
  glCodeId: z.string(),
  code: z.string(),
  name: z.string(),
  glType: z.enum(["revenue", "expense"]),
  /** Unsigned total for the year, integer cents (computePL's abs total). */
  totalCents: cents,
});
export type GlLineFact = z.infer<typeof glLineFactSchema>;

export const mileageFactSchema = z.object({
  id: z.string().optional(),
  miles: z.number().int(),
  /** Rate captured at entry time, as a decimal string (e.g. "0.700"). */
  ratePerMile: z.string(),
  dateIso: z.string(),
});

export const fixedAssetFactSchema = z.object({
  id: z.string(),
  description: z.string(),
  placedInServiceIso: z.string(),
  costBasisCents: cents,
  isRealProperty: z.boolean(),
  landValueCents: centsOrNull,
  businessUsePercent: z.number().int(),
});
export type FixedAssetFact = z.infer<typeof fixedAssetFactSchema>;

const scheduleCSchema = z.object({
  /** The household member who owns EK Consulting (single-member LLC). */
  ownerUserId: sourcedSchema(z.string()),
  /** Revenue and expense GL totals for the year, by account (EKC books). */
  glLines: z.array(glLineFactSchema),
  /** True when the entity has no GL-coded P&L activity at all (books not coded). */
  booksEmpty: z.boolean(),
  /** GL-coded transactions that are NOT P&L (balance-sheet / equity / unknown type): count, for the notes. */
  glExcludedTransactionCount: z.number().int(),
  mileage: z.array(mileageFactSchema),
  /** Planning answer business_mileage = "no": the owner confirms there was NO business mileage (a real $0, not missing). */
  mileageNoneConfirmed: sourcedSchema(z.boolean()),
  homeOfficeEligibility: sourcedSchema(z.enum(["yes_exclusive", "yes_shared", "no"])),
  homeOfficeSqft: sourcedSchema(z.number().int()),
  fixedAssets: z.array(fixedAssetFactSchema),
  fixedAssetsNoneConfirmed: z.boolean(),
});

// ── Deductions ────────────────────────────────────────────────────────────────

export const mortgageFactSchema = z.object({
  docId: z.string(),
  lender: z.string().nullable(),
  basis: docBasisSchema,
  legacyFormat: z.boolean(),
  refs: z.array(refSchema),
  interestCents: centsOrNull, // box 1
  principalCents: centsOrNull, // box 2 (outstanding principal)
  originationDate: z.string().nullable(), // box 3
  mortgageInsuranceCents: centsOrNull, // box 5
  pointsCents: centsOrNull, // box 6
  box10Cents: centsOrNull,
  propertyAddress: z.string().nullable(),
});
export type MortgageFact = z.infer<typeof mortgageFactSchema>;

export const PROPERTY_BILL_KINDS = [
  "primary_residence",
  "motor_vehicle",
  /** Real estate that is not the primary residence (second home / Arbor Rd in 2025). */
  "other_real_estate",
  /** Personal property tax that is not a motor vehicle. */
  "other_personal_property",
  /** Cannot tell yet: the engine reports missing input. */
  "unclassified",
] as const;
export type PropertyBillKind = (typeof PROPERTY_BILL_KINDS)[number];

export const propertyTaxBillSchema = z.object({
  docId: z.string(),
  label: z.string(),
  basis: docBasisSchema,
  legacyFormat: z.boolean(),
  refs: z.array(refSchema),
  taxType: z.string().nullable(),
  address: z.string().nullable(),
  billedCents: centsOrNull,
  /** Owner-entered "paid in the tax year" amount; null = not entered (never 0). */
  paidInYearCents: centsOrNull,
  kind: z.enum(PROPERTY_BILL_KINDS),
  kindBasis: basisSchema.nullable(),
  kindNote: z.string().optional(),
});
export type PropertyTaxBill = z.infer<typeof propertyTaxBillSchema>;

export const donationFactSchema = z.object({
  id: z.string(),
  dateIso: z.string(),
  recipient: z.string(),
  kind: z.enum(["cash", "noncash"]),
  amountCents: cents,
  substantiation: z.string(),
  receiptDocumentId: z.string().nullable(),
});
export type DonationFact = z.infer<typeof donationFactSchema>;

// ── The facts object ──────────────────────────────────────────────────────────

export const ty2025FactsSchema = z.object({
  taxYear: z.literal(2025),
  household: z.object({
    /** Planning answer "filing_status"; the engine is MFJ-only and refuses anything else. */
    filingStatus: sourcedSchema(z.string()),
    people: z.array(z.object({ userId: z.string(), name: z.string() })),
    /** Planning answer household_members = "none". */
    noDependents: sourcedSchema(z.boolean()),
    /** Planning answer ev_vehicle = "no". */
    noEvPurchase: sourcedSchema(z.boolean()),
  }),
  income: z.object({
    w2s: z.array(w2FactSchema),
    w2Unusable: z.array(z.object({ docId: z.string(), reason: z.string() })),
    interest: z.array(interestFactSchema),
    /** Owner confirmed there is no interest income (no 1099-INT). */
    noInterestConfirmed: sourcedSchema(z.boolean()),
    dividends: z.array(dividendFactSchema),
    noDividendsConfirmed: sourcedSchema(z.boolean()),
    otherIncomeBoxes: z.array(otherIncomeBoxSchema),
    scheduleC: scheduleCSchema,
  }),
  /** Above-the-line adjustments STATED by the owner/CPA (cents). Null = not stated: the line stays not-yet-computed / missing, never 0. */
  adjustments: z.object({
    /** Schedule 1-A total (1040 line 13b); Phase 1b computes it. */
    sch1a: sourcedSchema(cents),
    hsa: sourcedSchema(cents),
    ira: sourcedSchema(cents),
    seRetirement: sourcedSchema(cents),
    seHealthInsurance: sourcedSchema(cents),
  }),
  /** Nonrefundable credits STATED by the owner/CPA (cents). Phase 1b computes these lines; null = not yet computed. */
  credits: z.object({
    /** Schedule 3 line 1. */
    foreignTax: sourcedSchema(cents),
    /** Schedule 3 line 4 (Form 8880). */
    savers: sourcedSchema(cents),
  }),
  /**
   * Owner/CPA statements that a whole group of rare lines does not apply ("no other income types", ...).
   * Without the statement those lines stay not_yet_computed (never 0). See line-catalog.ts NONE_GROUP_TEXT.
   */
  statedNone: z.record(z.enum(NONE_GROUP_IDS as [NoneGroupId, ...NoneGroupId[]]), sourcedSchema(z.boolean())),
  deductions: z.object({
    mortgages: z.array(mortgageFactSchema),
    propertyTaxBills: z.array(propertyTaxBillSchema),
    /** Owner confirmed there are no property tax bills to report. */
    noPropertyTaxConfirmed: sourcedSchema(z.boolean()),
    donations: z.array(donationFactSchema),
    noDonationsConfirmed: sourcedSchema(z.boolean()),
    /** Address of the primary residence, used to classify real-estate bills. */
    primaryResidenceAddress: sourcedSchema(z.string()),
  }),
  payments: z.object({
    /** Federal income tax withheld: W-2 box 2 sum (only docs that read it) lives on the W-2 rows; these are the other sources. */
    federal1099WithheldCents: cents,
    federalPaystubWithheldCents: cents,
    ctPaystubWithheldCents: cents,
    federalEstimates: sourcedSchema(z.array(estimatedPaymentSchema)),
    /** Form 4868 payment (Schedule 3 line 10). */
    federalExtensionPayment: sourcedSchema(cents),
    /** 2024 overpayment applied to 2025 (1040 line 26). */
    federalPriorYearOverpaymentApplied: sourcedSchema(cents),
    ctEstimates: sourcedSchema(z.array(estimatedPaymentSchema)),
    /** CT-1040 EXT payment (line 20). */
    ctExtensionPayment: sourcedSchema(cents),
    ctPriorYearOverpaymentApplied: sourcedSchema(cents),
    /** Balance of the 2024 CT return paid during 2025 (counts toward 2025 SALT). */
    ctPriorYearBalancePaidIn2025: sourcedSchema(cents),
    /** The legacy single "federal + state estimated payments" answer: cannot be split, kept only to flag. */
    combinedEstimatesAnswer: sourcedSchema(cents),
  }),
  ct: z.object({
    /** CT-1040 line 15: out-of-state purchases subject to use tax. Must be answered (0 or an amount). */
    useTax: sourcedSchema(cents),
    /** CT Schedule 1 additions / subtractions (Phase 2). */
    additions: sourcedSchema(cents),
    subtractions: sourcedSchema(cents),
  }),
  priorYear: z.object({
    totalTaxCents: sourcedSchema(cents),
    agiCents: sourcedSchema(cents),
  }),
});

export type Ty2025Facts = z.infer<typeof ty2025FactsSchema>;
export type ScheduleCFacts = Ty2025Facts["income"]["scheduleC"];

/** Parse (validate) a facts object. Throws a ZodError on shape drift. */
export function parseTy2025Facts(input: unknown): Ty2025Facts {
  return ty2025FactsSchema.parse(input);
}
