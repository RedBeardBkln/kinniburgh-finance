// resolveFacts(): plain rows in, Ty2025Facts + conflicts + open items out. PURE
// (no DB, no clock). The DB-aware loader (lib/tax2025-build.ts) only fetches rows
// and parses planning answers into the typed `RawTy2025Inputs` below.
//
// Source precedence per fact (documented here, tested):
//   override > owner-verified document > owner answer (questionnaire / planning)
//   > unverified AI document read > books-derived > missing.
// Precedence only picks the value used; every candidate source is kept on the
// conflicts list so a disagreement is visible, never resolved silently.
//
// Blank vs unknown: on a CURRENT-format extraction a blank box is a real "nothing
// reported" and reads as 0; on a LEGACY-format extraction a box that was never read
// stays null (unknown). A W-2 box that the return needs (1, 2, 3, 4, 5, 6) is never
// defaulted: null stays null and the rule says missing_input.

import { sumCtWithholding } from "@/lib/tax-extraction-schema";
import { retirementStatementSummary } from "@/lib/retirement-statement";
import { readBrokerSummary } from "@/lib/tax-broker-summary";
import { RC_PERSONS } from "@/lib/tax-questionnaire-content";
import { matchPerson, uniquePersonMatch } from "@/lib/tax2025/answers";
import {
  emptyReturnAnswers,
  type BrokerSaleFact,
  type DividendFact,
  type DonationFact,
  type EstimatedPayment,
  type FixedAssetFact,
  type GlLineFact,
  type InterestFact,
  type MortgageFact,
  type OtherIncomeBox,
  type PropertyBillKind,
  type PropertyTaxBill,
  type RetirementStatementFact,
  type ReturnAnswers,
  type Ty2025Facts,
  type W2Fact,
} from "@/lib/tax2025/facts";
import { findGlMapEntry } from "@/lib/tax2025/gl-schedule-c-map";
import { NONE_GROUP_IDS, type NoneGroupId } from "@/lib/tax2025/line-catalog";
import {
  missingLeaf,
  sourced,
  type Basis,
  type FactConflict,
  type OpenItem,
  type Ref,
  type Sourced,
} from "@/lib/tax2025/types";

// ── Raw inputs ────────────────────────────────────────────────────────────────

/** One Document row, already mapped through resolveTaxDocForCompute (effective extraction data). */
export interface RawDocument {
  id: string;
  docType: string;
  taxYear: number | null;
  extractionStatus: string | null;
  /** EFFECTIVE extraction (owner corrections overlaid). */
  extractionData: unknown;
  verified: boolean;
  legacyFormat: boolean;
  reextractIncomplete?: boolean;
  /** "person" | "joint" | null */
  subjectType: string | null;
  subjectUserId: string | null;
  documentName?: string | null;
}

/** Planning answers, already parsed by the loader (no DB, no free text here). */
export interface RawPlanning {
  filingStatus: string | null;
  householdMembers: string | null;
  evVehicle: string | null;
  businessMileage: string | null;
  homeOfficeEligibility: string | null;
  homeOfficeSqft: number | null;
  solarCredit: string | null;
  donationsNone: boolean;
  fixedAssetsEkcNone: boolean;
  /** Legacy single "total retirement/HSA contributions" answer, cents. */
  retirementContributionCents: number | null;
  /** Legacy single "federal + state estimated payments" answer, cents. Cannot be split. */
  estimatedPaymentsCombinedCents: number | null;
}

/**
 * Typed answers supplied by the "Return completeness" questionnaire (lib/tax2025/answers.ts). All optional: absent =
 * not answered (a MISSING leaf, never 0). The 1a loader leaves these undefined.
 */
export interface RawAnswers {
  federalEstimates?: EstimatedPayment[];
  ctEstimates?: EstimatedPayment[];
  federalExtensionPaymentCents?: number;
  ctExtensionPaymentCents?: number;
  federalOverpaymentAppliedCents?: number;
  ctOverpaymentAppliedCents?: number;
  ctPriorYearBalancePaidIn2025Cents?: number;
  ctUseTaxCents?: number;
  ctAdditionsCents?: number;
  ctSubtractionsCents?: number;
  sch1aCents?: number;
  hsaCents?: number;
  iraCents?: number;
  seRetirementCents?: number;
  seHealthInsuranceCents?: number;
  foreignTaxCreditCents?: number;
  saversCreditCents?: number;
  noInterestConfirmed?: boolean;
  noDividendsConfirmed?: boolean;
  noPropertyTaxConfirmed?: boolean;
  /** Owner confirms 1099-DIV boxes 2b / 2c / 2d (unrecaptured section 1250, section 1202, collectibles gain) are all zero. */
  dividendBoxes2b2dConfirmedZero?: boolean;
  statedNone?: Partial<Record<NoneGroupId, boolean>>;
  /** Owner classification per property tax bill document id. */
  billClassifications?: Record<string, PropertyBillKind>;
  /** The "Return completeness" answers (lib/tax2025/answers.ts); absent = the questionnaire was not read. */
  returnAnswers?: ReturnAnswers;
}

export interface RawTy2025Inputs {
  taxYear: 2025;
  people: { userId: string; name: string }[];
  /** The household member who owns EK Consulting, with how that was determined. */
  scheduleCOwner: { userId: string; basis: Basis; note: string } | null;
  /** All Personal-entity documents, any year (this resolver filters by year and type). */
  documents: RawDocument[];
  planning: RawPlanning;
  answers?: RawAnswers;
  /** The saved "Return completeness" row was written against an older version of the questions. */
  returnCompletenessStale?: boolean;
  /** Address of the primary residence and how it was determined (a derived value must say so). */
  primaryResidence: { address: string; basis: Basis; note?: string } | null;
  paystubs: { federalWithheldCents: number; ctWithheldCents: number };
  ekc: {
    glLines: GlLineFact[];
    booksEmpty: boolean;
    glExcludedTransactionCount: number;
    /** 2025 EKC transactions with no GL code (invisible to the P&L); absent = not supplied. */
    uncodedTransactionCount?: number;
    mileage: { id?: string; miles: number; ratePerMile: string; dateIso: string }[];
    fixedAssets: FixedAssetFact[];
  };
  donations: DonationFact[];
}

