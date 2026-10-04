// Pure adapters from Ty2025Facts to the typed inputs of the rules. No rule logic
// lives here: this is aggregation (sums over documents, per-person grouping) with
// ONE strict convention: a sum over several documents is null (unknown) as soon as
// one contributing value is null. Nothing is ever defaulted to 0 here.

import type { Decimal } from "@prisma/client/runtime/library";
import { MISSING, ans, mapAns } from "@/lib/tax2025/answer-state";
import type { PersonSsWithholding } from "@/lib/tax2025/rules/payments";
import type { AnsRef, ScheduleDInput } from "@/lib/tax2025/rules/schedule-d";
import type { Ref, Sourced } from "@/lib/tax2025/types";
import type { DonationInput, MortgageInput, PropertyBillInput } from "@/lib/tax2025/rules/schedule-a";
import { ZERO, centsToDollars } from "@/lib/tax2025/money";
import type { EstimatedPayment, Ty2025Facts } from "@/lib/tax2025/facts";
import { addressesMatch } from "@/lib/tax2025/resolve-facts";

/** Sum of cents as dollars; null if any value is null. An empty list sums to 0 (callers decide whether "no documents" is missing). */
export function sumCentsStrict(values: readonly (number | null)[]): Decimal | null {
  let total = ZERO;
  for (const v of values) {
    if (v === null) return null;
    total = total.plus(centsToDollars(v));
  }
  return total;
}

/** Sum treating null as 0 (only for boxes where a blank means nothing was reported, e.g. W-2 box 7). */
export function sumCentsBlankIsZero(values: readonly (number | null)[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(v === null ? ZERO : centsToDollars(v)), ZERO);
}

export interface W2Aggregates {
  hasW2: boolean;
  /** Box 1 total (always known: a W-2 without box 1 is excluded as unusable). */
  wages: Decimal | null;
  fedWithheld: Decimal | null;
  medicareWages: Decimal | null;
  largestBox5: Decimal | null;
  medicareWithheld: Decimal | null;
  /** CT withholding on W-2s; null if any W-2 has none read. */
  ctWithholding: Decimal | null;
  /** The Schedule C owner's own W-2 boxes 3 + 7; null when unknowable (no owner, unattributed W-2, or a box 3 not read). */
  ownerSsWagesAndTips: Decimal | null;
  people: PersonSsWithholding[];
  unattributedW2Count: number;
  nonCtStateWithholdingPresent: boolean;
}

export function aggregateW2s(facts: Ty2025Facts): W2Aggregates {
  const w2s = facts.income.w2s;
  const ownerId = facts.income.scheduleC.ownerUserId.value;
  const unattributed = w2s.filter((w) => w.personUserId === null);
  const ownerW2s = ownerId === null ? [] : w2s.filter((w) => w.personUserId === ownerId);

  let ownerSs: Decimal | null = null;
  if (ownerId !== null && unattributed.length === 0) {
    const box3 = sumCentsStrict(ownerW2s.map((w) => w.socialSecurityWagesCents));
    ownerSs = box3 === null ? null : box3.plus(sumCentsBlankIsZero(ownerW2s.map((w) => w.socialSecurityTipsCents)));
  }

  const box5 = w2s.map((w) => w.medicareWagesCents);
  const largestBox5 =
    box5.length === 0 || box5.some((v) => v === null)
      ? null
      : centsToDollars(Math.max(...(box5 as number[])));

  return {
    hasW2: w2s.length > 0,
    wages: w2s.length === 0 ? null : sumCentsStrict(w2s.map((w) => w.wagesCents)),
    fedWithheld: w2s.length === 0 ? null : sumCentsStrict(w2s.map((w) => w.fedWithheldCents)),
    medicareWages: w2s.length === 0 ? null : sumCentsStrict(box5),
    largestBox5,
    medicareWithheld: w2s.length === 0 ? null : sumCentsStrict(w2s.map((w) => w.medicareWithheldCents)),
    ctWithholding: w2s.length === 0 ? null : sumCentsStrict(w2s.map((w) => w.ctWithheldCents)),
    ownerSsWagesAndTips: ownerSs,
    people: facts.household.people.map((p) => {
      const mine = w2s.filter((w) => w.personUserId === p.userId);
      return { name: p.name, w2Count: distinctEmployerCount(mine), totalWithheld: sumCentsStrict(mine.map((w) => w.socialSecurityWithheldCents)) };
    }),
    unattributedW2Count: unattributed.length,
    nonCtStateWithholdingPresent: w2s.some((w) => w.stateLines.some((l) => l.stateCode !== null && l.stateCode !== "CT" && (l.withheldCents ?? 0) > 0)),
  };
}

