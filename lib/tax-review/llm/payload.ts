// The redacted payload the AI review passes see (ai-return-reviewer, B3; plan 5.5.3).
//
// WHAT IS SENT: the computed return as it will be filed (every line with its status and whole-dollar amount, the rule results with
// their reasons and cited constants, the decisions with their alternatives, open items and fact conflicts), the facts the passes need
// (income rows per document, deductions, payments, the owner's yes/no and amount answers), a document inventory (alias, type, year,
// verified, person label, which fact rows use it, why one is not used), and the printed text of the filled forms read back from the
// PDFs ([form, line, label, printed value]).
// WHAT IS NEVER SENT: SSNs (never stored), EINs (masked by redact.ts to the last four digits; employer ids are dropped here anyway),
// bank / loan / account numbers, dates of birth, raw PDFs or images, document names, free-text notes, real or first names of the
// household (they become "Taxpayer M" / "Taxpayer F"), street addresses and the household's OWN business entity names (generic labels, scrub.ts).
// WHAT IS SENT ON PURPOSE: payer / employer / bank / lender / brokerage names as read from the documents ("keep", the default; "generic" via
// TAX_REVIEW_PAYER_NAMES replaces them). lib/tax-review/ai-panel.ts SEND_NOTICE says so, and tax-review-send-notice.test.ts pins the two together.
//
// The ONLY way a payload becomes outgoing text is `serializePayload`: scrub entity names and addresses, then buildOutgoingJson
// (people labels, EIN mask, then refuse the whole payload if anything identifier-shaped is left).
//
// PURE: no DB, no network, no clock. Everything is JSON-safe.

