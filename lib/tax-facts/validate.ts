// Validation for the tax facts store: key shape, typed values, and the privacy guard (tax-facts-carry-forward-store).
//
// The store never holds a Social Security number, an EIN, an account number or a date of birth. Every free-text field
// (label, value text, source reference, reason) is checked BEFORE anything is written, and a rejected text is never
// echoed back (the error only names the field). Money is whole integer cents; never floats.
//
// PURE: no DB, no network, no clock.

import { containsAccountNumberLikeText, containsSsnLikeText } from "@/lib/tax-extraction-schema";
import { findRedactionIssues } from "@/lib/tax-review/redact";
import {
  CARRY_POLICIES,
  FACT_CATEGORIES,
  FACT_LIMITS,
  SOURCE_KINDS,
  VALUE_KINDS,
  asMember,
  type CarryPolicy,
  type FactCategory,
  type FactValueKind,
  type SourceKind,
} from "@/lib/tax-facts/types";

/** Dotted lower-case key with two to six segments ("household.filing_status", "decision.x1.home_office_method"). */
export const FACT_KEY_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+){1,5}$/;

const EIN_SHAPE = /(?<!\d)\d{2}\s?[-‐-―−]\s?\d{7}(?!\d)/;
const BIRTH_DATE_WORDS = /date\s+of\s+birth|\bdob\b|birth\s*date|\bborn\s+(?:on|in)\b/i;
const CHOICE_PATTERN = /^[a-z0-9_:.-]{1,40}$/;
const PERCENT_PATTERN = /^(\d{1,3})(?:\.(\d))?$/;

