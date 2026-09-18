// Pure helpers for the document-review UI's statement-import flow. No DB
// access, no "use server" — safe to import from both a server component
// (app/documents/[id]/review/page.tsx, actions/bank-statements.ts) and a
// client component (components/documents/document-review-client.tsx).

export interface ReviewableRow {
  date: string; // YYYY-MM-DD
  lineType?: "charge" | "payment";
}

/**
 * Default per-row import selection for the review UI. Excludes (unchecks by
 * default, does not delete):
 *  - rows tagged lineType: "payment" (a card payment is the same real cash
 *    movement already captured on the paying checking account's own
 *    statement — importing it too would double-count it)
 *  - rows whose date falls on/after the target account's already-synced
 *    Plaid coverage start (possible duplicate of a live Plaid transaction)
 * Everything else (including rows with no lineType at all, e.g. a plain
 * bank_statement extraction) defaults to selected/checked, matching today's
 * existing "select everything" behavior.
 */
export function defaultImportSelection(
  rows: ReviewableRow[],
  plaidCoverageStartIso: string | null
): number[] {
  return rows
    .map((row, i) => ({ row, i }))
    .filter(
      ({ row }) =>
        row.lineType !== "payment" && !isWithinPlaidCoverage(row.date, plaidCoverageStartIso)
    )
    .map(({ i }) => i);
}

/**
 * True if dateIso falls on or after the account's earliest Plaid-synced
 * transaction date (i.e. within the window Plaid already covers live).
 * ISO YYYY-MM-DD strings compare lexicographically = chronologically.
 * A null coverage start (account has never had a Plaid-synced transaction)
 * never matches.
 */
export function isWithinPlaidCoverage(
  dateIso: string,
  plaidCoverageStartIso: string | null
): boolean {
  if (!plaidCoverageStartIso) return false;
  return dateIso >= plaidCoverageStartIso;
}

/**
 * True only when an already-completed extraction needs to be re-run because
 * the linked account is now known to be a credit_card but the stored
 * extraction predates that knowledge (it ran under the generic
 * bank_statement shape, so no row carries a lineType at all). False for a
 * non-credit-card account, an empty/missing extraction, or an extraction
 * that already has lineType on its rows (already reclassified).
 */
export function needsCreditCardReclassification(
  accountType: string | null | undefined,
  extraction: { transactionRows?: { lineType?: "charge" | "payment" }[] } | null | undefined
): boolean {
  if (accountType !== "credit_card") return false;
  const rows = extraction?.transactionRows;
  if (!rows || rows.length === 0) return false;
  return rows.every((r) => r.lineType === undefined);
}
