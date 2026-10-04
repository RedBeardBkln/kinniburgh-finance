// The owner-approval gate for clean copies and the final package (ai-return-reviewer, step A5; plan 5.7).
//
// `?stamp=0` (clean copies) and `?final=1` (the final package) are served only when the owner has approved the CURRENT
// return: an approval recorded for exactly this return fingerprint (lib/tax2025/pdf/adapter.ts `view.fingerprint`).
// The approval records live in the review store (unit X: TaxReturnApproval, append-only). This file owns only the
// narrow interface the PDF routes depend on, so the routes are testable without a database and the store can be wired at
// merge time without touching the routes again.
//
// Default: NO approval. Until the store is wired (lib/tax2025-pdf-build.ts defaultPdfRouteDeps), every clean-copy request
// is refused (403), which is the safe direction: the stamped draft packet is always available.

export interface ApprovalLookup {
  /**
   * True only when the latest approval for the year is an "approved" row (not withdrawn) whose fingerprint equals
   * `fingerprint` (the CURRENT return fingerprint). Any other state, including "no approval yet", is false.
   * May reject (database error): callers treat a rejection as "not approved".
   */
  currentApproval(fingerprint: string): Promise<boolean>;
}

/** The default until the approval store is wired: nothing is ever approved. */
export const noApprovalLookup: ApprovalLookup = {
  currentApproval: () => Promise.resolve(false),
};

/** The message the routes return (403) for a clean-copy request without a current approval. */
export const CLEAN_COPY_REFUSED = "Clean copies are available only after owner approval of the current return.";