export interface InvestmentAggregates {
  /** Interest box 1 + box 3 over every 1099-INT; null if none and not confirmed none, or a legacy doc lacks a box. */
  interest: Decimal | null;
  taxExempt: Decimal | null;
  /** 1099-INT box 8 (tax-exempt interest) total only; null when the interest documents are not known or a box is unread (CT Schedule 1 line 31). */
  exemptInterestBox8: Decimal | null;
  /** 1099-DIV exempt-interest dividends total only (extraction field `div_box11Cents`); null when the dividend documents are not known or unread (CT Schedule 1 line 32). */
  exemptDividends: Decimal | null;
  /** 1099-INT box 3 (US savings bond and Treasury obligation interest, already inside `interest`) total only; null when not known (CT Schedule 1 line 39). */
  usGovInterestBox3: Decimal | null;
  ordinaryDividends: Decimal | null;
  qualifiedDividends: Decimal | null;
  capitalGainDistributions: Decimal | null;
  section199aDividends: Decimal | null;
  privateActivityBondInterest: Decimal | null;
  /** 1099-INT box 6 + 1099-DIV box 7 (foreign tax paid); null when interest or dividends are not fully known. */
  foreignTaxPaid: Decimal | null;
  /** A 1099-B appears among the old "other boxes" (the pre-Schedule D signal). Schedule D uses `facts.income.capitalGains` when present; this is only its fallback. */
  hasCapitalTransactionBoxes: boolean;
  hasRetirementOrSsBoxes: boolean;
  hasOtherIncomeBoxes: boolean;
}

export function aggregateInvestments(facts: Ty2025Facts): InvestmentAggregates {
  const { interest, dividends, otherIncomeBoxes } = facts.income;
  const noInterest = facts.income.noInterestConfirmed.value === true;
  const noDividends = facts.income.noDividendsConfirmed.value === true;
  const interestKnown = interest.length > 0 || noInterest;
  const dividendsKnown = dividends.length > 0 || noDividends;

  const interestTotal = interestKnown
    ? sumCentsStrict([...interest.map((i) => i.box1Cents), ...interest.map((i) => i.box3Cents)])
    : null;
  const taxExempt =
    interestKnown && dividendsKnown
      ? sumCentsStrict([...interest.map((i) => i.box8Cents), ...dividends.map((d) => d.box11Cents)])
      : null;
  return {
    interest: interestTotal,
    taxExempt,
    exemptInterestBox8: interestKnown ? sumCentsStrict(interest.map((i) => i.box8Cents)) : null,
    exemptDividends: dividendsKnown ? sumCentsStrict(dividends.map((d) => d.box11Cents)) : null,
    usGovInterestBox3: interestKnown ? sumCentsStrict(interest.map((i) => i.box3Cents)) : null,
    ordinaryDividends: dividendsKnown ? sumCentsStrict(dividends.map((d) => d.box1aCents)) : null,
    qualifiedDividends: dividendsKnown ? sumCentsStrict(dividends.map((d) => d.box1bCents)) : null,
    capitalGainDistributions: dividendsKnown ? sumCentsStrict(dividends.map((d) => d.box2aCents)) : null,
    section199aDividends: dividendsKnown ? sumCentsStrict(dividends.map((d) => d.box5Cents)) : null,
    privateActivityBondInterest: interestKnown ? sumCentsStrict(interest.map((i) => i.box9Cents)) : null,
    foreignTaxPaid: interestKnown && dividendsKnown ? sumCentsStrict([...interest.map((i) => i.box6Cents), ...dividends.map((d) => d.box7Cents)]) : null,
    hasCapitalTransactionBoxes: otherIncomeBoxes.some((b) => b.variant === "1099-B"),
    hasRetirementOrSsBoxes: otherIncomeBoxes.some((b) => b.variant === "1099-R" || b.variant === "1099-SSA"),
    hasOtherIncomeBoxes: otherIncomeBoxes.some((b) => b.variant !== "1099-B" && b.variant !== "1099-R" && b.variant !== "1099-SSA"),
  };
}

