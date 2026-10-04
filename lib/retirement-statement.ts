// Pure helpers for the retirement_contribution document type
// (retirement-contribution-document-type). No DB, no server imports, no I/O.
//
// This module only SUMMARISES what a retirement statement / IRS Form 5498 says
// (the contribution figures per kind of account). It decides nothing: it does not
// work out a deductible amount, an income limit, whether a contribution is the
// employee's or the employer's, or anything for the return. A later task wires
// the IRA questionnaire prefill and the engine to this summary; until then
// nothing in the Forms page or the tax engine reads it.
//
// Input is an EFFECTIVE extraction (the AI reading with the owner's corrections
// laid over it - resolveEffectiveExtraction(...).extractionData), never the raw
// extractionData. Anything that is not clearly a whole number of cents, or not
// one of the known words, reads as "not stated" (null): this never guesses.

/** Picker wording (both upload pickers and the Change-type control). */
export const RETIREMENT_PICKER_LABEL = "Retirement contributions (IRA / 401(k) statement or Form 5498)";

/** Short badge wording on the /documents list. */
export const RETIREMENT_BADGE_LABEL = "Retirement";

export type RetirementAccountKind =
  | "traditional_ira"
  | "roth_ira"
  | "sep_ira"
  | "simple_ira"
  | "employer_plan"
  | "unknown";

export type RetirementFormVariant = "form_5498" | "other_statement";

const ACCOUNT_KINDS: readonly RetirementAccountKind[] = [
  "traditional_ira",
  "roth_ira",
  "sep_ira",
  "simple_ira",
  "employer_plan",
  "unknown",
];

const FORM_VARIANTS: readonly RetirementFormVariant[] = ["form_5498", "other_statement"];

/** The four kinds of IRA a Form 5498 reports contributions for, one box each. */
export type RetirementContributionKind = "traditional_ira" | "roth_ira" | "sep_ira" | "simple_ira";

export interface RetirementContributionFigures {
  /** Form 5498 box 1: traditional IRA contributions (made in the year and through April 15 after it, for the form year). */
  traditional_ira: number | null;
  /** Form 5498 box 10: Roth IRA contributions (same window). */
  roth_ira: number | null;
  /** Form 5498 box 8: employer SEP contributions made during the year. */
  sep_ira: number | null;
  /** Form 5498 box 9: SIMPLE contributions made during the year. */
  simple_ira: number | null;
}

export interface RetirementStatementSummary {
  /** At least one figure or the issuer name was read, so there is something to show. */
  hasReading: boolean;
  /** The year the contributions are FOR (the form header year on a Form 5498). */
  taxYear: number | null;
  formVariant: RetirementFormVariant | null;
  issuerName: string | null;
  accountKind: RetirementAccountKind | null;
  /** Integer cents per kind; null = the statement does not state that box. A stated 0 stays 0. */
  contributions: RetirementContributionFigures;
  /** Kinds with a stated figure (including 0), in the fixed order traditional, Roth, SEP, SIMPLE. */
  kindsWithFigures: RetirementContributionKind[];
  /** Kinds with a stated figure greater than zero, same order. */
  kindsWithContributions: RetirementContributionKind[];
  /** Box 13a/13b: a postponed or late contribution made this year for an earlier year. Not part of the figures above. */
  postponed: { amountCents: number | null; forYear: number | null };
  /** Boxes 2, 3, 4, 5: reported on the form but not contributions. */
  other: {
    rolloverCents: number | null;
    rothConversionCents: number | null;
    recharacterizedCents: number | null;
    fairMarketValueCents: number | null;
  };
}

const KIND_ORDER: readonly RetirementContributionKind[] = ["traditional_ira", "roth_ira", "sep_ira", "simple_ira"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `data` object of an effective extraction, tolerating the wrapper shapes callers hold. */
function dataOf(effectiveExtraction: unknown): Record<string, unknown> {
  if (!isRecord(effectiveExtraction)) return {};
  // resolveEffectiveExtraction() returns { extractionData: { data } }.
  const inner = isRecord(effectiveExtraction.extractionData) ? effectiveExtraction.extractionData : effectiveExtraction;
  return isRecord(inner.data) ? inner.data : {};
}

/** A whole, non-negative number of cents, else null (never coerces strings or floats). */
function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function year(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1990 && value <= 2100 ? value : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The contribution figures a retirement statement states, per kind of account,
 * from an effective extraction. Pure; never throws; never guesses.
 */
export function retirementStatementSummary(effectiveExtraction: unknown): RetirementStatementSummary {
  const data = dataOf(effectiveExtraction);

  const contributions: RetirementContributionFigures = {
    traditional_ira: cents(data.iraContributionsCents),
    roth_ira: cents(data.rothIraContributionsCents),
    sep_ira: cents(data.sepContributionsCents),
    simple_ira: cents(data.simpleContributionsCents),
  };
  const other = {
    rolloverCents: cents(data.rolloverContributionsCents),
    rothConversionCents: cents(data.rothConversionCents),
    recharacterizedCents: cents(data.recharacterizedContributionsCents),
    fairMarketValueCents: cents(data.fairMarketValueCents),
  };
  const postponed = { amountCents: cents(data.postponedContributionCents), forYear: year(data.postponedForYear) };

  const kindText = text(data.accountKind);
  const variantText = text(data.formVariant);
  const issuerName = text(data.issuerName);

  const kindsWithFigures = KIND_ORDER.filter((k) => contributions[k] !== null);
  const kindsWithContributions = KIND_ORDER.filter((k) => (contributions[k] ?? 0) > 0);

  const anyFigure =
    kindsWithFigures.length > 0 ||
    postponed.amountCents !== null ||
    Object.values(other).some((v) => v !== null);

  return {
    hasReading: anyFigure || issuerName !== null,
    taxYear: year(data.taxYear),
    formVariant: FORM_VARIANTS.find((v) => v === variantText) ?? null,
    issuerName,
    accountKind: ACCOUNT_KINDS.find((k) => k === kindText) ?? null,
    contributions,
    kindsWithFigures,
    kindsWithContributions,
    postponed,
    other,
  };
}
