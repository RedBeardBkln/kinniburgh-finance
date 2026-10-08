// Owner-visible wording for the tax facts store (tax-facts-carry-forward-store).
//
// Plain string builders so the wording is tested once. Honest by construction: a fact the owner stated is
// "not verified by documents"; nothing here says a fact was reviewed, certified or checked by anyone, and nothing
// mentions who or what computed anything. Dates are shown in America/New_York.
//
// PURE: no DB, no network, no clock.

import type { CarryPolicy, ChangeKind, FactValueKind, SourceKind } from "@/lib/tax-facts/types";

const NY_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** A stored UTC instant as a date in America/New_York ("2026-10-07"). */
export function formatFactDate(d: Date): string {
  return NY_DATE.format(d);
}

export const SOURCE_LABELS: Readonly<Record<SourceKind, string>> = {
  owner_statement: "Owner statement, not verified by documents",
  document: "From a document you filed",
  decision: "Decision you recorded",
  derived: "Closing figure carried as an opening value",
};

export const POLICY_LABELS: Readonly<Record<CarryPolicy, string>> = {
  stable: "Carries until changed",
  reconfirm: "Carries as a suggestion; you re-confirm",
  year_specific: "Never carries; asked fresh each year",
  derived: "Closing figure becomes next year's opening value",
};

export const POLICY_SHORT_LABELS: Readonly<Record<CarryPolicy, string>> = {
  stable: "Stable",
  reconfirm: "Re-confirm",
  year_specific: "Year-specific",
  derived: "Derived",
};

export const CHANGE_LABELS: Readonly<Record<ChangeKind, string>> = {
  established: "Recorded",
  changed: "Changed",
  reconfirmed: "Confirmed again",
  policy_changed: "Policy changed",
  retired: "Retired",
  resolved: "Resolved",
};

function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = abs % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const text = rest === 0 ? `$${grouped}` : `$${grouped}.${String(rest).padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/** The stored value as the owner reads it. Never invents a value: an empty one is shown as "(no value)". */
export function formatFactValue(f: { valueKind: FactValueKind; valueCents: number | null; valueText: string | null }): string {
  switch (f.valueKind) {
    case "money_cents":
      return f.valueCents === null ? "(no value)" : formatCents(f.valueCents);
    case "percent":
      return f.valueText === null ? "(no value)" : `${f.valueText}%`;
    case "bool":
      return f.valueText === "yes" ? "Yes" : f.valueText === "no" ? "No" : "(no value)";
    case "choice":
      return f.valueText === null ? "(no value)" : f.valueText.replace(/_/g, " ");
    default:
      return f.valueText === null || f.valueText.length === 0 ? "(no value)" : f.valueText;
  }
}

/** "confirmed 2026-10-07 for TY2025 (v1)". Only for a fact the owner actually confirmed (see `provenanceLabel`). */
export function confirmedLabel(f: { confirmedAt: Date; taxYear: number; version: number }): string {
  return `confirmed ${formatFactDate(f.confirmedAt)} for TY${f.taxYear} (v${f.version})`;
}

/**
 * The dated part of the provenance line. A fact the owner confirmed reads "confirmed ... for TY...". An open item is a
 * question, never a confirmed fact ("Recorded ... for TY..."), and a retired / resolved version is the retirement
 * itself, not a confirmation of the value ("Retired ... from TY..." / "Resolved ... from TY...").
 */
export function datedLabel(f: {
  valueKind: FactValueKind;
  changeKind: ChangeKind;
  confirmedAt: Date;
  taxYear: number;
  version: number;
}): string {
  const date = formatFactDate(f.confirmedAt);
  if (f.changeKind === "retired") return `Retired ${date} from TY${f.taxYear} (v${f.version})`;
  if (f.changeKind === "resolved") return `Resolved ${date} from TY${f.taxYear} (v${f.version})`;
  if (f.valueKind === "open_item") return `Recorded ${date} for TY${f.taxYear} (v${f.version})`;
  return confirmedLabel(f);
}

/** "confirmed" for a fact the owner confirmed, "recorded" for an open item or a retired / resolved version. */
export function confirmationWord(f: { valueKind: FactValueKind; changeKind: ChangeKind }): "confirmed" | "recorded" {
  return f.valueKind === "open_item" || f.changeKind === "retired" || f.changeKind === "resolved" ? "recorded" : "confirmed";
}

/** The line shown on every fact and every carried suggestion: where it came from and which year. */
export function provenanceLabel(f: {
  sourceKind: SourceKind;
  valueKind: FactValueKind;
  changeKind: ChangeKind;
  confirmedAt: Date;
  taxYear: number;
  version: number;
}): string {
  return `${SOURCE_LABELS[f.sourceKind]}; ${datedLabel(f)}`;
}

/** The label of a value that was carried from an earlier year. The year it came from is always shown. */
export function carriedFromLabel(f: { taxYear: number; version: number; carryPolicy: CarryPolicy }, targetYear: number): string {
  if (f.carryPolicy === "derived") return `Opening value from the TY${f.taxYear} closing figure (v${f.version}), for TY${targetYear}`;
  return `From TY${f.taxYear} (v${f.version}), for TY${targetYear}`;
}

/** What the page says about the store (stated once so the wording is tested). */
export const FACTS_PAGE_HONESTY =
  "These are facts you told the app. They are not verified by documents unless a row says so. The TY2025 return, its checks and its approval do not read this store: the return uses the answers and decisions recorded on the Tax Forms page. Nothing here is a computed figure.";

/** The honest status of the carry-forward mechanism itself (stated once so the wording is tested). */
export const FACTS_CARRY_STATUS =
  "The carry-forward screen lets you carry these facts into a new tax year one fact at a time. Nothing re-confirms a fact for you, and no questionnaire, return computation, review or approval reads these facts.";

/** What the carry screen says about itself, directly under its heading (stated once so the wording is tested). */
export const FACTS_CARRY_SCREEN_HONESTY =
  "Confirming a fact here records only that you say it is still true for the new tax year; it is not verified by documents. The TY2025 return and its approval do not read this store, and no questionnaire, computation or review uses it. Open items are questions, not facts, and are never confirmed here. Decisions are a recorded copy for recall; the return uses the decision recorded on the Tax Forms page.";

export const MIGRATION_MISSING_MESSAGE =
  "The facts table has not been created yet: the migration has not been applied. Nothing is wrong with your data.";