export interface ResolvedFacts {
  facts: Ty2025Facts;
  conflicts: FactConflict[];
  openItems: OpenItem[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

function dataOf(doc: RawDocument): Rec {
  const d = (doc.extractionData as { data?: unknown } | null)?.data;
  return typeof d === "object" && d !== null && !Array.isArray(d) ? (d as Rec) : {};
}

/** Cents as "$1,234.56" for open-item prose (display only). */
function usd(cents: number): string {
  const [whole = "0", frac = "00"] = (cents / 100).toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function docBasis(doc: RawDocument): "doc_verified" | "doc_unverified" {
  return doc.verified ? "doc_verified" : "doc_unverified";
}

function docLabel(doc: RawDocument, what: string): string {
  return doc.documentName && doc.documentName.trim() !== "" ? doc.documentName : what;
}

function docRef(doc: RawDocument, what: string): Ref {
  return { kind: "document", id: doc.id, label: docLabel(doc, what) };
}

function planningRef(key: string, label: string): Ref {
  return { kind: "planning", id: key, label };
}

/** Blank box on a current-format document = 0; on a legacy document = unknown (null). */
function boxValue(doc: RawDocument, data: Rec, key: string): number | null {
  const v = intOrNull(data[key]);
  if (v !== null) return v;
  return doc.legacyFormat ? null : 0;
}

/** Normalizes an address for matching: lower case, no punctuation, common street suffixes abbreviated. */
export function normalizeAddress(a: string): string {
  return a
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\broad\b/g, "rd")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\blane\b/g, "ln")
    .replace(/\s+/g, " ")
    .trim();
}

/** Two addresses refer to the same property when the street number and street name agree. */
export function addressesMatch(a: string, b: string): boolean {
  const ta = normalizeAddress(a).split(" ");
  const tb = normalizeAddress(b).split(" ");
  if (ta.length < 2 || tb.length < 2) return normalizeAddress(a) === normalizeAddress(b);
  return ta[0] === tb[0] && ta[1] === tb[1];
}

/** W-2 box 12 codes that are employee deferrals or HSA contributions (used only for the conflict check). */
const BOX12_DEFERRAL_CODES = new Set(["D", "E", "F", "G", "H", "S", "AA", "BB", "EE", "W"]);

/** Signature of a document for exact-duplicate detection; null for types this resolver does not de-duplicate. */
function duplicateKey(doc: RawDocument): string | null {
  const data = dataOf(doc);
  const person = doc.subjectUserId ?? "";
  const str = (k: string) => strOrNull(data[k]) ?? "";
  const num = (k: string) => String(intOrNull(data[k]) ?? "");
  switch (doc.docType) {
    case "w2":
      return ["w2", person, str("employerEIN") || str("employerName").toLowerCase(), num("wagesCents"), num("federalWithheldCents"), num("socialSecurityWagesCents"), num("medicareWagesCents")].join("|");
    case "1099": {
      const amounts = Object.keys(data)
        .filter((k) => k.endsWith("Cents") && intOrNull(data[k]) !== null)
        .sort()
        .map((k) => `${k}=${String(data[k])}`)
        .join(",");
      if (amounts === "") return null;
      return ["1099", person, str("payerEIN") || str("payerName").toLowerCase(), str("formVariant"), amounts].join("|");
    }
    case "mortgage_interest":
    case "form_1098":
      if (num("interestCents") === "") return null;
      return ["1098", str("servicerName").toLowerCase(), num("interestCents"), num("principalBalanceCents"), normalizeAddress(str("propertyAddress"))].join("|");
    case "property_tax":
      if (num("totalTaxBilledCents") === "" && num("paidInTaxYearCents") === "") return null;
      return ["property_tax", str("jurisdictionName").toLowerCase(), normalizeAddress(str("propertyAddress")), str("parcelId"), str("taxType"), num("totalTaxBilledCents"), num("paidInTaxYearCents")].join("|");
    default:
      return null;
  }
}

// ── Resolver ──────────────────────────────────────────────────────────────────

export function resolveFacts(raw: RawTy2025Inputs): ResolvedFacts {
  const year = raw.taxYear;
  const conflicts: FactConflict[] = [];
  const openItems: OpenItem[] = [];
  const addItem = (item: Omit<OpenItem, "lineKeys" | "refs"> & Partial<Pick<OpenItem, "lineKeys" | "refs">>) => {
    openItems.push({ lineKeys: [], refs: [], ...item });
  };
  const answers = raw.answers ?? {};
  const answered = <T>(v: T | undefined, label: string, key: string): Sourced<T> =>
    v === undefined ? missingLeaf<T>() : sourced(v, "answer_owner", [{ kind: "questionnaire", id: key, label }]);

  const usableDocs = raw.documents.filter((d) => d.taxYear === year && (d.extractionStatus === "complete" || d.reextractIncomplete === true));

  // Exact duplicate documents (same type, year, person, issuer and the same key amounts) are counted ONCE and raise a
  // BLOCKING open item: silently counting both would double the income / withholding / deduction, and silently dropping one
  // would hide a possible second real document. The copy counted is the owner-verified one, else the first on file.
  const docsForYear: RawDocument[] = [];
  const firstByKey = new Map<string, RawDocument>();
  for (const d of usableDocs) {
    const key = duplicateKey(d);
    if (key === null) {
      docsForYear.push(d);
      continue;
    }
    const kept = firstByKey.get(key);
    if (kept === undefined) {
      firstByKey.set(key, d);
      docsForYear.push(d);
      continue;
    }
    // prefer the verified copy as the one counted
    const counted = !kept.verified && d.verified ? d : kept;
    const ignored = counted === kept ? d : kept;
    if (counted !== kept) {
      docsForYear.splice(docsForYear.indexOf(kept), 1, d);
      firstByKey.set(key, d);
    }
    addItem({
      id: `doc-duplicate:${d.docType}:${counted.id}:${ignored.id}`,
      severity: "blocking",
      message: `Two ${d.docType} documents are exact duplicates (same type, year, person, issuer and amounts). The engine counted ${counted.verified ? "the verified copy" : "the first copy"} (${counted.id}) once and ignored the other (${ignored.id}) so nothing is double counted, but it cannot tell whether the second is a genuine second form.`,
      action: "Archive the duplicate, or tell the CPA if both are real forms.",
      refs: [docRef(counted, d.docType), docRef(ignored, d.docType)],
    });
  }

  // ── Household ────────────────────────────────────────────────────────────────
  const p = raw.planning;
  const filingStatus: Sourced<string> =
    p.filingStatus === null
      ? missingLeaf("Filing status was not recorded; the engine assumes married filing jointly.")
      : sourced(p.filingStatus, "answer_owner", [planningRef("filing_status", "Filing status")]);
  if (p.filingStatus === null) {
    addItem({
      id: "filing-status-unanswered",
      severity: "advisory",
      message: "Filing status is not recorded on the Planning screen; the engine assumes married filing jointly (MFJ is the only status it computes).",
      action: "Record the filing status answer (MFJ).",
    });
  } else if (p.filingStatus !== "mfj") {
    addItem({
      id: "filing-status-not-mfj",
      severity: "blocking",
      message: `The Planning answer says "${p.filingStatus}"; this engine computes married filing jointly only, so no TY2025 amount is produced.`,
      action: "Confirm the filing status with the CPA.",
      refs: [planningRef("filing_status", "Filing status")],
    });
    conflicts.push({
      factKey: "household.filingStatus",
      candidates: [
        { basis: "answer_owner", label: "Planning answer", value: p.filingStatus, refs: [planningRef("filing_status", "Filing status")] },
        { basis: "derived", label: "Engine assumption", value: "mfj", refs: [] },
      ],
      chosen: null,
      reason: "The engine only computes MFJ; a different answer stops the computation instead of being ignored.",
    });
  }
  const noDependents: Sourced<boolean> =
    p.householdMembers === null
      ? missingLeaf()
      : sourced(p.householdMembers === "none", "answer_owner", [planningRef("household_members", "Dependents")]);
  const noEvPurchase: Sourced<boolean> =
    p.evVehicle === null ? missingLeaf() : sourced(p.evVehicle === "no", "answer_owner", [planningRef("ev_vehicle", "EV purchase")]);

  // ── W-2s ────────────────────────────────────────────────────────────────────
  const w2s: W2Fact[] = [];
  const w2Unusable: { docId: string; reason: string }[] = [];
  for (const doc of docsForYear.filter((d) => d.docType === "w2")) {
    const data = dataOf(doc);
    const wages = intOrNull(data.wagesCents);
    if (wages === null) {
      const reason = "extraction has no numeric wages (box 1): likely a mistagged or garbled document; excluded, never counted as $0";
      w2Unusable.push({ docId: doc.id, reason });
      addItem({
        id: `w2-unusable:${doc.id}`,
        severity: "blocking",
        message: `A W-2 document cannot be used: ${reason}.`,
        action: "Open the document, fix its type or re-extract it.",
        refs: [docRef(doc, "W-2")],
      });
      continue;
    }
    const stateLinesRaw = Array.isArray(data.stateLines) ? (data.stateLines as unknown[]) : [];
    const stateLines = stateLinesRaw.map((l) => {
      const rec: Rec = typeof l === "object" && l !== null ? (l as Rec) : {};
      return {
        stateCode: strOrNull(rec.stateCode),
        wagesCents: intOrNull(rec.stateWagesCents),
        withheldCents: intOrNull(rec.stateWithheldCents),
      };
    });
    let ctWithheld: number | null;
    if (stateLinesRaw.length > 0) ctWithheld = sumCtWithholding(stateLinesRaw) ?? 0;
    else if (intOrNull(data.stateWithheldCents) !== null) ctWithheld = intOrNull(data.stateWithheldCents); // legacy: assumed CT
    else ctWithheld = doc.legacyFormat ? null : 0;
    const box12 = (Array.isArray(data.box12) ? (data.box12 as unknown[]) : []).flatMap((e) => {
      const rec: Rec = typeof e === "object" && e !== null ? (e as Rec) : {};
      const code = strOrNull(rec.code);
      const amt = intOrNull(rec.amountCents);
      return code !== null && amt !== null ? [{ code: code.toUpperCase(), amountCents: amt }] : [];
    });
    const box14 = (Array.isArray(data.box14) ? (data.box14 as unknown[]) : []).flatMap((e) => {
      const rec: Rec = typeof e === "object" && e !== null ? (e as Rec) : {};
      const label = strOrNull(rec.label);
      const amt = intOrNull(rec.amountCents);
      return label !== null && amt !== null ? [{ label, amountCents: amt }] : [];
    });
    const personUserId = doc.subjectType === "person" ? doc.subjectUserId : null;
    const employer = strOrNull(data.employerName);
    const w2: W2Fact = {
      docId: doc.id,
      employer,
      employerEin: strOrNull(data.employerEIN),
      personUserId,
      subjectType: doc.subjectType,
      basis: docBasis(doc),
      legacyFormat: doc.legacyFormat,
      refs: [docRef(doc, `W-2 ${employer ?? ""}`.trim())],
      wagesCents: wages,
      fedWithheldCents: intOrNull(data.federalWithheldCents),
      socialSecurityWagesCents: intOrNull(data.socialSecurityWagesCents),
      socialSecurityWithheldCents: intOrNull(data.socialSecurityWithheldCents),
      medicareWagesCents: intOrNull(data.medicareWagesCents),
      medicareWithheldCents: intOrNull(data.medicareWithheldCents),
      socialSecurityTipsCents: intOrNull(data.socialSecurityTipsCents),
      dependentCareBenefitsCents: intOrNull(data.dependentCareBenefitsCents),
      box12,
      retirementPlan: typeof data.retirementPlan === "boolean" ? data.retirementPlan : null,
      box14,
      stateLines,
      ctWithheldCents: ctWithheld,
    };
    w2s.push(w2);
    if (personUserId === null) {
      addItem({
        id: `w2-no-person:${doc.id}`,
        severity: "blocking",
        message: `The W-2 from ${employer ?? "an employer"} is not assigned to a person (${doc.subjectType === "joint" ? "marked joint" : "unassigned"}); wages by person, Schedule SE and excess Social Security cannot be figured.`,
        action: "Set the person on the document (Documents screen).",
        refs: w2.refs,
      });
    }
    if (stateLines.some((l) => l.stateCode !== null && l.stateCode !== "CT")) {
      addItem({
        id: `w2-non-ct-state:${doc.id}`,
        severity: "advisory",
        message: `The W-2 from ${employer ?? "an employer"} shows state withholding for a state other than Connecticut; it is excluded from CT withholding and a credit for tax paid to another state is a CPA item.`,
        action: "Review the state lines on the document and tell the CPA.",
        refs: w2.refs,
      });
    }
  }

  // ── Retirement contribution statements (Form 5498 ...) ──────────────────────
  // They corroborate the owner's IRA answers (the conflict check below) and are cited on Form 8606 line 1. They never replace an answer.
  const retirementStatements: RetirementStatementFact[] = [];
  for (const doc of docsForYear.filter((d) => d.docType === "retirement_contribution")) {
    const s = retirementStatementSummary(doc.extractionData);
    if (!s.hasReading) continue;
    // A statement read for another year than the return year is not this year's figure (the document's own year can lag the form year).
    if (s.taxYear !== null && s.taxYear !== year) continue;
    const personUserId = doc.subjectType === "person" ? doc.subjectUserId : null;
    const issuer = s.issuerName;
    const fact: RetirementStatementFact = {
      docId: doc.id,
      personUserId,
      basis: docBasis(doc),
      legacyFormat: doc.legacyFormat,
      refs: [docRef(doc, `Retirement statement ${issuer ?? ""}`.trim())],
      issuer,
      traditionalIraCents: s.contributions.traditional_ira,
      rothIraCents: s.contributions.roth_ira,
      sepCents: s.contributions.sep_ira,
      simpleCents: s.contributions.simple_ira,
      postponedCents: s.postponed.amountCents,
      postponedForYear: s.postponed.forYear,
      rolloverCents: s.other.rolloverCents,
      rothConversionCents: s.other.rothConversionCents,
      recharacterizedCents: s.other.recharacterizedCents,
      fairMarketValueCents: s.other.fairMarketValueCents,
    };
    retirementStatements.push(fact);
    if (personUserId === null) {
      addItem({
        id: `retirement-doc-no-person:${doc.id}`,
        severity: "advisory",
        message: `The retirement statement${issuer === null ? "" : ` from ${issuer}`} is not assigned to a person, so it cannot be compared with the IRA answers for Eric or Eva or cited on a Form 8606.`,
        action: "Set the person on the document (Documents screen).",
        refs: fact.refs,
      });
    }
    const events: string[] = [];
    if ((fact.rothConversionCents ?? 0) > 0) events.push(`a Roth conversion (box 3: ${usd(fact.rothConversionCents ?? 0)})`);
    if ((fact.recharacterizedCents ?? 0) > 0) events.push(`a recharacterized contribution (box 4: ${usd(fact.recharacterizedCents ?? 0)})`);
    if ((fact.postponedCents ?? 0) > 0) events.push(`a postponed or late contribution (box 13a: ${usd(fact.postponedCents ?? 0)}${fact.postponedForYear === null ? "" : ` for ${fact.postponedForYear}`})`);
    if (events.length > 0) {
      addItem({
        id: `retirement-doc-ira-event:${doc.id}`,
        severity: "advisory",
        message: `The retirement statement${issuer === null ? "" : ` from ${issuer}`} shows ${events.join(" and ")}. That changes Form 8606 beyond lines 1-3 and 14: the Return completeness question about IRA withdrawals, Roth conversions, recharacterizations and returned contributions should be answered Yes, which stops those Form 8606 lines until you fill them in yourself.`,
        action: "Check the statement against your IRA records and answer the question about IRA withdrawals, Roth conversions and recharacterizations.",
        refs: fact.refs,
      });
    }
  }

  for (const person of raw.people) {
    const mine = w2s.filter((w) => w.personUserId === person.userId);
    if (mine.length > 1 && mine.some((w) => w.employerEin === null)) {
      addItem({
        id: `w2-no-ein:${person.userId}`,
        severity: "advisory",
        message: `${person.name} has ${mine.length} W-2s and at least one has no employer EIN read, so employers are told apart by name (needed for the excess Social Security credit, which requires more than one employer).`,
        action: "Enter the employer EIN on the W-2 review screen.",
        refs: mine.flatMap((w) => w.refs),
      });
    }
  }

  // ── 1099s ───────────────────────────────────────────────────────────────────
  const interest: InterestFact[] = [];
  const dividends: DividendFact[] = [];
  const otherIncomeBoxes: OtherIncomeBox[] = [];
  const brokerSales: BrokerSaleFact[] = [];
  let federal1099Withheld = 0;
  for (const doc of docsForYear.filter((d) => d.docType === "1099")) {
    const data = dataOf(doc);
    const formVariant = strOrNull(data.formVariant);
    const payer = strOrNull(data.payerName);
    const basis = docBasis(doc);
    const ref = docRef(doc, `1099 ${payer ?? ""}`.trim());

    const int1 = intOrNull(data.int_box1Cents);
    const legacyInterest = int1 === null && formVariant === "1099-INT" ? intOrNull(data.amountCents) : null;
    if (int1 !== null || legacyInterest !== null) {
      const box1 = int1 ?? legacyInterest;
      interest.push({
        docId: doc.id,
        payer,
        basis,
        legacyFormat: doc.legacyFormat,
        refs: [ref],
        box1Cents: box1,
        usedLegacyHeadline: int1 === null,
        box3Cents: boxValue(doc, data, "int_box3Cents"),
        box4Cents: intOrNull(data.int_box4Cents),
        box6Cents: boxValue(doc, data, "int_box6Cents"),
        box8Cents: boxValue(doc, data, "int_box8Cents"),
        box9Cents: boxValue(doc, data, "int_box9Cents"),
      });
      if (int1 !== null && formVariant === "1099-INT") {
        const headline = intOrNull(data.amountCents);
        if (headline !== null && headline !== int1) {
          conflicts.push({
            factKey: `income.interest.${doc.id}`,
            candidates: [
              { basis, label: "Interest box 1", value: int1, refs: [ref] },
              { basis, label: "Headline amount", value: headline, refs: [ref] },
            ],
            chosen: "Interest box 1",
            reason: "The 1099-INT headline amount differs from interest box 1; box 1 is used.",
          });
        }
      }
    }

    const hasDiv = ["div_box1aCents", "div_box1bCents", "div_box2aCents", "div_box3Cents", "div_box5Cents", "div_box7Cents", "div_box11Cents"].some(
      (k) => intOrNull(data[k]) !== null
    );
    const legacyDividend = !hasDiv && formVariant === "1099-DIV" ? intOrNull(data.amountCents) : null;
    if (hasDiv || legacyDividend !== null) {
      dividends.push({
        docId: doc.id,
        payer,
        basis,
        legacyFormat: doc.legacyFormat,
        refs: [ref],
        box1aCents: hasDiv ? boxValue(doc, data, "div_box1aCents") : legacyDividend,
        box1bCents: hasDiv ? boxValue(doc, data, "div_box1bCents") : null,
        box2aCents: hasDiv ? boxValue(doc, data, "div_box2aCents") : null,
        box3Cents: boxValue(doc, data, "div_box3Cents"),
        box4Cents: intOrNull(data.div_box4Cents),
        box5Cents: hasDiv ? boxValue(doc, data, "div_box5Cents") : null,
        box7Cents: boxValue(doc, data, "div_box7Cents"),
        box11Cents: boxValue(doc, data, "div_box11Cents"),
      });
    }

    // withholding on the 1099 (all forms): headline sum when present, else the per-box values
    const headlineWithheld = intOrNull(data.federalWithheldCents);
    if (!doc.legacyFormat || formVariant === "1099-INT") {
      if (headlineWithheld !== null) federal1099Withheld += headlineWithheld;
      else {
        for (const k of ["int_box4Cents", "div_box4Cents", "nec_box4Cents", "misc_box4Cents"]) federal1099Withheld += intOrNull(data[k]) ?? 0;
      }
    } else {
      // Legacy-format document that is not a 1099-INT: its withholding cannot be attributed reliably and is NOT counted.
      const legacyWithheld = headlineWithheld ?? 0;
      addItem({
        id: `legacy-1099-withholding:${doc.id}`,
        severity: legacyWithheld > 0 ? "blocking" : "advisory",
        message:
          legacyWithheld > 0
            ? `The legacy-format ${formVariant ?? "1099"} from ${payer ?? "a payer"} shows federal withholding of $${(legacyWithheld / 100).toFixed(2)}, which is NOT counted in 1040 line 25b (older extractions cannot be trusted for non-interest withholding).`
            : `The legacy-format ${formVariant ?? "1099"} from ${payer ?? "a payer"} was read before per-box withholding existed; any withholding on it is not counted.`,
        action: "Re-extract the document so the withholding boxes are read.",
        refs: [ref],
      });
    }

    // sales summary (Form 1099-B / 1099-DA category totals): kept per document, never summed here (the Schedule D rule does that)
    const sales = readBrokerSummary(data);
    if (sales.summaryRead || sales.signalled1099B || sales.forms1099DaPresent || sales.sec1256AggregateCents !== null) {
      brokerSales.push({
        docId: doc.id,
        payer,
        basis,
        legacyFormat: doc.legacyFormat,
        refs: [ref],
        summaryRead: sales.summaryRead,
        signalled1099B: sales.signalled1099B,
        rows: sales.rows,
        sec1256AggregateCents: sales.sec1256AggregateCents,
        forms1099DaPresent: sales.forms1099DaPresent,
      });
      if (!sales.summaryRead && sales.signalled1099B) {
        addItem({
          id: `broker-summary-unread:${doc.id}`,
          severity: "blocking",
          message: `The 1099 from ${payer ?? "a broker"} includes sales (Form 1099-B), but its sales summary (totals by Form 8949 category) has not been read, so capital gains and losses cannot be figured.`,
          action: "Open the document's review screen, use \"Re-read this document with the new fields\", check each sales summary row against the document and confirm it.",
          refs: [ref],
        });
      }
      if (sales.rows.some((r) => r.form === null || r.box === null)) {
        addItem({
          id: `broker-row-incomplete:${doc.id}`,
          severity: "blocking",
          message: `A sales summary row on the 1099 from ${payer ?? "a broker"} has no form or no Form 8949 box letter, so it cannot be placed on Schedule D or Form 8949.`,
          action: "Open the document's review screen and choose the form and the box for every sales summary row.",
          refs: [ref],
        });
      }
    }

    // income this engine does not compute: captured, never dropped
    for (const e of Array.isArray(data.otherBoxes) ? (data.otherBoxes as unknown[]) : []) {
      const rec: Rec = typeof e === "object" && e !== null ? (e as Rec) : {};
      const variant = strOrNull(rec.variant) ?? "other";
      // Once the sales summary has been read it supersedes the raw 1099-B boxes of an older read.
      if (sales.summaryRead && variant === "1099-B") continue;
      otherIncomeBoxes.push({
        docId: doc.id,
        payer,
        basis,
        variant,
        box: strOrNull(rec.box) ?? "",
        label: strOrNull(rec.label) ?? "",
        amountCents: intOrNull(rec.amountCents),
      });
    }
    for (const [k, variant, box] of [
      ["nec_box1Cents", "1099-NEC", "1"],
      ["misc_box1Cents", "1099-MISC", "1"],
      ["misc_box2Cents", "1099-MISC", "2"],
      ["misc_box3Cents", "1099-MISC", "3"],
    ] as const) {
      const v = intOrNull(data[k]);
      if (v !== null && v !== 0) {
        otherIncomeBoxes.push({ docId: doc.id, payer, basis, variant, box, label: `${variant} box ${box}`, amountCents: v });
      }
    }
  }
  if (otherIncomeBoxes.length > 0) {
    addItem({
      id: "other-income-boxes",
      severity: "blocking",
      message: `${otherIncomeBoxes.length} 1099 box(es) outside interest and dividends were read (${[...new Set(otherIncomeBoxes.map((b) => b.variant))].join(", ")}); this engine does not compute them, so the lines they belong to are not computed.`,
      action: "Review the boxes with the CPA (Schedule D / 8949, 1099-R, 1099-NEC income).",
      refs: [...new Set(otherIncomeBoxes.map((b) => b.docId))].map((id): Ref => ({ kind: "document", id, label: "1099" })),
    });
  }
  // S4: the Qualified Dividends and Capital Gain Tax Worksheet is valid only with no unrecaptured section 1250 gain, section 1202
  // gain or 28% (collectibles) gain (those need the Schedule D Tax Worksheet). The extraction does not read 1099-DIV boxes 2b-2d.
  if (dividends.length > 0 && answers.dividendBoxes2b2dConfirmedZero !== true) {
    addItem({
      id: "dividend-boxes-2b-2d",
      severity: "blocking",
      message:
        "1099-DIV boxes 2b, 2c and 2d (unrecaptured section 1250 gain, section 1202 gain, collectibles gain) are not read by the extraction. The tax computation uses the Qualified Dividends and Capital Gain Tax Worksheet, which is only valid when all three are zero.",
      action:
        answers.dividendBoxes2b2dConfirmedZero === false
          ? "The owner reports that at least one of boxes 2b, 2c, 2d is not zero: give the 1099-DIV to the CPA, who uses the Schedule D Tax Worksheet."
          : "Check the 1099-DIV and confirm boxes 2b, 2c and 2d are zero in the Return completeness questionnaire (or tell the CPA so the Schedule D Tax Worksheet is used).",
      lineKeys: ["f1040.16", "qdcg.25"],
      refs: dividends.flatMap((d) => d.refs),
    });
  }
  const box3Total = interest.reduce((s, i) => s + (i.box3Cents ?? 0), 0);
  if (box3Total > 0) {
    addItem({
      id: "interest-box3",
      severity: "advisory",
      message: `1099-INT box 3 (US savings bond / Treasury interest) of $${(box3Total / 100).toFixed(2)} is included in federal taxable interest (1040 line 2b); Connecticut exempts it, and CT-1040 Schedule 1 line 39 subtracts it (see that line for the amount or the CPA decision).`,
      action: "Tell the CPA so the CT subtraction is taken.",
    });
  }
  const foreignTax = interest.reduce((s, i) => s + (i.box6Cents ?? 0), 0) + dividends.reduce((s, d) => s + (d.box7Cents ?? 0), 0);
  if (foreignTax > 0) {
    addItem({
      id: "foreign-tax-paid",
      severity: "advisory",
      message: `Foreign tax paid of $${(foreignTax / 100).toFixed(2)} is reported (1099-INT box 6 / 1099-DIV box 7). The direct credit on Schedule 3 line 1 is computed by the foreign tax credit rule (a stated credit overrides it).`,
      action: "The foreign tax credit rule computes the direct credit if the total is $600 (MFJ) or less; above that it is a CPA matter (Form 1116).",
    });
  }

  // ── 1098s ───────────────────────────────────────────────────────────────────
  const mortgages: MortgageFact[] = [];
  for (const doc of docsForYear.filter((d) => d.docType === "mortgage_interest" || d.docType === "form_1098")) {
    const data = dataOf(doc);
    const lender = strOrNull(data.servicerName);
    if (intOrNull(data.interestCents) === null) {
      // Never dropped: the fact is kept with a null interest (Schedule A line 8a then reports missing_input) and a blocking item says why.
      addItem({
        id: `form1098-no-interest:${doc.id}`,
        severity: "blocking",
        message: `The Form 1098 from ${lender ?? "a lender"} has no mortgage interest (box 1) read, so Schedule A mortgage interest cannot be totaled.`,
        action: "Open the document, enter box 1 or re-extract it.",
        refs: [docRef(doc, "1098")],
      });
    }
    mortgages.push({
      docId: doc.id,
      lender,
      basis: docBasis(doc),
      legacyFormat: doc.legacyFormat,
      refs: [docRef(doc, `1098 ${lender ?? ""}`.trim())],
      interestCents: intOrNull(data.interestCents),
      principalCents: intOrNull(data.principalBalanceCents),
      originationDate: strOrNull(data.originationDate),
      mortgageInsuranceCents: intOrNull(data.mortgageInsurancePremiumsCents),
      pointsCents: intOrNull(data.pointsPaidCents),
      box10Cents: intOrNull(data.box10Cents),
      propertyAddress: strOrNull(data.propertyAddress),
    });
  }

  // ── Primary residence and property tax bills ───────────────────────────────
  const primaryAddress = raw.primaryResidence;
  const deductionsPrimary: Sourced<string> = primaryAddress
    ? sourced(primaryAddress.address, primaryAddress.basis, [], primaryAddress.note)
    : missingLeaf("The primary residence address is not recorded: real estate bills cannot be classified.");
  if (primaryAddress && primaryAddress.basis === "derived") {
    addItem({
      id: "primary-residence-derived",
      severity: "advisory",
      message: `The primary residence is taken to be ${primaryAddress.address} (${primaryAddress.note ?? "derived"}); the property tax credit and Schedule A classification depend on it.`,
      action: "Confirm the primary residence address.",
    });
  }
  {
    const distinct: string[] = [];
    for (const m of mortgages) if (m.propertyAddress && !distinct.some((d) => addressesMatch(d, m.propertyAddress!))) distinct.push(m.propertyAddress);
    const other = primaryAddress ? mortgages.filter((m) => m.propertyAddress && !addressesMatch(m.propertyAddress, primaryAddress.address)) : [];
    if ((!primaryAddress && distinct.length > 1) || other.length > 0) {
      addItem({
        id: "form1098-multiple-properties",
        severity: "blocking",
        message: `Form 1098 interest is reported for ${distinct.length} different properties (${distinct.join("; ")}) and the primary residence ${primaryAddress ? `is ${primaryAddress.address}` : "cannot be told apart"}: the interest on a property that is not the primary residence is not silently treated as primary-residence Schedule A interest.`,
        action: "Confirm which property is the primary residence and how each other 1098 property is used (second home, rental).",
        refs: mortgages.flatMap((m) => m.refs),
      });
    }
  }
  const propertyTaxBills: PropertyTaxBill[] = [];
  for (const doc of docsForYear.filter((d) => d.docType === "property_tax")) {
    const data = dataOf(doc);
    const taxType = strOrNull(data.taxType);
    const address = strOrNull(data.propertyAddress);
    const label = strOrNull(data.jurisdictionName) ?? docLabel(doc, "property tax bill");
    const ownerKind = answers.billClassifications?.[doc.id];
    let kind: PropertyBillKind = "unclassified";
    let kindBasis: Basis | null = null;
    let kindNote: string | undefined;
    if (ownerKind !== undefined) {
      kind = ownerKind;
      kindBasis = "answer_owner";
    } else if (taxType === "motor_vehicle") {
      kind = "motor_vehicle";
      kindBasis = docBasis(doc);
    } else if (taxType === "personal_property") {
      kind = "other_personal_property";
      kindBasis = docBasis(doc);
    } else if (taxType === "real_estate" || (taxType === null && address !== null)) {
      if (primaryAddress && address) {
        if (addressesMatch(address, primaryAddress.address)) {
          kind = "primary_residence";
          kindNote = `Address matches the primary residence (${primaryAddress.basis}).`;
        } else {
          kind = "other_real_estate";
          kindNote = "Address differs from the primary residence.";
        }
        kindBasis = "derived";
      }
    }
    propertyTaxBills.push({
      docId: doc.id,
      label,
      basis: docBasis(doc),
      legacyFormat: doc.legacyFormat,
      refs: [docRef(doc, `Property tax ${label}`)],
      taxType,
      address,
      billedCents: intOrNull(data.totalTaxBilledCents),
      paidInYearCents: intOrNull(data.paidInTaxYearCents),
      kind,
      kindBasis,
      ...(kindNote ? { kindNote } : {}),
    });
  }
  for (const b of propertyTaxBills) {
    if (b.paidInYearCents === null) {
      addItem({
        id: `bill-no-paid:${b.docId}`,
        severity: "blocking",
        message: `The property tax bill "${b.label}"${b.address ? ` (${b.address})` : ""} has no "paid in the tax year" amount entered, so it cannot count toward Schedule A or the CT credit.`,
        action: "Enter the amount paid in 2025 on the bill's review screen.",
        refs: b.refs,
      });
    }
    if (b.kind === "unclassified") {
      addItem({
        id: `bill-unclassified:${b.docId}`,
        severity: "blocking",
        message: `The property tax bill "${b.label}" cannot be classified (primary residence / other real estate / vehicle)${primaryAddress ? "" : " because the primary residence address is not recorded"}.`,
        action: "Record the primary residence address or classify the bill.",
        refs: b.refs,
      });
    }
  }
  if (!propertyTaxBills.some((b) => b.kind === "other_real_estate")) {
    addItem({
      id: "no-second-property-bill",
      severity: "advisory",
      message:
        "No 2025 property tax bill is on file for a property other than the primary residence. If tax was paid on another property in 2025 (for example 56 Arbor Rd, a personal Schedule A item in 2025 that is excluded from the CT credit), upload the bill and enter the amount paid.",
      action: "Upload the bill (or confirm none) and enter the paid amount.",
    });
  }
  for (const m of mortgages) {
    if (m.box10Cents !== null && m.box10Cents > 0 && m.propertyAddress) {
      const bill = propertyTaxBills.find((b) => b.address && addressesMatch(b.address, m.propertyAddress!));
      if (bill && bill.paidInYearCents !== null && bill.paidInYearCents !== m.box10Cents) {
        conflicts.push({
          factKey: `deductions.propertyTax.${bill.docId}`,
          candidates: [
            { basis: bill.basis, label: "Bill: paid in 2025 (owner entered)", value: bill.paidInYearCents, refs: bill.refs },
            { basis: m.basis, label: "1098 box 10 (other / escrowed tax)", value: m.box10Cents, refs: m.refs },
          ],
          chosen: "Bill: paid in 2025 (owner entered)",
          reason: "The 1098 box 10 amount differs from the property tax paid entered on the bill; the bill amount is used and box 10 is never added on top of it.",
        });
      }
    }
  }

  // ── Retirement conflict (owner answer vs W-2 box 12) ───────────────────────
  const box12Total = w2s.reduce((s, w) => s + w.box12.filter((e) => BOX12_DEFERRAL_CODES.has(e.code)).reduce((a, e) => a + e.amountCents, 0), 0);
  if (p.retirementContributionCents !== null && box12Total > 0 && p.retirementContributionCents < box12Total) {
    conflicts.push({
      factKey: "adjustments.retirementContributions",
      candidates: [
        { basis: "answer_owner", label: "Owner answer (total retirement + HSA contributions)", value: p.retirementContributionCents, refs: [planningRef("retirement_contribution_amount", "Retirement contributions")] },
        { basis: w2s.every((w) => w.basis === "doc_verified") ? "doc_verified" : "doc_unverified", label: "W-2 box 12 (deferrals and HSA, codes D E F G H S AA BB W)", value: box12Total, refs: w2s.flatMap((w) => w.refs) },
      ],
      chosen: null,
      reason:
        "The owner's total is lower than the contributions printed on the W-2s. The IRA, HSA and saver's credit rules use the per-person Return completeness answers; both figures are kept here for the cross-check.",
    });
  }

  // ── Mileage vs the "no business mileage" answer ────────────────────────────
  if (p.businessMileage === "no" && raw.ekc.mileage.length > 0) {
    conflicts.push({
      factKey: "scheduleC.mileage",
      candidates: [
        { basis: "answer_owner", label: "Planning answer: no business mileage", value: "no", refs: [planningRef("business_mileage", "Business mileage")] },
        { basis: "books", label: "Mileage log entries", value: raw.ekc.mileage.length, refs: [] },
      ],
      chosen: null,
      reason: "The owner says there was no business mileage but the log has entries; Schedule C line 9 is a CPA call until one is corrected.",
    });
  }

  // ── Estimated payments: legacy combined answer cannot be split ─────────────
  const federalEstimates = answered(answers.federalEstimates, "Federal estimated payments", "federal_estimates");
  const ctEstimates = answered(answers.ctEstimates, "CT estimated payments", "ct_estimates");
  const combined: Sourced<number> =
    p.estimatedPaymentsCombinedCents === null
      ? missingLeaf()
      : sourced(p.estimatedPaymentsCombinedCents, "answer_owner", [planningRef("estimated_tax_payments_amount", "Estimated tax payments (federal + state)")]);
  if (p.estimatedPaymentsCombinedCents !== null && (federalEstimates.value === null || ctEstimates.value === null)) {
    addItem({
      id: "estimates-combined-unsplittable",
      severity: "blocking",
      message: `The only estimated-payment answer is one combined "federal + state" figure of $${(p.estimatedPaymentsCombinedCents / 100).toFixed(2)}; it cannot be split, so neither the federal (1040 line 26) nor the Connecticut (CT-1040 line 19) payments are used.`,
      action: "Enter the federal and the Connecticut estimated payments separately (dates and amounts).",
      refs: [planningRef("estimated_tax_payments_amount", "Estimated tax payments (federal + state)")],
    });
  }

  // ── Schedule C facts ───────────────────────────────────────────────────────
  const owner = raw.scheduleCOwner;
  if (owner === null) {
    addItem({
      id: "schedule-c-owner-unknown",
      severity: "blocking",
      message: "The household member who owns EK Consulting could not be determined, so Schedule SE (and the W-2 Social Security wage base it uses) cannot be attributed to a spouse.",
      action: "Record who owns EK Consulting.",
    });
  } else if (owner.basis === "derived") {
    addItem({
      id: "schedule-c-owner-derived",
      severity: "advisory",
      message: `EK Consulting's owner is taken to be the household member whose name matches the entity name (${owner.note}).`,
      action: "Confirm the Schedule C owner.",
    });
  }
  // B1: uncoded EKC transactions are invisible to the P&L (computePL skips them): never a silent total.
  const uncoded = raw.ekc.uncodedTransactionCount ?? 0;
  if (uncoded > 0) {
    addItem({
      id: "ekc-uncoded-transactions",
      severity: "blocking",
      message: `${uncoded} EK Consulting transaction(s) dated ${year} have no GL code, so Schedule C income and expenses (lines 28, 29, 31) cannot be totaled: the P&L only sees coded transactions.`,
      action: "GL-code every EK Consulting 2025 transaction at /business/ek-consulting/gl.",
      lineKeys: ["schc.28", "schc.29", "schc.31"],
    });
  }
  // S5: computePL reports abs(); a revenue code that nets negative or an expense code that nets positive would read as the opposite sign.
  for (const g of raw.ekc.glLines) {
    if (g.signedCents === undefined) continue;
    const flipped = g.glType === "revenue" ? g.signedCents < 0 : g.signedCents > 0;
    // "Returns and allowances" (Schedule C line 2) is an income-type account whose normal balance is an outflow
    const target = findGlMapEntry(g.name)?.target;
    if (!flipped || (target?.kind === "line" && target.line === "2")) continue;
    addItem({
      id: `gl-sign-flip:${g.code}`,
      severity: "blocking",
      message: `GL account "${g.name}" (${g.code}) is a ${g.glType} account but nets ${g.signedCents < 0 ? "negative (an outflow)" : "positive (an inflow)"} for ${year}; the P&L reports it as a positive ${g.glType}, which would misstate Schedule C.`,
      action: "Review the transactions coded to this account (a refund, a miscoded row or a reversed sign).",
      refs: [{ kind: "gl", id: g.code, label: g.name }],
    });
  }

  const mileageNone: Sourced<boolean> =
    p.businessMileage === null
      ? missingLeaf()
      : sourced(p.businessMileage === "no", "answer_owner", [planningRef("business_mileage", "Business mileage")]);
  const homeElig: Sourced<"yes_exclusive" | "yes_shared" | "no"> =
    p.homeOfficeEligibility === "yes_exclusive" || p.homeOfficeEligibility === "yes_shared" || p.homeOfficeEligibility === "no"
      ? sourced(p.homeOfficeEligibility, "answer_owner", [planningRef("home_office_ekc", "Home office")])
      : missingLeaf();
  const homeSqft: Sourced<number> =
    p.homeOfficeSqft === null ? missingLeaf() : sourced(p.homeOfficeSqft, "answer_owner", [planningRef("home_office_sqft", "Home office square footage")]);

  // ── Prior-year return (2024): read ONLY as documents ───────────────────────
  const priorReturns = raw.documents.filter(
    (d) => d.docType === "tax_return" && d.taxYear === year - 1 && d.extractionStatus === "complete" && strOrNull(dataOf(d).formType) === "1040"
  );
  let priorTotalTax: Sourced<number> = missingLeaf();
  let priorAgi: Sourced<number> = missingLeaf();
  let priorFilingStatus: Sourced<string> = missingLeaf();
  if (priorReturns.length === 1) {
    const doc = priorReturns[0]!;
    const data = dataOf(doc);
    const basis = docBasis(doc);
    const ref = docRef(doc, "2024 federal return");
    const tax = intOrNull(data.totalTaxCents);
    const agi = intOrNull(data.agiCents);
    if (tax !== null) priorTotalTax = sourced(tax, basis, [ref]);
    if (agi !== null) priorAgi = sourced(agi, basis, [ref]);
    const fs = strOrNull(data.filingStatus);
    if (fs !== null) priorFilingStatus = sourced(fs, basis, [ref]);
  } else {
    addItem({
      id: "prior-year-return",
      severity: "advisory",
      message:
        priorReturns.length === 0
          ? "No 2024 federal return (document type tax_return, formType 1040) with a finished extraction is on file: the Form 2210 safe harbor (2024 total tax and AGI) and any Form 5695 / QBI loss carryforward cannot be read."
          : "More than one 2024 federal return document is on file; which one is the filed return is unclear.",
      action: "Upload or review the 2024 federal return.",
    });
  }

  // ── Stated "none" statements ───────────────────────────────────────────────
  const statedNone: Ty2025Facts["statedNone"] = {};
  for (const g of NONE_GROUP_IDS) {
    const v = answers.statedNone?.[g];
    if (v !== undefined) statedNone[g] = sourced(v, "answer_owner", [{ kind: "questionnaire", id: `none:${g}`, label: `Stated: ${g}` }]);
  }
  if (p.solarCredit === "claimed_already") {
    statedNone.solar_credit = sourced(true, "answer_owner", [planningRef("solar_credit", "Solar credit already claimed")]);
  }

  // ── Return completeness answers (Phase 1b) and their cross-checks ──────────
  const returnAnswers: ReturnAnswers =
    answers.returnAnswers ??
    emptyReturnAnswers(
      RC_PERSONS.map((P) => ({
        slot: P.slot,
        userId: uniquePersonMatch(raw.people, P.key)?.userId ?? null,
        name: P.name,
      }))
    );
  if (answers.returnAnswers === undefined) {
    addItem({
      id: "return-completeness-not-started",
      // advisory: every line that needs an answer is already missing_input (and blocking) on its own
      severity: "advisory",
      message: "The Return completeness questionnaire has not been answered: retirement and HSA answers, tips, overtime, estimated payments and the \"none\" statements are all unknown.",
      action: "Answer the Return completeness questionnaire (Forms page, Form 1040 card).",
    });
  } else if (raw.returnCompletenessStale === true) {
    addItem({
      id: "return-completeness-stale",
      severity: "advisory",
      message: "The Return completeness answers were saved against an older version of the questions; open the questionnaire and confirm them.",
      action: "Re-open the Return completeness questionnaire and confirm every answer.",
    });
  }
  // Other income picked in several kinds: the amounts by kind must add up to the total given for the group (within a cent)
  {
    const oi = returnAnswers.otherIncome;
    const kinds = oi?.kinds.value ?? null;
    const total = returnAnswers.statedSomeAmounts.other_income?.value ?? null;
    if (oi !== undefined && kinds !== null && kinds.length > 1) {
      const split = oi.kindAmountsCents?.value ?? {};
      const missingKinds = kinds.filter((k) => split[k] === undefined);
      const sum = Object.values(split).reduce((a, b) => a + b, 0);
      const money = (c: number): string => `$${(c / 100).toFixed(2)}`;
      let problem: string | null = null;
      if (total === null) problem = `The other income is split into ${kinds.length} kinds (${money(sum)} entered) but the total has not been given.`;
      else if (missingKinds.length > 0) problem = `Allocated ${money(sum)} of ${money(total)}, ${money(total - sum)} left to allocate: no amount yet for ${missingKinds.join(", ")}.`;
      else if (Math.abs(total - sum) > 1) problem = `The amounts by kind add up to ${money(sum)} but the total is ${money(total)} (${sum > total ? `${money(sum - total)} over` : `${money(total - sum)} left to allocate`}).`;
      if (problem !== null) {
        addItem({
          id: "other-income-allocation",
          severity: "blocking",
          message: problem,
          action: "Open Return completeness, the other-income questions, and make the amounts by kind add up to the total.",
          refs: [...(oi.kindAmountsCents?.refs ?? [])],
        });
      }
    }
  }
  const DEFERRAL_CODES = new Set(["D", "E", "F", "G", "H", "S", "AA", "BB", "EE"]);
  for (const pa of returnAnswers.people) {
    if (pa.userId === null) {
      if (raw.people.length > 0) {
        addItem({
          id: `rc-person-unmatched:${pa.slot}`,
          severity: "blocking",
          message: `The Return completeness questions about ${pa.name} ${raw.people.filter((u) => matchPerson(u.name, RC_PERSONS.find((P) => P.slot === pa.slot)?.key ?? "")).length > 1 ? "match more than one household member" : "match no household member"} by first name, so ${pa.name}'s W-2 cross-checks and compensation for the IRA limit are not available (never guessed).`,
          action: "Make exactly one household member's first name match (Eric / Eva).",
        });
      }
      continue;
    }
    const mine = w2s.filter((w) => w.personUserId === pa.userId);
    if (mine.length === 0) continue;
    const refs = mine.flatMap((w) => w.refs);
    const docBasisOfMine: Basis = mine.every((w) => w.basis === "doc_verified") ? "doc_verified" : "doc_unverified";
    const owner = (label: string, value: string | number | null, leafRefs: Ref[]) => ({ basis: "answer_owner" as const, label, value, refs: leafRefs });
    // elective deferrals versus W-2 box 12
    const box12Deferrals = mine.reduce((sum, w) => sum + w.box12.filter((e) => DEFERRAL_CODES.has(e.code)).reduce((a, e) => a + e.amountCents, 0), 0);
    if (pa.deferralsCents.value !== null && pa.deferralsCents.value !== box12Deferrals) {
      conflicts.push({
        factKey: `returnAnswers.${pa.slot}.deferrals`,
        candidates: [
          owner(`${pa.name}: owner answer (elective deferrals)`, pa.deferralsCents.value, pa.deferralsCents.refs),
          { basis: docBasisOfMine, label: `${pa.name}: W-2 box 12 deferral codes (D E F G H S AA BB EE)`, value: box12Deferrals, refs },
        ],
        chosen: `${pa.name}: owner answer (elective deferrals)`,
        reason: "The owner's elective deferrals differ from the W-2 box 12 deferral codes; the saver's credit uses the owner answer. Confirm which is right (a 457(b) or after-tax amount may not be on the W-2).",
      });
    }
    // workplace plan versus W-2 box 13
    const box13Known = mine.filter((w) => w.retirementPlan !== null);
    if (box13Known.length > 0 && pa.coveredByWorkplacePlan.value !== null) {
      const box13 = box13Known.some((w) => w.retirementPlan === true);
      if (pa.coveredByWorkplacePlan.value !== box13) {
        conflicts.push({
          factKey: `returnAnswers.${pa.slot}.workplacePlan`,
          candidates: [
            owner(`${pa.name}: owner answer (covered by a plan at work)`, pa.coveredByWorkplacePlan.value ? "yes" : "no", pa.coveredByWorkplacePlan.refs),
            { basis: docBasisOfMine, label: `${pa.name}: W-2 box 13 Retirement plan checkbox`, value: box13 ? "checked" : "not checked", refs },
          ],
          chosen: `${pa.name}: owner answer (covered by a plan at work)`,
          reason: "The owner's answer about workplace plan coverage differs from W-2 box 13. The IRA deduction phase-out depends on it; the owner answer is used (a SEP, SIMPLE or qualified plan through self-employment is also coverage).",
        });
      }
    }
    // HSA employer contributions versus the coverage answer
    const codeW = mine.reduce((sum, w) => sum + w.box12.filter((e) => e.code === "W").reduce((a, e) => a + e.amountCents, 0), 0);
    if (pa.hsaCoverage.value === "none" && codeW > 0) {
      conflicts.push({
        factKey: `returnAnswers.${pa.slot}.hsa`,
        candidates: [
          owner(`${pa.name}: owner answer (no HDHP coverage)`, "none", pa.hsaCoverage.refs),
          { basis: docBasisOfMine, label: `${pa.name}: W-2 box 12 code W (employer HSA contributions)`, value: codeW, refs },
        ],
        chosen: null,
        reason: "The owner says there was no HSA-eligible coverage but the W-2 shows employer HSA contributions; the HSA deduction is left to the CPA until this is resolved.",
      });
    }
    // tips versus W-2 box 7
    const box7 = mine.reduce((sum, w) => sum + (w.socialSecurityTipsCents ?? 0), 0);
    if (box7 > 0 && pa.tipsChoice.value === "none") {
      conflicts.push({
        factKey: `returnAnswers.${pa.slot}.tips`,
        candidates: [
          owner(`${pa.name}: owner answer (no tips)`, "none", pa.tipsChoice.refs),
          { basis: docBasisOfMine, label: `${pa.name}: W-2 box 7 (social security tips)`, value: box7, refs },
        ],
        chosen: `${pa.name}: owner answer (no tips)`,
        reason: "The W-2 shows tips in box 7 but the owner reports no tips; Schedule 1-A takes the owner answer. Confirm (box 7 tips may not be qualified tips, but the owner should say so).",
      });
    } else if (box7 > 0 && pa.tipsChoice.value === "some" && pa.tipsCents.value !== null && pa.tipsCents.value !== box7) {
      conflicts.push({
        factKey: `returnAnswers.${pa.slot}.tips`,
        candidates: [
          owner(`${pa.name}: owner answer (qualified tips)`, pa.tipsCents.value, pa.tipsCents.refs),
          { basis: docBasisOfMine, label: `${pa.name}: W-2 box 7 (social security tips)`, value: box7, refs },
        ],
        chosen: `${pa.name}: owner answer (qualified tips)`,
        reason: "The owner's qualified tips differ from W-2 box 7 (tips reported to the employer, tips from other employers or non-qualified tips can explain it); Schedule 1-A takes the owner answer.",
      });
    }
    // overtime versus W-2 box 14
    const box14Overtime = mine.reduce((sum, w) => sum + w.box14.filter((e) => /overtime|flsa|\bot\b/i.test(e.label)).reduce((a, e) => a + e.amountCents, 0), 0);
    if (box14Overtime > 0 && pa.overtimeChoice.value === "none") {
      conflicts.push({
        factKey: `returnAnswers.${pa.slot}.overtime`,
        candidates: [
          owner(`${pa.name}: owner answer (no overtime)`, "none", pa.overtimeChoice.refs),
          { basis: docBasisOfMine, label: `${pa.name}: W-2 box 14 overtime`, value: box14Overtime, refs },
        ],
        chosen: `${pa.name}: owner answer (no overtime)`,
        reason: "The W-2 box 14 shows an overtime amount but the owner reports no overtime; Schedule 1-A takes the owner answer. The IRS says an amount the employer shows in box 14 can generally be relied on.",
      });
    }
  }

  // The owner's traditional IRA contribution versus the retirement statement's box 1 (which counts contributions made through April 15, 2026 for 2025).
  for (const pa of returnAnswers.people) {
    if (pa.userId === null || pa.traditionalIraCents.value === null) continue;
    const mine = retirementStatements.filter((r) => r.personUserId === pa.userId && r.traditionalIraCents !== null);
    if (mine.length === 0) continue;
    const box1 = mine.reduce((s, r) => s + (r.traditionalIraCents ?? 0), 0);
    if (box1 === pa.traditionalIraCents.value) continue;
    conflicts.push({
      factKey: `returnAnswers.${pa.slot}.traditionalIra`,
      candidates: [
        { basis: "answer_owner", label: `${pa.name}: owner answer (traditional IRA contribution for 2025)`, value: pa.traditionalIraCents.value, refs: pa.traditionalIraCents.refs },
        {
          basis: mine.every((r) => r.basis === "doc_verified") ? "doc_verified" : "doc_unverified",
          label: `${pa.name}: retirement statement (Form 5498 box 1, traditional IRA contributions)`,
          value: box1,
          refs: mine.flatMap((r) => r.refs),
        },
      ],
      chosen: `${pa.name}: owner answer (traditional IRA contribution for 2025)`,
      reason:
        "The owner's traditional IRA contribution differs from the retirement statement. Form 5498 box 1 includes contributions made through April 15, 2026 for 2025 and may miss one made at another custodian. The IRA deduction and Form 8606 line 1 use the owner answer; confirm which is right.",
    });
  }

  // 2024 return joint? The owner answer (Return completeness `pyjoint`) is the engine's input; the 2024 return document
  // is the cross-check. Nothing else compares the two, so a disagreement is surfaced here, never resolved silently.
  {
    const ownerJoint = returnAnswers.priorYear.filedJoint;
    const docStatus = priorFilingStatus.value;
    if (ownerJoint.value !== null && docStatus !== null) {
      const docJoint = docStatus === "mfj";
      if (ownerJoint.value !== docJoint) {
        conflicts.push({
          factKey: "returnAnswers.priorYear.joint",
          candidates: [
            { basis: "answer_owner", label: "Owner answer: the 2024 return was joint", value: ownerJoint.value ? "yes" : "no", refs: ownerJoint.refs },
            { basis: priorFilingStatus.basis ?? "doc_unverified", label: "2024 federal return: filing status", value: docStatus, refs: priorFilingStatus.refs },
          ],
          chosen: "Owner answer: the 2024 return was joint",
          reason:
            "The owner's answer about whether the 2024 return was joint differs from the filing status read from the 2024 return document; the Form 2210 safe harbor uses the owner answer. Confirm which is right.",
        });
      }
    }
  }

  // ── Document provenance advisories ─────────────────────────────────────────
  const contributing = [
    ...w2s.map((w) => ({ id: w.docId, label: `W-2 ${w.employer ?? ""}`.trim(), basis: w.basis, legacy: w.legacyFormat })),
    ...retirementStatements.map((r) => ({ id: r.docId, label: `Retirement statement ${r.issuer ?? ""}`.trim(), basis: r.basis, legacy: r.legacyFormat })),
    ...interest.map((i) => ({ id: i.docId, label: `1099 ${i.payer ?? ""}`.trim(), basis: i.basis, legacy: i.legacyFormat })),
    ...dividends.map((d) => ({ id: d.docId, label: `1099 ${d.payer ?? ""}`.trim(), basis: d.basis, legacy: d.legacyFormat })),
    ...mortgages.map((m) => ({ id: m.docId, label: `1098 ${m.lender ?? ""}`.trim(), basis: m.basis, legacy: m.legacyFormat })),
    ...propertyTaxBills.map((b) => ({ id: b.docId, label: `Property tax ${b.label}`, basis: b.basis, legacy: b.legacyFormat })),
  ];
  const seen = new Set<string>();
  for (const c of contributing) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (c.basis === "doc_unverified") {
      addItem({
        id: `doc-unverified:${c.id}`,
        severity: "advisory",
        message: `${c.label} is an unverified AI extraction feeding the return.`,
        action: "Open the document and mark it verified.",
        refs: [{ kind: "document", id: c.id, label: c.label }],
      });
    }
    if (c.legacy) {
      addItem({
        id: `doc-legacy:${c.id}`,
        severity: "advisory",
        message: `${c.label} was read in the older extraction format: newer boxes were never read.`,
        action: "Re-extract the document.",
        refs: [{ kind: "document", id: c.id, label: c.label }],
      });
    }
  }