/** Section 1256 contracts present: a 1099 prints a Section 1256 aggregate that is not zero (a printed 0.00 is "no 1256 activity"). Never computed (Form 6781). */
export function section1256Present(facts: Ty2025Facts): boolean {
  return facts.income.brokerSales.some((b) => b.sec1256AggregateCents !== null && b.sec1256AggregateCents !== 0);
}

/**
 * The Schedule D rule's input, from the facts: `income.brokerSales` (the 1099 sales summaries), `returnAnswers.capitalGains` (carryover,
 * every sale listed, broker adjustments), the two capital none-groups in `statedNone` and the 1099-DIV box 2a total.
 *
 * Unread documents: a 1099 with a 1099-B (or 1099-DA) signal whose summary was not read. A 1099-B that exists only in the old
 * `otherIncomeBoxes` (no `brokerSales` entry at all: facts built before the capture side) counts as unread too, flagged `unreadIsLegacy`,
 * which keeps the old "a 1099-B needs the CPA" status when nothing else is unread.
 */
export function scheduleDInput(facts: Ty2025Facts, inv: InvestmentAggregates, fill: boolean): ScheduleDInput {
  const sales = facts.income.brokerSales;
  const cap = facts.returnAnswers.capitalGains;
  const dollars = (leaf: Sourced<number>): AnsRef<Decimal> => ({ a: mapAns(ans(leaf), centsToDollars), refs: leaf.refs });
  const flag = (leaf: Sourced<boolean>): AnsRef<boolean> => ({ a: ans(leaf), refs: leaf.refs });
  const noneGroup = (g: "capital_gain_other" | "capital_special_rates"): AnsRef<boolean> => {
    const leaf = facts.statedNone[g];
    return leaf === undefined ? { a: MISSING, refs: [] } : flag(leaf);
  };
  const toDollars = (v: number | null) => (v === null ? null : centsToDollars(v));
  const dividendRefs = facts.income.dividends.flatMap((d) => d.refs);
  const docRef = (docId: string): Ref => ({ kind: "document", id: docId, label: "1099" });

  const rows: ScheduleDInput["rows"] = [];
  const unread: ScheduleDInput["unreadDocuments"] = [];
  let aggregate1256: Decimal | null = null;
  for (const doc of sales) {
    // a document whose summary was not read, but which signals 1099-B or 1099-DA sales
    if (!doc.summaryRead && (doc.signalled1099B || doc.forms1099DaPresent)) unread.push({ docId: doc.docId, payer: doc.payer, refs: doc.refs });
    if (doc.sec1256AggregateCents !== null) aggregate1256 = (aggregate1256 ?? ZERO).plus(centsToDollars(doc.sec1256AggregateCents));
    if (!doc.summaryRead) continue;
    for (const r of doc.rows) {
      rows.push({
        docId: doc.docId,
        payer: doc.payer,
        refs: doc.refs,
        form: r.form,
        box: r.box,
        proceeds: toDollars(r.proceedsCents),
        cost: toDollars(r.costCents),
        accruedMarketDiscount: toDollars(r.accruedMarketDiscountCents),
        washSale: toDollars(r.washSaleLossDisallowedCents),
        brokerGain: toDollars(r.gainLossCents),
      });
    }
  }
  const known = new Set(sales.map((d) => d.docId));
  const legacyUnread: ScheduleDInput["unreadDocuments"] = [];
  for (const b of facts.income.otherIncomeBoxes) {
    if (b.variant !== "1099-B" || known.has(b.docId) || legacyUnread.some((u) => u.docId === b.docId)) continue;
    legacyUnread.push({ docId: b.docId, payer: b.payer, refs: [docRef(b.docId)] });
  }
  return {
    fill,
    rows,
    unreadDocuments: [...unread, ...legacyUnread],
    unreadIsLegacy: unread.length === 0 && legacyUnread.length > 0,
    section1256: {
      present: section1256Present(facts),
      aggregate: aggregate1256,
      refs: sales.filter((d) => d.sec1256AggregateCents !== null).flatMap((d) => d.refs),
    },
    dividendBoxes2b2dZero: facts.income.dividends.length === 0 || facts.income.dividendBoxes2b2dConfirmedZero === true,
    digitalAssetsPresent: sales.some((d) => d.forms1099DaPresent) || rows.some((r) => r.form === "1099-DA"),
    capGainDistributions: inv.capitalGainDistributions,
    capGainDistributionRefs: dividendRefs,
    carryoverShort: dollars(cap.carryoverShortCents),
    carryoverLong: dollars(cap.carryoverLongCents),
    salesComplete: flag(cap.salesComplete),
    // the answer is "is there something the broker could not know" (Yes = true); the rule wants "confirmed none" (true = none)
    noBrokerAdjustments: { a: mapAns(ans(cap.brokerAdjustments), (v) => !v), refs: cap.brokerAdjustments.refs },
    otherLinesNone: noneGroup("capital_gain_other"),
    specialRatesNone: noneGroup("capital_special_rates"),
    digitalAssets: ans(facts.returnAnswers.attestations.digitalAssets),
    qualifiedDividends: inv.qualifiedDividends,
  };
}

