// Pure adapters from Ty2025Facts to the typed inputs of the rules. No rule logic
// lives here: this is aggregation (sums over documents, per-person grouping) with
// ONE strict convention: a sum over several documents is null (unknown) as soon as
// one contributing value is null. Nothing is ever defaulted to 0 here.

import type { Decimal } from "@prisma/client/runtime/library";
import type { PersonSsWithholding } from "@/lib/tax2025/rules/payments";
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
  ordinaryDividends: Decimal | null;
  qualifiedDividends: Decimal | null;
  capitalGainDistributions: Decimal | null;
  section199aDividends: Decimal | null;
  privateActivityBondInterest: Decimal | null;
  /** 1099-B / other boxes this engine does not compute are present. */
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
    ordinaryDividends: dividendsKnown ? sumCentsStrict(dividends.map((d) => d.box1aCents)) : null,
    qualifiedDividends: dividendsKnown ? sumCentsStrict(dividends.map((d) => d.box1bCents)) : null,
    capitalGainDistributions: dividendsKnown ? sumCentsStrict(dividends.map((d) => d.box2aCents)) : null,
    section199aDividends: dividendsKnown ? sumCentsStrict(dividends.map((d) => d.box5Cents)) : null,
    privateActivityBondInterest: interestKnown ? sumCentsStrict(interest.map((i) => i.box9Cents)) : null,
    hasCapitalTransactionBoxes: otherIncomeBoxes.some((b) => b.variant === "1099-B"),
    hasRetirementOrSsBoxes: otherIncomeBoxes.some((b) => b.variant === "1099-R" || b.variant === "1099-SSA"),
    hasOtherIncomeBoxes: otherIncomeBoxes.some((b) => b.variant !== "1099-B" && b.variant !== "1099-R" && b.variant !== "1099-SSA"),
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
