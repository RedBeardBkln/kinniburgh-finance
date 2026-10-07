// Tax facts carry-forward store: shared types and closed vocabularies (tax-facts-carry-forward-store).
//
// A "fact" is something the owner confirmed for the household return (a filing status, a none-statement, a decision,
// a property use ...). Facts are versioned and append-only: a change, a re-confirmation for a new year, a policy
// change, a retirement and the resolution of an open item are each a NEW version of the same key.
//
// PURE: no DB, no network, no clock. The store is NOT read by the TY2025 engine, the return fingerprint or the
// AI reviewer; nothing in this folder imports from lib/tax2025/** or lib/tax-review/** except the outgoing-text
// guard in validate.ts.

/** Display order of the categories (also the order of every list). */
export const FACT_CATEGORIES = [
  "household",
  "income",
  "business",
  "retirement",
  "payments",
  "property",
  "estate",
  "decision",
  "open_item",
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

export const FACT_CATEGORY_LABELS: Readonly<Record<FactCategory, string>> = {
  household: "Household and roles",
  income: "Income",
  business: "Business",
  retirement: "Retirement",
  payments: "Payments",
  property: "Homes and property",
  estate: "Estate",
  decision: "Decisions you recorded",
  open_item: "Open items",
};

export const VALUE_KINDS = ["text", "choice", "bool", "percent", "money_cents", "none_statement", "open_item"] as const;
export type FactValueKind = (typeof VALUE_KINDS)[number];

/**
 * What happens to a fact when a new tax year starts.
 *  - stable: carries until changed (a deed, a death date, a credit already taken).
 *  - reconfirm: carries as a PRE-FILLED SUGGESTION the owner must confirm again (the default whenever unsure).
 *  - year_specific: never carries (an amount or event of one year); asked fresh.
 *  - derived: a closing figure that is the next year's opening value (needs re-confirmation too).
 */
export const CARRY_POLICIES = ["stable", "reconfirm", "year_specific", "derived"] as const;
export type CarryPolicy = (typeof CARRY_POLICIES)[number];

export const CHANGE_KINDS = ["established", "changed", "reconfirmed", "policy_changed", "retired", "resolved"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const SOURCE_KINDS = ["owner_statement", "document", "decision", "derived"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** One stored version of one fact (the shape of a `TaxFact` row the pure code needs). */
export interface TaxFactRow {
  id: string;
  factKey: string;
  version: number;
  category: FactCategory;
  label: string;
  taxYear: number;
  valueKind: FactValueKind;
  valueCents: number | null;
  valueText: string | null;
  carryPolicy: CarryPolicy;
  changeKind: ChangeKind;
  sourceKind: SourceKind;
  sourceRef: string | null;
  reason: string | null;
  confirmedAt: Date;
  setByName: string;
  setAt: Date;
  archivedAt: Date | null;
}

/** The columns a NEW version row is created with (id, entity and audit columns are added by the store). */
export interface NewFactVersion {
  factKey: string;
  version: number;
  category: FactCategory;
  label: string;
  taxYear: number;
  valueKind: FactValueKind;
  valueCents: number | null;
  valueText: string | null;
  carryPolicy: CarryPolicy;
  changeKind: ChangeKind;
  sourceKind: SourceKind;
  sourceRef: string | null;
  reason: string | null;
  confirmedAt: Date;
}

export const FACT_LIMITS = {
  keyMax: 80,
  labelMax: 120,
  textMax: 600,
  sourceRefMax: 200,
  reasonMin: 3,
  reasonMax: 500,
} as const;

/** Turn a closed-vocabulary string from the database into its type, or null when it is not one of the values. */
export function asMember<T extends string>(list: readonly T[], value: string): T | null {
  return (list as readonly string[]).includes(value) ? (value as T) : null;
}