  if (raw.paystubs.federalWithheldCents !== 0 || raw.paystubs.ctWithheldCents !== 0) {
    addItem({
      id: "paystub-withholding-not-added",
      severity: "advisory",
      message: `Paystub withholding for ${year} (federal $${(raw.paystubs.federalWithheldCents / 100).toFixed(2)}, CT $${(raw.paystubs.ctWithheldCents / 100).toFixed(2)}) is NOT added to the return: the W-2s are the year-end source and adding both would double count.`,
      action: "Reconcile the paystubs against the W-2s if a W-2 is missing.",
    });
  }

  // ── Assemble ────────────────────────────────────────────────────────────────
  const statedLeaf = (v: number | undefined, label: string, key: string): Sourced<number> => answered(v, label, key);
  const facts: Ty2025Facts = {
    taxYear: 2025,
    household: { filingStatus, people: raw.people, noDependents, noEvPurchase },
    income: {
      w2s,
      w2Unusable,
      retirementStatements,
      interest,
      noInterestConfirmed: answered(answers.noInterestConfirmed, "No interest income", "no_interest"),
      dividends,
      noDividendsConfirmed: answered(answers.noDividendsConfirmed, "No dividend income", "no_dividends"),
      dividendBoxes2b2dConfirmedZero: answers.dividendBoxes2b2dConfirmedZero === true,
      otherIncomeBoxes,
      brokerSales,
      scheduleC: {
        ownerUserId: owner ? sourced(owner.userId, owner.basis, [], owner.note) : missingLeaf(),
        glLines: raw.ekc.glLines,
        booksEmpty: raw.ekc.booksEmpty,
        glExcludedTransactionCount: raw.ekc.glExcludedTransactionCount,
        ...(raw.ekc.uncodedTransactionCount !== undefined ? { uncodedTransactionCount: raw.ekc.uncodedTransactionCount } : {}),
        mileage: raw.ekc.mileage,
        mileageNoneConfirmed: mileageNone,
        homeOfficeEligibility: homeElig,
        homeOfficeSqft: homeSqft,
        fixedAssets: raw.ekc.fixedAssets,
        fixedAssetsNoneConfirmed: p.fixedAssetsEkcNone,
      },
    },
    adjustments: {
      sch1a: statedLeaf(answers.sch1aCents, "Schedule 1-A deduction", "sch1a"),
      hsa: statedLeaf(answers.hsaCents, "HSA deduction", "hsa"),
      ira: statedLeaf(answers.iraCents, "IRA deduction", "ira"),
      seRetirement: statedLeaf(answers.seRetirementCents, "SE retirement contributions", "se_retirement"),
      seHealthInsurance: statedLeaf(answers.seHealthInsuranceCents, "SE health insurance", "se_health_insurance"),
    },
    credits: {
      foreignTax: statedLeaf(answers.foreignTaxCreditCents, "Foreign tax credit", "foreign_tax_credit"),
      savers: statedLeaf(answers.saversCreditCents, "Saver's credit", "savers_credit"),
    },
    statedNone,
    deductions: {
      mortgages,
      propertyTaxBills,
      noPropertyTaxConfirmed: answered(answers.noPropertyTaxConfirmed, "No property tax", "no_property_tax"),
      donations: raw.donations,
      noDonationsConfirmed: p.donationsNone ? sourced(true, "answer_owner", [planningRef("donations_none", "No charitable gifts")]) : missingLeaf(),
      primaryResidenceAddress: deductionsPrimary,
    },
    payments: {
      federal1099WithheldCents: federal1099Withheld,
      federalPaystubWithheldCents: raw.paystubs.federalWithheldCents,
      ctPaystubWithheldCents: raw.paystubs.ctWithheldCents,
      federalEstimates,
      federalExtensionPayment: statedLeaf(answers.federalExtensionPaymentCents, "Federal extension payment", "federal_extension_payment"),
      federalPriorYearOverpaymentApplied: statedLeaf(answers.federalOverpaymentAppliedCents, "Federal overpayment applied", "federal_overpayment_applied"),
      ctEstimates,
      ctExtensionPayment: statedLeaf(answers.ctExtensionPaymentCents, "CT extension payment", "ct_extension_payment"),
      ctPriorYearOverpaymentApplied: statedLeaf(answers.ctOverpaymentAppliedCents, "CT overpayment applied", "ct_overpayment_applied"),
      ctPriorYearBalancePaidIn2025: statedLeaf(answers.ctPriorYearBalancePaidIn2025Cents, "2024 CT balance paid in 2025", "ct_prior_balance_paid"),
      combinedEstimatesAnswer: combined,
    },
    ct: {
      useTax: statedLeaf(answers.ctUseTaxCents, "CT use tax", "ct_use_tax"),
      additions: statedLeaf(answers.ctAdditionsCents, "CT Schedule 1 additions", "ct_additions"),
      subtractions: statedLeaf(answers.ctSubtractionsCents, "CT Schedule 1 subtractions", "ct_subtractions"),
    },
    priorYear: { totalTaxCents: priorTotalTax, agiCents: priorAgi, filingStatus: priorFilingStatus },
    returnAnswers,
  };
  return { facts, conflicts, openItems };
}
