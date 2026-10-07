// Carry-forward resolver for the tax facts store (tax-facts-carry-forward-store).
//
// Given every stored version of every fact and a target tax year, split the facts into what carries unchanged,
// what needs the owner's re-confirmation, the open items that stay open, what must be asked fresh, and what the
// owner already confirmed for that year. Rules (each pinned by a test):
//  1. Per key, take the highest version whose taxYear <= the target. A retired / resolved latest version yields nothing.
//  2. An open item (value type open_item) is always an open item, whatever its year, until it is resolved.
//  3. A latest version for the target year itself is "already confirmed for the year": nothing to do.
//  4. An earlier year: stable -> carried; reconfirm and derived -> needs re-confirmation; year_specific -> ask fresh
//     (the earlier value is shown as reference only).
//  5. A key whose only versions are for a later year is ignored for this target.
//  6. Every item says which year and version it came from.
//  7. Nothing is synthesised: a key with no row is absent (unanswered stays unanswered, never 0), and the resolver
//     never marks a carried fact "confirmed for the target year"; only a stored `reconfirmed` version can.
// Output order is deterministic (category order, then key). Inputs are never mutated.
//
// PURE: no DB, no network, no clock.

import { carriedFromLabel, provenanceLabel } from "@/lib/tax-facts/format";
import { FACT_CATEGORIES, type TaxFactRow } from "@/lib/tax-facts/types";

export type CarryRow = Pick<
  TaxFactRow,
  | "factKey"
  | "version"
  | "category"
  | "label"
  | "taxYear"
  | "valueKind"
  | "valueCents"
  | "valueText"
  | "carryPolicy"
  | "changeKind"
  | "sourceKind"
  | "confirmedAt"
>;

export interface CarryItem {
  factKey: string;
  category: TaxFactRow["category"];
  label: string;
  valueKind: TaxFactRow["valueKind"];
  valueCents: number | null;
  valueText: string | null;
  carryPolicy: TaxFactRow["carryPolicy"];
  /** The year this value was established / changed / reconfirmed for. Always shown. */
  fromTaxYear: number;
  fromVersion: number;
  /** Where the value came from and when (the stored provenance of the source version). */
  provenanceLabel: string;
  /** How it reaches the target year ("From TY2025 (v1), for TY2026"). */
  carriedLabel: string;
  /** True for ask-fresh items: the old value is a reference only and is not carried. */
  referenceOnly: boolean;
}

export interface CarryForwardResult {
  targetYear: number;
  carried: CarryItem[];
  needsReconfirmation: CarryItem[];
  openItems: CarryItem[];
  askFresh: CarryItem[];
  alreadyConfirmedForYear: CarryItem[];
}

function toItem(row: CarryRow, targetYear: number, referenceOnly: boolean): CarryItem {
  return {
    factKey: row.factKey,
    category: row.category,
    label: row.label,
    valueKind: row.valueKind,
    valueCents: row.valueCents,
    valueText: row.valueText,
    carryPolicy: row.carryPolicy,
    fromTaxYear: row.taxYear,
    fromVersion: row.version,
    provenanceLabel: provenanceLabel(row),
    carriedLabel: referenceOnly
      ? `TY${row.taxYear} value (v${row.version}), shown for reference only; not carried to TY${targetYear}`
      : carriedFromLabel(row, targetYear),
    referenceOnly,
  };
}

function compareItems(a: CarryItem, b: CarryItem): number {
  const ca = FACT_CATEGORIES.indexOf(a.category);
  const cb = FACT_CATEGORIES.indexOf(b.category);
  if (ca !== cb) return ca - cb;
  return a.factKey < b.factKey ? -1 : a.factKey > b.factKey ? 1 : 0;
}

/** The version of each key that applies "as of" a year: the highest version whose taxYear <= year (null when none). */
export function latestAsOfYear(rows: readonly CarryRow[], year: number): Map<string, CarryRow> {
  const best = new Map<string, CarryRow>();
  for (const row of rows) {
    if (row.taxYear > year) continue;
    const cur = best.get(row.factKey);
    if (cur === undefined || row.version > cur.version) best.set(row.factKey, row);
  }
  return best;
}

export function resolveCarryForward(rows: readonly CarryRow[], targetYear: number): CarryForwardResult {
  const result: CarryForwardResult = {
    targetYear,
    carried: [],
    needsReconfirmation: [],
    openItems: [],
    askFresh: [],
    alreadyConfirmedForYear: [],
  };

  for (const row of latestAsOfYear(rows, targetYear).values()) {
    if (row.changeKind === "retired" || row.changeKind === "resolved") continue;
    if (row.valueKind === "open_item") {
      result.openItems.push(toItem(row, targetYear, false));
      continue;
    }
    if (row.taxYear === targetYear) {
      result.alreadyConfirmedForYear.push(toItem(row, targetYear, false));
      continue;
    }
    switch (row.carryPolicy) {
      case "stable":
        result.carried.push(toItem(row, targetYear, false));
        break;
      case "reconfirm":
      case "derived":
        result.needsReconfirmation.push(toItem(row, targetYear, false));
        break;
      case "year_specific":
        result.askFresh.push(toItem(row, targetYear, true));
        break;
    }
  }

  result.carried.sort(compareItems);
  result.needsReconfirmation.sort(compareItems);
  result.openItems.sort(compareItems);
  result.askFresh.sort(compareItems);
  result.alreadyConfirmedForYear.sort(compareItems);
  return result;
}
