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
import { BASES, missingLeaf, type Basis, type Sourced } from "@/lib/tax2025/types";

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

export const BROKER_FORMS = ["1099-B", "1099-DA"] as const;
export const BROKER_BOXES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"] as const;
export type BrokerForm = (typeof BROKER_FORMS)[number];
export type BrokerBox = (typeof BROKER_BOXES)[number];

/** One Form 8949 category total read from a 1099 document's sales summary (extraction field `bSummary`). null = not read (never 0). */
export const brokerSaleRowSchema = z.object({
  form: z.enum(BROKER_FORMS).nullable(),
  box: z.enum(BROKER_BOXES).nullable(),
  proceedsCents: centsOrNull,
  /** null when the category prints no basis (noncovered). */
  costCents: centsOrNull,
  accruedMarketDiscountCents: centsOrNull,
  washSaleLossDisallowedCents: centsOrNull,
  /** The broker-PRINTED net gain or (loss): cross-check only, never the computed figure. */
  gainLossCents: centsOrNull,
});
export type BrokerSaleRow = z.infer<typeof brokerSaleRowSchema>;

export const brokerSaleFactSchema = z.object({
  docId: z.string(),
  payer: z.string().nullable(),
  basis: docBasisSchema,
  legacyFormat: z.boolean(),
  refs: z.array(refSchema),
  /** `bSummary` is non-null in the EFFECTIVE extraction (corrections overlaid). false = old read / never read. */
  summaryRead: z.boolean(),
  /** The old read signals a 1099-B (variantsPresent has 1099-B, or an otherBoxes entry with variant 1099-B). */
  signalled1099B: z.boolean(),
  /** One row per (form, box) category printed in the summary. [] with summaryRead = read, no sales. */
  rows: z.array(brokerSaleRowSchema),
  /** Section 1256 aggregate profit or (loss) (1099-B box 11); null = no such section read. Never computed. */
  sec1256AggregateCents: centsOrNull,
  /** variantsPresent has 1099-DA or a row has form 1099-DA. */
  forms1099DaPresent: z.boolean(),
});
export type BrokerSaleFact = z.infer<typeof brokerSaleFactSchema>;

