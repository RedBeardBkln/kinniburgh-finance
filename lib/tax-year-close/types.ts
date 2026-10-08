// Household tax year close (tax-carry-screen-and-year-close, Phase B): shared types.
//
// Marking a year filed ("closed") and reopening it for revision are each an INSERTED event; nothing is updated or deleted.
// The current state of a year is the event with the highest seq: none = open, closed = filed, reopened = open for revision.
// This label changes no computation, form, PDF, fingerprint or approval.
//
// PURE: no DB, no network, no clock.

export const YEAR_CLOSE_KINDS = ["closed", "reopened"] as const;
export type YearCloseKind = (typeof YEAR_CLOSE_KINDS)[number];

export type YearStatus = "open" | "closed" | "reopened";

/** One stored event (the columns of a `TaxYearCloseEvent` row the pure code needs). */
export interface YearCloseEventRow {
  id: string;
  taxYear: number;
  seq: number;
  kind: YearCloseKind;
  /** closed events only: the date the owner says the return was filed (stored 12:00 UTC, shown in America/New_York). */
  filedOn: Date | null;
  /** closed: optional note; reopened: the required reason. A tax record: never written to AuditLog. */
  note: string | null;
  byName: string;
  at: Date;
}

export const NOTE_MAX = 500;
export const REASON_MIN = 3;

/** Earliest and latest tax year the feature accepts (same range as the facts store). */
export const MIN_CLOSE_TAX_YEAR = 2000;
export const MAX_CLOSE_TAX_YEAR = 2100;
