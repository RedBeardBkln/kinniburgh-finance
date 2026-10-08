// The assistant's data boundary, as DATA. No logic here: the scrubber (scrub.ts) and the source-reading exclusion test
// (lib/__tests__/advisor-exclusions.test.ts) import these lists, so the rule lives in one place.
//
// Nothing below is ever selected, returned, stored or streamed by any assistant tool or layer. A tool that needs a person's
// display name goes through queries/people.ts, which selects only `id` and `name`.

/** Prisma delegates (lower-camel model names) no assistant tool or query may touch. */
export const FORBIDDEN_MODELS: readonly string[] = [
  "vaultEntry",
  "vaultOtp",
  "vaultSession",
  "plaidItem",
  "session",
  "passwordResetToken",
  "pushSubscription",
  "reviewLinkToken",
  // `user` is reachable only through queries/people.ts (select: { id: true, name: true }).
  "user",
  // No tool needs these; excluded for minimalism.
  "reviewBatch",
  "transactionAssignment",
  "dedupAction",
];

/** The one file allowed to read the `user` delegate, and only with the select below. */
export const USER_DELEGATE_FILE = "lib/advisor/queries/people.ts";

/** Column / field identifiers that must never appear in a tool or query module (the test matches them as whole words). */
export const FORBIDDEN_FIELDS: readonly string[] = [
  "passwordHash",
  "totpSecret",
  "notificationPrefs",
  "accessTokenEncrypted",
  "accessToken",
  "cursorEncrypted",
  "plaidAccountId",
  "plaidItemId",
  "plaidTransactionId",
  "fileKey",
  "extractionData",
  "extractionCorrections",
  "extractionRaw",
  "ocrRaw",
  "policyNumber",
  "confirmationCode",
  "ownerStatements",
  // Rental renter name (Phase 2 reads RentalBooking without it).
  "guest",
];

/**
 * JSON keys a tool result may never contain (checked by scrubDeep on every result). A tool that tries to return one fails loudly in
 * tests and is turned into an error result at run time.
 */
export const FORBIDDEN_OUTPUT_KEY_PATTERN =
  /password|totp|secret|token|cursor|encrypted|hash|ssn|\bein\b|routing|fileKey|extractionData|extractionRaw|ocrRaw|plaidAccountId|plaidItemId|plaidTransactionId|policyNumber|confirmationCode/i;

/**
 * The only places a raw-extraction field may appear in assistant code. Empty in Phase 1; since Phase 2 the single document-values query is the
 * one allowed file (get_document_values), and the exclusion test then also requires that file to import resolveTaxDocForCompute, to name the
 * columns only inside a `select: { ... }` block and never to iterate the extraction object. Every other tool / query file naming one of them
 * (list_documents included) fails the scan.
 */
export const ALLOWED_RAW_USES: Readonly<Record<string, readonly string[]>> = {
  "lib/advisor/queries/document-values.ts": ["extractionData", "extractionCorrections", "extractionConfirmedAt", "extractionStatus"],
};

/** Data classes the owner-facing notice says the assistant never sees (pinned against this list by advisor-notice.test.ts). */
export const NEVER_VISIBLE_CLASSES: readonly string[] = [
  "Vault contents",
  "bank logins and bank connection tokens",
  "passwords and sign-in secrets",
  "Social Security numbers",
  "EINs",
  "full account and routing numbers",
  "dates of birth",
  "street addresses",
  "original document files",
];