export const glLineFactSchema = z.object({
  /** The GL code row's id and code as stored. */
  glCodeId: z.string(),
  code: z.string(),
  name: z.string(),
  glType: z.enum(["revenue", "expense"]),
  /** Unsigned total for the year, integer cents (computePL's abs total). */
  totalCents: cents,
  /**
   * SIGNED net for the year, integer cents (negative = outflow), read by the loader because computePL reports abs().
   * Absent = not read. A revenue code that nets negative or an expense code that nets positive is flagged (sign flip).
   */
  signedCents: cents.optional(),
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
  /**
   * 2025 EK Consulting transactions with NO GL code (archivedAt null, transferPairId null, same window as the P&L). computePL
   * skips them, so they are invisible to Schedule C: more than 0 blocks lines 28 / 29 / 31. Absent = not supplied (treated as 0).
   */
  uncodedTransactionCount: z.number().int().optional(),
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

// ── Phase 1b: owner answers that feed the adjustment / credit rules ───────────
//
// Built from the "Return completeness" questionnaire (lib/tax2025/answers.ts).
// Every leaf follows the leaf convention: value null + basis null = NOT ANSWERED;
// value null + basis "answer_owner" = the owner chose "Not sure - ask the CPA"
// (the rules turn that into needs_cpa_judgment, never into a guess).

export const PERSON_SLOTS = ["a", "b"] as const;
export type PersonSlot = (typeof PERSON_SLOTS)[number];

export const personAnswersSchema = z.object({
  /** Questionnaire slot: a = first person asked about (Eric), b = second (Eva). */
  slot: z.enum(PERSON_SLOTS),
  /** The household user this slot was matched to by name; null = could not be matched (open item). */
  userId: z.string().nullable(),
  name: z.string(),
  bornBefore1961: sourcedSchema(z.boolean()),
  /** Blind at the end of 2025 (Form 1040 line 12d box; the age box is `bornBefore1961`). */
  blind: sourcedSchema(z.boolean()),
  age50Plus: sourcedSchema(z.boolean()),
  age55Plus: sourcedSchema(z.boolean()),
  /** A Social Security number valid for employment (needed for the Schedule 1-A deductions). */
  validSsn: sourcedSchema(z.boolean()),
  coveredByWorkplacePlan: sourcedSchema(z.boolean()),
  /** Elective deferrals to a 401(k), 403(b), 457(b), SIMPLE, SEP or TSP in 2025 (cents). */
  deferralsCents: sourcedSchema(cents),
  traditionalIraCents: sourcedSchema(cents),
  rothIraCents: sourcedSchema(cents),
  hsaCoverage: sourcedSchema(z.enum(["none", "self_only", "family", "changed"])),
  /** Months (0-12) the person was an eligible individual on the first day of the month with HDHP coverage. */
  hsaMonthsEligible: sourcedSchema(z.number().int()),
  hsaEligibleDec1: sourcedSchema(z.boolean()),
  /** True = some month in Medicare or someone else's dependent. */
  hsaMedicareOrDependent: sourcedSchema(z.boolean()),
  hsaDirectContributionsCents: sourcedSchema(cents),
  /** True = employer contributions include another year's money (Form 8889 Employer Contribution Worksheet). */
  hsaEmployerOtherYear: sourcedSchema(z.boolean()),
  hsaDistributions: sourcedSchema(z.enum(["none", "some"])),
  tipsChoice: sourcedSchema(z.enum(["none", "some", "ask_employer"])),
  tipsCents: sourcedSchema(cents),
  overtimeChoice: sourcedSchema(z.enum(["none", "premium", "total", "ask_employer"])),
  overtimeCents: sourcedSchema(cents),
});
export type PersonAnswers = z.infer<typeof personAnswersSchema>;

export const returnAnswersSchema = z.object({
  people: z.array(personAnswersSchema),
  /** Distribution from a retirement plan / IRA / ABLE account since 2022 (Form 8880 line 4). */
  retirementDistributionSince2022: sourcedSchema(z.boolean()),
  /** A full-time student for 5+ months, or claimed as someone else's dependent (Form 8880). */
  studentOrDependent: sourcedSchema(z.boolean()),
  /** No Puerto Rico excluded income and no Form 2555 / 4563 (Schedule 1-A lines 2a-2e are zero). */
  magiExclusionsNone: sourcedSchema(z.boolean()),
  carLoan: z.object({
    choice: sourcedSchema(z.enum(["none", "some"])),
    /** The vehicle and loan meet every listed condition. */
    qualifies: sourcedSchema(z.boolean()),
    interestPaidCents: sourcedSchema(cents),
    deductedElsewhereCents: sourcedSchema(cents),
  }),
  attestations: z.object({
    digitalAssets: sourcedSchema(z.boolean()),
    foreignAccounts: sourcedSchema(z.boolean()),
  }),
  priorYear: z.object({
    /** The 2024 federal return was a joint return. */
    filedJoint: sourcedSchema(z.boolean()),
    /** The 2024 return had a refundable credit or a Schedule 2 tax for unreported tips (lines 5-7, 13): they make the Form 2210 line 8 "2024 tax" differ from the extracted total tax. (Additional Medicare Tax and NIIT are INCLUDED in it.) */
    hadExcludedTaxOrRefundable: sourcedSchema(z.boolean()),
  }),
  useTax: z.object({
    choice: sourcedSchema(z.enum(["none", "some"])),
    generalRatePurchasesCents: sourcedSchema(cents),
    otherRateItems: sourcedSchema(z.boolean()),
    taxPaidToOtherStateCents: sourcedSchema(cents),
    /** Second purchase row: purchases on which NO tax was paid anywhere (each worksheet row is floored at 0 on its own). Optional for older callers. */
    untaxedPurchasesCents: sourcedSchema(cents).optional(),
  }),
  /** Capital-gains questions (Return completeness cgco / cgcos / cgcol / cgall / cgadj). */
  capitalGains: z.object({
    /** Short-term capital loss carried over from 2024 (Schedule D line 6 amount, a POSITIVE magnitude). cgco None -> 0 (basis answer_owner). */
    carryoverShortCents: sourcedSchema(cents),
    /** Long-term capital loss carried over from 2024 (Schedule D line 14 amount, positive). */
    carryoverLongCents: sourcedSchema(cents),
    /** cgall: true = the broker statement lists every 2025 sale the household made. false = No, null+owner = Not sure. */
    salesComplete: sourcedSchema(z.boolean()),
    /** cgadj: true = YES, there is something the broker could not know (wash sale elsewhere, inherited/gifted/related-party shares, wrong or blank cost). false = No: broker totals may be used as printed. */
    brokerAdjustments: sourcedSchema(z.boolean()),
  }),
  /** Optional "about how much" amounts the owner gave for a "none" group answered "some" (shown to the CPA; never computed). */
  statedSomeAmounts: z.record(z.enum(NONE_GROUP_IDS as [NoneGroupId, ...NoneGroupId[]]), sourcedSchema(cents)),
});
export type ReturnAnswers = z.infer<typeof returnAnswersSchema>;

/** Every answer missing. `people` carries one entry per slot with the given names. */
export function emptyReturnAnswers(people: readonly { slot: PersonSlot; userId: string | null; name: string }[] = []): ReturnAnswers {
  const m = <T>(): Sourced<T> => missingLeaf<T>();
  return {
    people: people.map((p) => ({
      slot: p.slot,
      userId: p.userId,
      name: p.name,
      bornBefore1961: m(),
      blind: m(),
      age50Plus: m(),
      age55Plus: m(),
      validSsn: m(),
      coveredByWorkplacePlan: m(),
      deferralsCents: m(),
      traditionalIraCents: m(),
      rothIraCents: m(),
      hsaCoverage: m(),
      hsaMonthsEligible: m(),
      hsaEligibleDec1: m(),
      hsaMedicareOrDependent: m(),
      hsaDirectContributionsCents: m(),
      hsaEmployerOtherYear: m(),
      hsaDistributions: m(),
      tipsChoice: m(),
      tipsCents: m(),
      overtimeChoice: m(),
      overtimeCents: m(),
    })),
    retirementDistributionSince2022: m(),
    studentOrDependent: m(),
    magiExclusionsNone: m(),
    carLoan: { choice: m(), qualifies: m(), interestPaidCents: m(), deductedElsewhereCents: m() },
    attestations: { digitalAssets: m(), foreignAccounts: m() },
    priorYear: { filedJoint: m(), hadExcludedTaxOrRefundable: m() },
    useTax: { choice: m(), generalRatePurchasesCents: m(), otherRateItems: m(), taxPaidToOtherStateCents: m(), untaxedPurchasesCents: m() },
    capitalGains: { carryoverShortCents: m(), carryoverLongCents: m(), salesComplete: m(), brokerAdjustments: m() },
    statedSomeAmounts: {},
  };
}

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
    /** The owner confirmed 1099-DIV boxes 2b, 2c and 2d are all zero (1040 line 7a Exception 1 needs it for the "Schedule D not required" box). Absent / false = not confirmed. */
    dividendBoxes2b2dConfirmedZero: z.boolean().optional(),
    otherIncomeBoxes: z.array(otherIncomeBoxSchema),
    /** Sales summaries (Form 1099-B / 1099-DA category totals) per 1099 document. Empty = no 1099 mentions sales. */
    brokerSales: z.array(brokerSaleFactSchema),
    scheduleC: scheduleCSchema,
  }),
  /** Above-the-line adjustments STATED by the owner/CPA (cents). Null = not stated: the line stays not-yet-computed / missing, never 0. */
  adjustments: z.object({
    /** Schedule 1-A total (1040 line 13b): an owner / CPA OVERRIDE. Left null, the Schedule 1-A rule computes it from `returnAnswers`. */
    sch1a: sourcedSchema(cents),
    hsa: sourcedSchema(cents),
    ira: sourcedSchema(cents),
    seRetirement: sourcedSchema(cents),
    seHealthInsurance: sourcedSchema(cents),
  }),
  /** Nonrefundable credits STATED by the owner/CPA (cents): an OVERRIDE. Left null, the foreign tax credit and saver's credit rules compute them. */
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
    /** Filing status printed on the 2024 return (extraction field filingStatus): "mfj", "single" ... */
    filingStatus: sourcedSchema(z.string()),
  }),
  /** Phase 1b: the owner's answers to the "Return completeness" questionnaire. */
  returnAnswers: returnAnswersSchema,
});

export type Ty2025Facts = z.infer<typeof ty2025FactsSchema>;
export type ScheduleCFacts = Ty2025Facts["income"]["scheduleC"];

/** Parse (validate) a facts object. Throws a ZodError on shape drift. */
export function parseTy2025Facts(input: unknown): Ty2025Facts {
  return ty2025FactsSchema.parse(input);
}