/** True when the text looks like an SSN, an EIN, an account number or card number, or names a date of birth. */
export function containsPrivateIdentifier(text: string): boolean {
  const t = text.normalize("NFKC");
  return (
    containsSsnLikeText(t) ||
    containsAccountNumberLikeText(t) ||
    EIN_SHAPE.test(t) ||
    BIRTH_DATE_WORDS.test(t) ||
    findRedactionIssues(t).length > 0
  );
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** The message for a rejected text names only the field, never the text. */
export function privacyError(field: string): string {
  return `The ${field} looks like it contains a Social Security number, EIN, account number or date of birth; remove it.`;
}

function checkText(field: string, raw: string | null | undefined, max: number, required: boolean): Checked<string | null> {
  const text = (raw ?? "").trim();
  if (text.length === 0) {
    return required ? { ok: false, error: `The ${field} is required.` } : { ok: true, value: null };
  }
  if (text.length > max) return { ok: false, error: `The ${field} must be ${max} characters or fewer.` };
  if (containsPrivateIdentifier(text)) return { ok: false, error: privacyError(field) };
  return { ok: true, value: text };
}

export function validateFactKey(key: string): Checked<string> {
  if (key.length > FACT_LIMITS.keyMax || !FACT_KEY_PATTERN.test(key)) {
    return { ok: false, error: "The fact key must be dotted lower-case words, for example household.filing_status." };
  }
  if (containsPrivateIdentifier(key)) return { ok: false, error: privacyError("fact key") };
  return { ok: true, value: key };
}

export function validateReason(raw: string | null | undefined, required: boolean): Checked<string | null> {
  const text = (raw ?? "").trim();
  if (text.length === 0 && !required) return { ok: true, value: null };
  if (text.length < FACT_LIMITS.reasonMin) {
    return { ok: false, error: `The reason is required (${FACT_LIMITS.reasonMin} to ${FACT_LIMITS.reasonMax} characters).` };
  }
  return checkText("reason", text, FACT_LIMITS.reasonMax, true);
}

/** A percent as written by the owner ("50", "12.5") in its canonical form (no trailing ".0"), 0 to 100, one decimal. */
export function canonicalPercent(text: string): string | null {
  const m = PERCENT_PATTERN.exec(text.trim());
  if (!m) return null;
  const whole = parseInt(m[1] ?? "", 10);
  const frac = m[2] === undefined ? 0 : parseInt(m[2], 10);
  const tenths = whole * 10 + frac;
  if (!Number.isInteger(tenths) || tenths < 0 || tenths > 1000) return null;
  return frac === 0 ? String(whole) : `${whole}.${frac}`;
}

/** The column is a Postgres INTEGER (Prisma `Int`): a larger value would pass validation and fail inside the write. */
export const MAX_FACT_CENTS = 2_147_483_647;

export interface FactValue {
  valueCents: number | null;
  valueText: string | null;
}

/** Check and canonicalise a value for its kind. The returned value is what gets stored. */
export function validateFactValue(
  kind: FactValueKind,
  valueCents: number | null | undefined,
  valueText: string | null | undefined
): Checked<FactValue> {
  const cents = valueCents ?? null;
  if (kind === "money_cents") {
    if (cents === null || !Number.isSafeInteger(cents)) {
      return { ok: false, error: "The amount must be a whole number of cents." };
    }
    if (Math.abs(cents) > MAX_FACT_CENTS) return { ok: false, error: "The amount is too large." };
    if ((valueText ?? "").trim().length > 0) return { ok: false, error: "An amount fact holds cents only, not text." };
    return { ok: true, value: { valueCents: cents, valueText: null } };
  }
  if (cents !== null) return { ok: false, error: "Only an amount fact holds cents." };

  const raw = (valueText ?? "").trim();
  if (kind === "bool") {
    if (raw !== "yes" && raw !== "no") return { ok: false, error: 'A yes/no fact must be "yes" or "no".' };
    return { ok: true, value: { valueCents: null, valueText: raw } };
  }
  if (kind === "choice") {
    if (!CHOICE_PATTERN.test(raw)) {
      return { ok: false, error: "A choice is up to 40 characters of lower-case letters, digits and _ : . -." };
    }
    return { ok: true, value: { valueCents: null, valueText: raw } };
  }
  if (kind === "percent") {
    const canonical = canonicalPercent(raw);
    if (canonical === null) return { ok: false, error: "A percent must be a number from 0 to 100 with at most one decimal." };
    return { ok: true, value: { valueCents: null, valueText: canonical } };
  }
  // text, none_statement, open_item: free text, guarded
  const checked = checkText("value", raw, FACT_LIMITS.textMax, true);
  if (!checked.ok) return checked;
  return { ok: true, value: { valueCents: null, valueText: checked.value } };
}

export interface FactDraft {
  factKey: string;
  category: string;
  label: string;
  taxYear: number;
  valueKind: string;
  valueCents?: number | null;
  valueText?: string | null;
  carryPolicy: string;
  sourceKind: string;
  sourceRef?: string | null;
}

export interface CheckedDraft {
  factKey: string;
  category: FactCategory;
  label: string;
  taxYear: number;
  valueKind: FactValueKind;
  valueCents: number | null;
  valueText: string | null;
  carryPolicy: CarryPolicy;
  sourceKind: SourceKind;
  sourceRef: string | null;
}

export const MIN_FACT_TAX_YEAR = 2000;
export const MAX_FACT_TAX_YEAR = 2100;

/** Validate every field of a fact (all but the reason, which depends on the kind of change). */
export function validateFactDraft(draft: FactDraft): Checked<CheckedDraft> {
  const key = validateFactKey(draft.factKey);
  if (!key.ok) return key;
  const category = asMember(FACT_CATEGORIES, draft.category);
  if (!category) return { ok: false, error: "Unknown category." };
  const valueKind = asMember(VALUE_KINDS, draft.valueKind);
  if (!valueKind) return { ok: false, error: "Unknown value type." };
  const carryPolicy = asMember(CARRY_POLICIES, draft.carryPolicy);
  if (!carryPolicy) return { ok: false, error: "Unknown carry-forward policy." };
  const sourceKind = asMember(SOURCE_KINDS, draft.sourceKind);
  if (!sourceKind) return { ok: false, error: "Unknown source." };
  if (!Number.isInteger(draft.taxYear) || draft.taxYear < MIN_FACT_TAX_YEAR || draft.taxYear > MAX_FACT_TAX_YEAR) {
    return { ok: false, error: "The tax year is not valid." };
  }
  // An open item is its own kind of record: both the category and the value kind say so, and it has no carry policy.
  if ((category === "open_item") !== (valueKind === "open_item")) {
    return { ok: false, error: "An open item must use the Open items category and the open item type, and nothing else may." };
  }
  if (valueKind === "open_item" && carryPolicy !== "stable") {
    return { ok: false, error: "An open item carries until you resolve it; it has no carry-forward policy." };
  }
  const label = checkText("label", draft.label, FACT_LIMITS.labelMax, true);
  if (!label.ok) return label;
  const sourceRef = checkText("source reference", draft.sourceRef, FACT_LIMITS.sourceRefMax, false);
  if (!sourceRef.ok) return sourceRef;
  const value = validateFactValue(valueKind, draft.valueCents, draft.valueText);
  if (!value.ok) return value;
  return {
    ok: true,
    value: {
      factKey: key.value,
      category,
      label: label.value ?? "",
      taxYear: draft.taxYear,
      valueKind,
      valueCents: value.value.valueCents,
      valueText: value.value.valueText,
      carryPolicy,
      sourceKind,
      sourceRef: sourceRef.value,
    },
  };
}