/** Sum of estimated payments APPLYING to `appliesTo`; null when the list is unknown. */
export function estimatesForYear(list: EstimatedPayment[] | null, appliesTo: number): Decimal | null {
  if (list === null) return null;
  return list.filter((e) => e.appliesToTaxYear === appliesTo).reduce((acc, e) => acc.plus(centsToDollars(e.amountCents)), ZERO);
}

/** Sum of estimated payments MADE (paidOn) during `calendarYear`, whatever year they apply to; null when unknown. */
export function estimatesPaidInYear(list: EstimatedPayment[] | null, calendarYear: number): Decimal | null {
  if (list === null) return null;
  return list.filter((e) => e.paidOn.startsWith(`${calendarYear}-`)).reduce((acc, e) => acc.plus(centsToDollars(e.amountCents)), ZERO);
}

export function leafDollars(leaf: { value: number | null }): Decimal | null {
  return leaf.value === null ? null : centsToDollars(leaf.value);
}

export function scheduleAInputs(facts: Ty2025Facts): {
  propertyBills: PropertyBillInput[];
  mortgages: MortgageInput[];
  donations: DonationInput[];
} {
  return {
    propertyBills: facts.deductions.propertyTaxBills.map((b) => ({
      docId: b.docId,
      label: b.label,
      kind: b.kind,
      paid: b.paidInYearCents === null ? null : centsToDollars(b.paidInYearCents),
    })),
    mortgages: facts.deductions.mortgages.map((m, _i, all) => ({
      docId: m.docId,
      label: m.lender ?? "mortgage",
      interest: m.interestCents === null ? null : centsToDollars(m.interestCents),
      principal: m.principalCents === null ? null : centsToDollars(m.principalCents),
      mortgageInsurance: m.mortgageInsuranceCents === null ? null : centsToDollars(m.mortgageInsuranceCents),
      points: m.pointsCents === null ? null : centsToDollars(m.pointsCents),
      legacyFormat: m.legacyFormat,
      needsReview: mortgageNeedsReview(m.propertyAddress, all.map((x) => x.propertyAddress), facts.deductions.primaryResidenceAddress.value),
    })),
    donations: facts.deductions.donations.map((d) => ({
      id: d.id,
      kind: d.kind,
      amount: centsToDollars(d.amountCents),
      amountCents: d.amountCents,
      substantiation: d.substantiation,
      receiptDocumentId: d.receiptDocumentId,
    })),
  };
}


/**
 * A 1098 needs review when its property is not the known primary residence, or, with no known primary residence, when the
 * 1098s on file are for more than one distinct property (the primary one cannot be told apart). One 1098 (or several for
 * the same property) with an unknown primary residence is accepted, as before.
 */
export function mortgageNeedsReview(address: string | null, allAddresses: readonly (string | null)[], primary: string | null): boolean {
  if (primary !== null) return address !== null && !addressesMatch(address, primary);
  const distinct: string[] = [];
  for (const a of allAddresses) if (a !== null && !distinct.some((d) => addressesMatch(d, a))) distinct.push(a);
  return distinct.length > 1;
}

/**
 * Number of DISTINCT employers among a person's W-2s: by employer EIN, falling back to the employer name when the EIN is
 * not read (the resolver raises an advisory for that), falling back to the document when neither is known. Two W-2s from
 * one employer (a correction, or a duplicate) are one employer: the excess Social Security credit needs two employers.
 */
export function distinctEmployerCount(w2s: readonly { employerEin: string | null; employer: string | null; docId: string }[]): number {
  const keys = new Set(
    w2s.map((w) =>
      w.employerEin !== null && w.employerEin !== "" ? `ein:${w.employerEin.replace(/\D/g, "")}` : w.employer !== null && w.employer.trim() !== "" ? `name:${w.employer.trim().toLowerCase()}` : `doc:${w.docId}`
    )
  );
  return keys.size;
}