import { CONSTANTS } from "@/lib/tax2025/constants";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { isLineKey, type Finding } from "@/lib/tax-review/types";
import { lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import type { PdfLine, PdfReturnView } from "@/lib/tax2025/pdf/types";
import type { FileBinding } from "@/lib/tax-review/l1/pdf-read";
import { isUsableFor2025, unusableReason } from "@/lib/tax-review/l1/source-docs";
import { roundCentsHalfUp } from "@/lib/tax-review/l1/helpers";
import { buildOutgoingJson, labelHouseholdMembers, type HouseholdPerson } from "@/lib/tax-review/redact";
import { buildScrubber, scrubDeep, type ScrubConfig } from "@/lib/tax-review/llm/scrub";
import { ownerWordingDeep } from "@/lib/tax-wording";
import type { Ty2025Return } from "@/lib/tax2025/types";

export const PAYLOAD_SCHEMA_VERSION = 1;

export interface PayloadLine {
  key: string;
  form: string;
  line: string;
  label: string;
  status: string;
  /** Whole dollars; null = no amount (missing / not computed). */
  amount: number | null;
  reason?: string;
  overridden?: true;
  undecidedDefault?: string;
  informational?: true;
}

export interface PayloadRule {
  ruleId: string;
  form: string;
  status: string;
  conclusion?: string;
  informational?: true;
  reasons: string[];
  citations: string[];
  inputsMissing: string[];
  alternatives?: { id: string; label: string; status: string; isDefault: boolean; inForce: boolean; effectAmount: number | null; effectNote: string | null }[];
  decision?: { id: string; chosen: string; status: string };
}

export interface PayloadDocument {
  /** Alias the model cites as "doc:<alias>" (the first 8 characters of the document id, or the whole id when those collide). */
  alias: string;
  type: string;
  year: number | null;
  verified: boolean;
  extractionStatus: string | null;
  /** "Taxpayer M" | "Taxpayer F" | "joint" | "unassigned". */
  person: string;
  /** Fact rows that use it ("w2", "interest", "dividends", "broker_sales", "other_income", "mortgage", "property_tax"). */
  usedBy: string[];
  /** Why the document is not used by the return, or null. */
  notUsedReason: string | null;
}

export interface PayloadForm {
  formId: string;
  file: string;
  /** Printed (non-blank) money / answer cells: [line, label, printed text]. */
  rows: { line: string; label: string; printed: string }[];
  checked: string[];
  blankMoneyFields: number;
}

export interface ReviewPayload {
  schemaVersion: typeof PAYLOAD_SCHEMA_VERSION;
  meta: { taxYear: 2025; engineVersion: string; filingStatus: string; persons: string[]; entities: string[] };
  headline: Record<string, { status: string; amount: number | null }>;
  headlineNotes: { complete: boolean; blockingItemCount: number; unverifiedDocumentCount: number; derivedInputCount: number; undecidedDecisionCount: number; caveats: string[] };
  lines: PayloadLine[];
  rules: PayloadRule[];
  decisions: { id: string; label: string; chosen: string; status: string }[];
  openItems: { id: string; severity: string; message: string; action: string; lineKeys: string[] }[];
  conflicts: { factKey: string; chosen: string | null; reason: string }[];
  documents: PayloadDocument[];
  income: {
    w2: Record<string, unknown>[];
    interest: Record<string, unknown>[];
    dividends: Record<string, unknown>[];
    brokerSales: Record<string, unknown>[];
    otherIncomeBoxes: Record<string, unknown>[];
    scheduleC: Record<string, unknown> | null;
    scheduleD: Record<string, unknown> | null;
    statedNone: string[];
    noInterestConfirmed: boolean | null;
    noDividendsConfirmed: boolean | null;
  };
  deductions: { mortgages: Record<string, unknown>[]; propertyTaxBills: Record<string, unknown>[]; donations: Record<string, unknown>[]; noDonationsConfirmed: boolean | null; noPropertyTaxConfirmed: boolean | null };
  payments: Record<string, unknown>;
  answers: Record<string, unknown>;
  priorYear: { totalTaxDollars: number | null; agiDollars: number | null; filingStatus: string | null };
  constants: { id: string; value: string; note: string }[];
  forms: PayloadForm[];
  l1: { findings: { key: string; check: string; severity: string; message: string }[] };
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** The engine's status ids carry an identifier that must not reach the model or an owner-visible finding. */
export function plainRuleStatus(status: string): string {
  switch (status) {
    case "needs_cpa_judgment":
      return "needs_owner_decision";
    case "needs_cpa_rule_unverified":
      return "rule_unverified";
    default:
      return status;
  }
}

/** Engine status identifiers inside prose (constant notes, reasons) read as plain words too. */
export function plainIdentifiers(text: string): string {
  return text.replace(/needs_cpa_rule_unverified/g, "rule_unverified").replace(/needs_cpa_judgment/g, "needs_owner_decision").replace(/needs_cpa_/g, "needs_owner_");
}

const dollars = (cents: number | null | undefined): number | null => (cents === null || cents === undefined ? null : roundCentsHalfUp(cents));
const clip = (s: string | null | undefined, n: number): string => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

interface PersonLabels {
  byUserId: ReadonlyMap<string, string>;
  of(userId: string | null | undefined): string;
}

function personLabels(people: readonly HouseholdPerson[]): PersonLabels {
  const l = labelHouseholdMembers(people);
  return { byUserId: l.byUserId, of: (id) => (id === null || id === undefined ? "unassigned" : l.byUserId.get(id) ?? "unassigned") };
}

function sourcedValue<T>(s: { value: T | null } | undefined): T | null {
  return s === undefined ? null : s.value;
}

/** A Sourced leaf as {value, basis}: basis "answer_owner" with a null value = the owner chose "not sure". */
function leaf<T>(s: { value: T | null; basis: string | null } | undefined): { value: T | null; basis: string | null } | null {
  return s === undefined ? null : { value: s.value, basis: s.basis };
}

// ── sections ──────────────────────────────────────────────────────────────────

function linesOf(view: PdfReturnView): PayloadLine[] {
  const out: PayloadLine[] = [];
  for (const l of Object.values(view.lines) as (PdfLine | undefined)[]) {
    if (l === undefined || !isLineKey(l.key)) continue;
    const row: PayloadLine = { key: l.key, form: l.formLabel, line: l.formLine, label: l.label, status: plainRuleStatus(l.status), amount: l.amount };
    if (l.reason !== null && l.reason !== "") row.reason = clip(l.reason, 240);
    if (l.override !== undefined) row.overridden = true;
    if (l.defaultUndecided !== undefined) row.undecidedDefault = clip(l.defaultUndecided, 80);
    if (l.informational === true) row.informational = true;
    out.push(row);
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function rulesOf(ret: Ty2025Return): PayloadRule[] {
  return ret.results.map((r): PayloadRule => {
    const row: PayloadRule = {
      ruleId: r.ruleId,
      form: r.form,
      status: plainRuleStatus(r.status),
      reasons: r.reasons.slice(0, 4).map((x) => clip(x, 320)),
      citations: [...r.citations],
      inputsMissing: r.inputsMissing.slice(0, 8).map((x) => clip(x, 120)),
    };
    if (r.conclusion !== undefined) row.conclusion = r.conclusion;
    if (r.informational === true) row.informational = true;
    if (r.alternatives !== undefined) {
      row.alternatives = r.alternatives.map((a) => ({
        id: a.id,
        label: clip(a.label, 120),
        status: plainRuleStatus(a.status),
        isDefault: a.isDefault,
        inForce: a.inForce,
        effectAmount: a.effect?.amount === null || a.effect?.amount === undefined ? null : Number(a.effect.amount.toString()),
        effectNote: a.effect === null ? null : clip(a.effect.note, 200),
      }));
    }
    if (r.decision !== undefined) row.decision = { id: r.decision.id, chosen: r.decision.chosen, status: r.decision.status };
    return row;
  });
}

function constantsOf(ret: Ty2025Return): { id: string; value: string; note: string }[] {
  const ids = new Set<string>(ret.citations);
  for (const r of ret.results) for (const c of r.citations) ids.add(c);
  const out: { id: string; value: string; note: string }[] = [];
  for (const id of [...ids].sort()) {
    const c = (CONSTANTS as Record<string, { value: unknown; note: string } | undefined>)[id];
    if (c === undefined) continue;
    out.push({ id, value: clip(JSON.stringify(c.value), 300), note: clip(c.note, 500) });
  }
  return out;
}

type AliasOf = (id: string) => string;

/** The first 8 characters of a document id, or the whole id when two documents share them (so an alias is always unambiguous). */
function makeAliasOf(ids: readonly string[]): AliasOf {
  const count = new Map<string, Set<string>>();
  for (const id of ids) {
    const set = count.get(id.slice(0, 8)) ?? new Set<string>();
    set.add(id);
    count.set(id.slice(0, 8), set);
  }
  return (id) => ((count.get(id.slice(0, 8))?.size ?? 0) > 1 ? id : id.slice(0, 8));
}

function documentsOf(facts: Ty2025Facts, docs: readonly PayloadDocumentInput[], labels: PersonLabels, aliasOf: AliasOf): PayloadDocument[] {
  const used = new Map<string, Set<string>>();
  const mark = (docId: string, kind: string): void => {
    const set = used.get(docId) ?? new Set<string>();
    set.add(kind);
    used.set(docId, set);
  };
  for (const w of facts.income.w2s) mark(w.docId, "w2");
  for (const x of facts.income.w2Unusable) mark(x.docId, "w2_unusable");
  for (const x of facts.income.interest) mark(x.docId, "interest");
  for (const x of facts.income.dividends) mark(x.docId, "dividends");
  for (const x of facts.income.brokerSales) mark(x.docId, "broker_sales");
  for (const x of facts.income.otherIncomeBoxes) mark(x.docId, "other_income");
  for (const x of facts.deductions.mortgages) mark(x.docId, "mortgage");
  for (const x of facts.deductions.propertyTaxBills) mark(x.docId, "property_tax");
  return docs.map((d): PayloadDocument => {
    const subject = d.subjectType === "joint" ? "joint" : labels.of(d.subjectUserId);
    const asRaw = { id: d.id, docType: d.docType, taxYear: d.taxYear, extractionStatus: d.extractionStatus, reextractIncomplete: d.reextractIncomplete ?? false };
    const why = unusableReason(asRaw as Parameters<typeof unusableReason>[0]);
    const usable = isUsableFor2025(asRaw as Parameters<typeof isUsableFor2025>[0]);
    return {
      alias: aliasOf(d.id),
      type: d.docType,
      year: d.taxYear,
      verified: d.verified,
      extractionStatus: d.extractionStatus,
      person: subject,
      usedBy: [...(used.get(d.id) ?? [])].sort(),
      notUsedReason: why ?? (d.taxYear === 2025 && !usable ? "its extraction did not complete" : null),
    };
  });
}

/** "keep": the payer / employer name as read from the document (default; a brokerage or bank name helps the model recognise the form). "generic": "Employer A", "Payer B" ... (stable per name). */
export type PayerNameMode = "keep" | "generic";

interface PayerNames {
  employer(name: string | null): string;
  payer(name: string | null): string;
}

function makePayerNames(mode: PayerNameMode): PayerNames {
  const seen = new Map<string, string>();
  const label = (kind: string, name: string | null): string => {
    const key = `${kind}|${(name ?? "").trim().toLowerCase()}`;
    const have = seen.get(key);
    if (have !== undefined) return have;
    const n = [...seen.keys()].filter((k) => k.startsWith(`${kind}|`)).length;
    const out = `${kind} ${String.fromCharCode(65 + (n % 26))}${n >= 26 ? String(Math.floor(n / 26)) : ""}`;
    seen.set(key, out);
    return out;
  };
  return mode === "generic"
    ? { employer: (n) => (n === null || n.trim() === "" ? "" : label("Employer", n)), payer: (n) => (n === null || n.trim() === "" ? "" : label("Payer", n)) }
    : { employer: (n) => clip(n, 80), payer: (n) => clip(n, 80) };
}

function incomeOf(facts: Ty2025Facts, ret: Ty2025Return, labels: PersonLabels, aliasOf: AliasOf, names: PayerNames): ReviewPayload["income"] {
  const w2 = facts.income.w2s.map((w) => ({
    doc: aliasOf(w.docId),
    person: labels.of(w.personUserId),
    employer: names.employer(w.employer),
    verified: w.basis === "doc_verified",
    box1: dollars(w.wagesCents),
    box2: dollars(w.fedWithheldCents),
    box3: dollars(w.socialSecurityWagesCents),
    box4: dollars(w.socialSecurityWithheldCents),
    box5: dollars(w.medicareWagesCents),
    box6: dollars(w.medicareWithheldCents),
    box7: dollars(w.socialSecurityTipsCents),
    box10: dollars(w.dependentCareBenefitsCents),
    box12: w.box12.map((b) => ({ code: b.code, amount: dollars(b.amountCents) })),
    retirementPlan: w.retirementPlan,
    box14: w.box14.map((b) => ({ label: clip(b.label, 40), amount: dollars(b.amountCents) })),
    state: w.stateLines.map((s) => ({ state: s.stateCode, wages: dollars(s.wagesCents), withheld: dollars(s.withheldCents) })),
    ctWithheld: dollars(w.ctWithheldCents),
  }));
  const interest = facts.income.interest.map((x) => ({ doc: aliasOf(x.docId), payer: names.payer(x.payer), verified: x.basis === "doc_verified", box1: dollars(x.box1Cents), box3: dollars(x.box3Cents), box4: dollars(x.box4Cents), box6: dollars(x.box6Cents), box8: dollars(x.box8Cents), box9: dollars(x.box9Cents) }));
  const dividends = facts.income.dividends.map((x) => ({ doc: aliasOf(x.docId), payer: names.payer(x.payer), verified: x.basis === "doc_verified", box1a: dollars(x.box1aCents), box1b: dollars(x.box1bCents), box2a: dollars(x.box2aCents), box3: dollars(x.box3Cents), box4: dollars(x.box4Cents), box5: dollars(x.box5Cents), box7: dollars(x.box7Cents), box11: dollars(x.box11Cents) }));
  const brokerSales = facts.income.brokerSales.map((x) => ({
    doc: aliasOf(x.docId),
    payer: names.payer(x.payer),
    verified: x.basis === "doc_verified",
    summaryRead: x.summaryRead,
    rows: x.rows.map((r) => ({ form: r.form, box: r.box, proceeds: dollars(r.proceedsCents), cost: dollars(r.costCents), washSale: dollars(r.washSaleLossDisallowedCents), brokerGainLoss: dollars(r.gainLossCents) })),
    sec1256: dollars(x.sec1256AggregateCents),
    has1099Da: x.forms1099DaPresent,
  }));
  const other = facts.income.otherIncomeBoxes.map((x) => ({ doc: aliasOf(x.docId), payer: names.payer(x.payer), variant: x.variant, box: x.box, label: clip(x.label, 80), amount: dollars(x.amountCents) }));
  const sc = ret.scheduleC;
  const scheduleC =
    sc === null
      ? null
      : {
          lines: sc.lines.map((l) => ({ line: l.lineId, amount: dollars(l.amountCents), accounts: l.accounts.map((a) => ({ code: a.code, name: clip(a.name, 60), amount: dollars(a.rawCents), deductible: dollars(a.deductibleCents) })) })),
          otherExpenseItems: sc.otherExpenseItems.map((o) => ({ code: o.code, name: clip(o.name, 60), amount: dollars(o.amountCents) })),
          unmapped: sc.unmapped.map((u) => ({ code: u.code, name: clip(u.name, 60), amount: dollars(u.totalCents), type: u.glType })),
          needsInput: sc.needsCpa.map((u) => ({ code: u.code, name: clip(u.name, 60), amount: dollars(u.totalCents), reason: clip(u.reason, 160) })),
          homeOfficeActualCandidates: sc.homeOfficeActualCandidates.map((u) => ({ code: u.code, name: clip(u.name, 60), amount: dollars(u.totalCents) })),
          vehicleActual: sc.vehicleActual.map((u) => ({ code: u.code, name: clip(u.name, 60), amount: dollars(u.totalCents) })),
          mileage: { entries: sc.mileage.entries, miles: sc.mileage.miles, deduction: dollars(sc.mileage.deductionCents) },
          cogs: dollars(sc.cogsTotalCents),
          booksInterest: sc.booksInterest.map((b) => ({ code: b.code, name: clip(b.name, 60), amount: dollars(b.amountCents) })),
        };
  const sd = ret.scheduleD;
  const scheduleD =
    sd === null
      ? null
      : {
          required: sd.required,
          exception1: sd.exception1,
          form8949Required: sd.form8949Required,
          taxWorksheetNeeded: sd.taxWorksheetNeeded,
          categories: sd.categories.map((c) => ({ form: c.form, box: c.box, part: c.part, line: c.line, routing: c.routing, proceeds: dollars(c.proceedsCents), cost: dollars(c.costCents), washSale: dollars(c.washSaleCents), gain: dollars(c.gainCents), rows: c.rows.length })),
          carryoverOut: sd.carryoverOut === null ? null : { short: dollars(sd.carryoverOut.shortCents), long: dollars(sd.carryoverOut.longCents) },
        };
  return {
    w2,
    interest,
    dividends,
    brokerSales,
    otherIncomeBoxes: other,
    scheduleC,
    scheduleD,
    statedNone: Object.entries(facts.statedNone).filter(([, v]) => v?.value === true).map(([k]) => k).sort(),
    noInterestConfirmed: sourcedValue(facts.income.noInterestConfirmed),
    noDividendsConfirmed: sourcedValue(facts.income.noDividendsConfirmed),
  };
}

function deductionsOf(facts: Ty2025Facts, aliasOf: AliasOf): ReviewPayload["deductions"] {
  const d = facts.deductions;
  return {
    mortgages: d.mortgages.map((m) => ({ doc: aliasOf(m.docId), verified: m.basis === "doc_verified", interest: dollars(m.interestCents), principal: dollars(m.principalCents), originationYear: m.originationDate === null ? null : clip(m.originationDate, 4), mortgageInsurance: dollars(m.mortgageInsuranceCents), points: dollars(m.pointsCents), address: clip(m.propertyAddress, 80) })),
    propertyTaxBills: d.propertyTaxBills.map((b) => ({ doc: aliasOf(b.docId), verified: b.basis === "doc_verified", kind: b.kind, kindBasis: b.kindBasis, taxType: clip(b.taxType, 40), billed: dollars(b.billedCents), paidInYear: dollars(b.paidInYearCents), address: clip(b.address, 80) })),
    donations: d.donations.map((x) => ({ kind: x.kind, date: x.dateIso.slice(0, 7), amount: dollars(x.amountCents), substantiation: clip(x.substantiation, 40), hasReceipt: x.receiptDocumentId !== null })),
    noDonationsConfirmed: sourcedValue(d.noDonationsConfirmed),
    noPropertyTaxConfirmed: sourcedValue(d.noPropertyTaxConfirmed),
  };
}

function paymentsOf(facts: Ty2025Facts): Record<string, unknown> {
  const p = facts.payments;
  const est = (e: { value: { paidOn: string; amountCents: number; appliesToTaxYear: number }[] | null } | undefined): unknown =>
    (e?.value ?? []).map((x) => ({ paidOn: x.paidOn, forYear: x.appliesToTaxYear, amount: dollars(x.amountCents) }));
  return {
    federal1099Withheld: dollars(p.federal1099WithheldCents),
    federalPaystubWithheld: dollars(p.federalPaystubWithheldCents),
    ctPaystubWithheld: dollars(p.ctPaystubWithheldCents),
    federalEstimates: est(p.federalEstimates),
    federalExtensionPayment: dollars(sourcedValue(p.federalExtensionPayment)),
    federalPriorYearOverpaymentApplied: dollars(sourcedValue(p.federalPriorYearOverpaymentApplied)),
    ctEstimates: est(p.ctEstimates),
    ctExtensionPayment: dollars(sourcedValue(p.ctExtensionPayment)),
    ctPriorYearOverpaymentApplied: dollars(sourcedValue(p.ctPriorYearOverpaymentApplied)),
    ctPriorYearBalancePaidIn2025: dollars(sourcedValue(p.ctPriorYearBalancePaidIn2025)),
    ctUseTax: dollars(sourcedValue(facts.ct.useTax)),
    ctAdditions: dollars(sourcedValue(facts.ct.additions)),
    ctSubtractions: dollars(sourcedValue(facts.ct.subtractions)),
  };
}

function answersOf(facts: Ty2025Facts, labels: PersonLabels): Record<string, unknown> {
  const a = facts.returnAnswers;
  const cents = (s: { value: number | null; basis: string | null } | undefined): { value: number | null; basis: string | null } | null => {
    const l = leaf(s);
    return l === null ? null : { value: dollars(l.value), basis: l.basis };
  };
  return {
    people: a.people.map((p) => ({
      person: labels.of(p.userId) !== "unassigned" ? labels.of(p.userId) : p.slot === "a" ? "Taxpayer M" : "Taxpayer F",
      bornBefore1961: leaf(p.bornBefore1961),
      blind: leaf(p.blind),
      validSsn: leaf(p.validSsn),
      coveredByWorkplacePlan: leaf(p.coveredByWorkplacePlan),
      deferrals: cents(p.deferralsCents),
      traditionalIra: cents(p.traditionalIraCents),
      rothIra: cents(p.rothIraCents),
      hsaCoverage: leaf(p.hsaCoverage),
      hsaDirectContributions: cents(p.hsaDirectContributionsCents),
      tipsChoice: leaf(p.tipsChoice),
      tips: cents(p.tipsCents),
      overtimeChoice: leaf(p.overtimeChoice),
      overtime: cents(p.overtimeCents),
    })),
    studentOrDependent: leaf(a.studentOrDependent),
    retirementDistributionSince2022: leaf(a.retirementDistributionSince2022),
    magiExclusionsNone: leaf(a.magiExclusionsNone),
    carLoan: { choice: leaf(a.carLoan.choice), qualifies: leaf(a.carLoan.qualifies), interest: cents(a.carLoan.interestPaidCents) },
    attestations: { digitalAssets: leaf(a.attestations.digitalAssets), foreignAccounts: leaf(a.attestations.foreignAccounts) },
    capitalGains: { carryoverShort: cents(a.capitalGains.carryoverShortCents), carryoverLong: cents(a.capitalGains.carryoverLongCents), salesComplete: leaf(a.capitalGains.salesComplete), brokerAdjustments: leaf(a.capitalGains.brokerAdjustments) },
    useTax: { choice: leaf(a.useTax.choice), generalRatePurchases: cents(a.useTax.generalRatePurchasesCents) },
    otherIncomeKinds: a.otherIncome === undefined ? null : leaf(a.otherIncome.kinds),
    homeOffice: { eligibility: leaf(facts.income.scheduleC.homeOfficeEligibility), sqft: leaf(facts.income.scheduleC.homeOfficeSqft) },
    household: { filingStatus: leaf(facts.household.filingStatus), noDependents: leaf(facts.household.noDependents), noEvPurchase: leaf(facts.household.noEvPurchase) },
  };
}

function formsOf(bindings: readonly FileBinding[]): PayloadForm[] {
  const out: PayloadForm[] = [];
  for (const b of bindings) {
    if (b.map === null) continue;
    const rows: PayloadForm["rows"] = [];
    const checked: string[] = [];
    let blank = 0;
    for (const l of b.map.lines) {
      const v = b.file.fields.get(l.field);
      if (l.kind === "money") {
        const printed = typeof v === "string" ? v.trim() : "";
        if (printed === "") {
          blank += 1;
          continue;
        }
        let label = String(l.line);
        let formLine = String(l.line);
        if (isLineKey(l.line)) {
          const m = lineMeta(l.line as LineKey);
          label = m.label;
          formLine = m.formLine;
        }
        rows.push({ line: formLine, label: clip(label, 100), printed });
      } else if (l.kind === "check" && v === true) {
        checked.push(`${l.choice}=${String(l.equals)}`);
      }
    }
    for (const t of b.map.tables) {
      t.rows.forEach((row, i) => {
        const cells = Object.entries(row)
          .map(([col, field]) => [col, b.file.fields.get(field)] as const)
          .filter(([, val]) => typeof val === "string" && val.trim() !== "")
          .map(([col, val]) => `${col}=${String(val).trim()}`);
        if (cells.length > 0) rows.push({ line: `${t.table}[${i + 1}]`, label: t.table, printed: clip(cells.join("; "), 200) });
      });
    }
    out.push({ formId: b.file.formId, file: b.file.name, rows, checked, blankMoneyFields: blank });
  }
  return out;
}

// ── builder ───────────────────────────────────────────────────────────────────

export interface PayloadDocumentInput {
  id: string;
  docType: string;
  taxYear: number | null;
  verified: boolean;
  extractionStatus: string | null;
  subjectType: string | null;
  subjectUserId: string | null;
  reextractIncomplete?: boolean;
}

export interface PayloadInput {
  ret: Ty2025Return;
  /** The EFFECTIVE view (overrides applied): what is printed. */
  view: PdfReturnView;
  facts: Ty2025Facts;
  documents: readonly PayloadDocumentInput[];
  /** Filled forms read back from their PDF bytes (lib/tax-review/l1/pdf-read.ts bindFiles). May be empty. */
  bindings: readonly FileBinding[];
  l1Findings: readonly Finding[];
  /** Generic labels of the business entities (their real names are scrubbed). */
  entityLabels: readonly string[];
  /** Employer / payer names: kept as read (default) or replaced by "Employer A" / "Payer B" labels. */
  payerNames?: PayerNameMode;
}

/** The payload with real names still in it: ONLY `serializePayload` may turn it into outgoing text. */
export function buildReviewPayload(input: PayloadInput, people: readonly HouseholdPerson[]): ReviewPayload {
  const labels = personLabels(people);
  const { ret, view, facts } = input;
  const aliasOf = makeAliasOf([
    ...input.documents.map((d) => d.id),
    ...facts.income.w2s.map((x) => x.docId),
    ...facts.income.interest.map((x) => x.docId),
    ...facts.income.dividends.map((x) => x.docId),
    ...facts.income.brokerSales.map((x) => x.docId),
    ...facts.income.otherIncomeBoxes.map((x) => x.docId),
    ...facts.deductions.mortgages.map((x) => x.docId),
    ...facts.deductions.propertyTaxBills.map((x) => x.docId),
  ]);
  const h = ret.headline;
  const head = (a: { status: string; amount: number | null }): { status: string; amount: number | null } => ({ status: plainRuleStatus(a.status), amount: a.amount });
  const headline: ReviewPayload["headline"] = {
    agi: head(h.federal.agi),
    taxableIncome: head(h.federal.taxableIncome),
    totalTax: head(h.federal.totalTax),
    totalPayments: head(h.federal.totalPayments),
    balance: head(h.federal.balance),
    ctAgi: head(h.connecticut.ctAgi),
    ctTax: head(h.connecticut.tax),
    ctPayments: head(h.connecticut.totalPayments),
    ctBalance: head(h.connecticut.balance),
  };
  return {
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    meta: { taxYear: 2025, engineVersion: ret.engineVersion, filingStatus: "married filing jointly", persons: ["Taxpayer M", "Taxpayer F"], entities: [...input.entityLabels] },
    headline,
    headlineNotes: { complete: h.complete, blockingItemCount: h.blockingItemCount, unverifiedDocumentCount: h.unverifiedDocumentCount, derivedInputCount: h.derivedInputCount, undecidedDecisionCount: h.undecidedDecisionCount, caveats: h.caveats.map((c) => clip(c, 240)) },
    lines: linesOf(view),
    rules: rulesOf(ret),
    decisions: ret.decisions.map((d) => ({ id: d.id, label: clip(d.label, 120), chosen: d.chosen, status: d.status })),
    openItems: ret.openItems.map((o) => ({ id: o.id, severity: o.severity, message: clip(o.message, 300), action: clip(o.action, 200), lineKeys: [...o.lineKeys] })),
    conflicts: ret.conflicts.map((c) => ({ factKey: c.factKey, chosen: c.chosen, reason: clip(c.reason, 240) })),
    documents: documentsOf(facts, input.documents, labels, aliasOf),
    income: incomeOf(facts, ret, labels, aliasOf, makePayerNames(input.payerNames ?? "keep")),
    deductions: deductionsOf(facts, aliasOf),
    payments: paymentsOf(facts),
    answers: answersOf(facts, labels),
    priorYear: { totalTaxDollars: dollars(sourcedValue(facts.priorYear.totalTaxCents)), agiDollars: dollars(sourcedValue(facts.priorYear.agiCents)), filingStatus: sourcedValue(facts.priorYear.filingStatus) },
    constants: constantsOf(ret),
    forms: formsOf(input.bindings),
    l1: { findings: input.l1Findings.filter((f) => f.severity !== "info").map((f) => ({ key: f.key, check: f.check, severity: f.severity, message: clip(f.message, 220) })) },
  };
}

export interface SerializedPayload {
  /** The exact JSON text that may leave the app (and the text stored as the run's payload snapshot). */
  json: string;
  payload: ReviewPayload;
  bytes: number;
}

/**
 * Scrub (entity names, addresses), label the household members, mask EINs, and refuse the whole payload if anything identifier-shaped
 * is left. Throws RedactionError (never echoing the text) on refusal.
 */
export function serializePayload(payload: ReviewPayload, people: readonly HouseholdPerson[], scrub: ScrubConfig): SerializedPayload {
  const scrubber = buildScrubber(scrub);
  const scrubbed = scrubDeep(ownerWordingDeep(payload), (s) => scrubber(plainIdentifiers(s)));
  const json = buildOutgoingJson(scrubbed, people, "ai review payload");
  return { json, payload: JSON.parse(json) as ReviewPayload, bytes: Buffer.byteLength(json, "utf8") };
}

// ── what a validator may check a finding against ──────────────────────────────

export interface PayloadIndex {
  /** line key -> amount (null = no amount) and status. */
  lines: ReadonlyMap<string, { amount: number | null; status: string }>;
  /** alias -> full document id as the model wrote it (the alias itself) and the numbers on that document's rows. */
  docs: ReadonlyMap<string, { numbers: ReadonlySet<number> }>;
  headRows: ReadonlyMap<string, number | null>;
  /** Every number in the payload (whole dollars, magnitudes), for the "figure not in payload" guard. */
  numbers: ReadonlySet<number>;
  /** Text the "form_text" citations may quote (line labels, printed rows). */
  formTexts: readonly string[];
}

function collectNumbers(value: unknown, into: Set<number>): void {
  if (typeof value === "number" && Number.isFinite(value)) into.add(Math.abs(value));
  else if (Array.isArray(value)) for (const v of value) collectNumbers(v, into);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value as Record<string, unknown>)) collectNumbers(v, into);
}

export function indexPayload(payload: ReviewPayload): PayloadIndex {
  const lines = new Map<string, { amount: number | null; status: string }>();
  for (const l of payload.lines) lines.set(l.key, { amount: l.amount, status: l.status });
  const numbers = new Set<number>();
  collectNumbers({ headline: payload.headline, lines: payload.lines.map((l) => l.amount), income: payload.income, deductions: payload.deductions, payments: payload.payments, answers: payload.answers, priorYear: payload.priorYear, rules: payload.rules.map((r) => r.alternatives) }, numbers);
  const docs = new Map<string, { numbers: ReadonlySet<number> }>();
  const perDoc = new Map<string, Set<number>>();
  const add = (alias: string, v: unknown): void => {
    const set = perDoc.get(alias) ?? new Set<number>();
    collectNumbers(v, set);
    perDoc.set(alias, set);
  };
  for (const section of [payload.income.w2, payload.income.interest, payload.income.dividends, payload.income.brokerSales, payload.income.otherIncomeBoxes, payload.deductions.mortgages, payload.deductions.propertyTaxBills]) {
    for (const row of section) if (typeof row["doc"] === "string") add(row["doc"], row);
  }
  for (const d of payload.documents) docs.set(d.alias, { numbers: perDoc.get(d.alias) ?? new Set<number>() });
  const headRows = new Map<string, number | null>();
  for (const [k, v] of Object.entries(payload.headline)) headRows.set(k, v.amount);
  return { lines, docs, headRows, numbers, formTexts: [...payload.lines.map((l) => `${l.form} line ${l.line} ${l.label}`), ...payload.forms.flatMap((f) => f.rows.map((r) => `${r.label} ${r.printed}`))] };
}
