// Advisory substantiation flags for the donation log. Pure: no DB, no side
// effects. Flags NEVER block saving and NEVER assert a deduction. This module
// does not compute a deductible amount, apply an AGI limit, or decide Form 8283
// sections / appraisals - it only reports which records appear to be missing.
//
// Thresholds below were verified against the primary source, IRS Publication 526
// (2025 edition, https://www.irs.gov/publications/p526, fetched 2026-10-03 by the
// orchestrator). Pub. 526 (2025) lists no 2025-vs-2026 rule change for these.
//   * Any cash contribution (any amount): a bank record or a written
//     communication from the charity is needed.
//   * A single contribution of $250 or more: a contemporaneous written
//     acknowledgment from the charity stating the amount and any benefits
//     received is needed (also IRC 170(f)(8); see specs/10).
//   * Total NON-CASH deductions over $500 for the year: Form 8283 is required
//     (Section A for $500-$5,000; Section B for items over $5,000 is
//     appraisal / CPA territory - flagged only, never computed here).

export type DonationFlagLevel = "action" | "cpa" | "info";

export interface DonationFlag {
  code:
    | "ack_needed_250"
    | "cash_no_record"
    | "noncash_no_record"
    | "ack_not_uploaded"
    | "noncash_over_500_form_8283";
  level: DonationFlagLevel;
  message: string;
}

/** IRS Pub. 526 (2025): a contribution of $250 or more needs a written acknowledgment. In cents. */
export const ACK_THRESHOLD_CENTS = 25_000;

/** IRS Pub. 526 (2025): total non-cash deductions OVER $500 require Form 8283. In cents (strictly greater than). */
export const FORM_8283_NONCASH_TOTAL_CENTS = 50_000;

export interface DonationFlagInput {
  amountCents: number;
  kind: string; // "cash" | "noncash"
  substantiation: string; // "none" | "bank_record" | "written_acknowledgment"
  receiptDocumentId: string | null;
}

/** Per-gift flags. At most one record-related flag (rules 1-3), plus the optional upload nudge. */
export function flagsForDonation(d: DonationFlagInput): DonationFlag[] {
  const flags: DonationFlag[] = [];

  if (d.amountCents >= ACK_THRESHOLD_CENTS && d.substantiation !== "written_acknowledgment") {
    flags.push({
      code: "ack_needed_250",
      level: "action",
      message:
        "$250 or more: a contemporaneous written acknowledgment from the charity is needed. A bank record alone is not enough.",
    });
  } else if (d.kind === "cash" && d.substantiation === "none") {
    flags.push({
      code: "cash_no_record",
      level: "action",
      message: "Cash gifts need a bank record or a written acknowledgment from the charity.",
    });
  } else if (d.kind === "noncash" && d.substantiation === "none") {
    flags.push({
      code: "noncash_no_record",
      level: "action",
      message:
        "Get a receipt from the charity (or keep a reliable written record) describing what was donated.",
    });
  }

  if (d.substantiation === "written_acknowledgment" && !d.receiptDocumentId) {
    flags.push({
      code: "ack_not_uploaded",
      level: "info",
      message: "You marked a written acknowledgment but none is uploaded - consider attaching it.",
    });
  }

  return flags;
}

export interface YearDonationInput extends DonationFlagInput {
  archivedAt?: Date | null;
}

/**
 * Year-level flags over one tax year's donations (caller passes that year's rows;
 * archived rows are excluded here defensively). Non-cash total strictly above
 * $500.00 -> CPA flag for Form 8283.
 */
export function flagsForYear(donations: readonly YearDonationInput[]): DonationFlag[] {
  const noncashTotal = donations
    .filter((d) => !d.archivedAt && d.kind === "noncash")
    .reduce((sum, d) => sum + d.amountCents, 0);
  if (noncashTotal > FORM_8283_NONCASH_TOTAL_CENTS) {
    return [
      {
        code: "noncash_over_500_form_8283",
        level: "cpa",
        message:
          "Your decision: Form 8283 may be required - non-cash gifts logged for this year total more than $500. You decide (items over $5,000 can also need an appraisal).",
      },
    ];
  }
  return [];
}

/** Sum of logged amounts by kind, in cents. These are LOGGED totals, not deduction amounts. */
export function loggedTotals(donations: readonly YearDonationInput[]): { cashCents: number; noncashCents: number } {
  let cashCents = 0;
  let noncashCents = 0;
  for (const d of donations) {
    if (d.archivedAt) continue;
    if (d.kind === "cash") cashCents += d.amountCents;
    else if (d.kind === "noncash") noncashCents += d.amountCents;
  }
  return { cashCents, noncashCents };
}
