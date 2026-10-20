// What the Accounts page says when Plaid's liabilitiesGet (card statement data) fails during a sync. Pure.
// null = say nothing: the sync itself succeeded and there is nothing for the owner to do.

export function liabilitiesErrorNote(code: string | null, message: string): string | null {
  switch (code) {
    // The login holds no credit card or loan accounts (e.g. TD Bank checking + savings): there is no statement data to
    // fetch, so this is not an error and re-linking would not change it.
    case "NO_LIABILITY_ACCOUNTS":
      return null;
    case "PRODUCTS_NOT_SUPPORTED":
      return "This bank does not provide statement data through Plaid (Liabilities not supported). Enter the due date and statement balance manually via Edit on the account row.";
    case "INVALID_PRODUCT":
      return "Statement access was never granted for this bank login. Re-link the bank (Accounts → Re-link) and include card/statement access to enable it.";
    case "ADDITIONAL_CONSENT_REQUIRED":
      return "Statement access needs one more consent step at the bank. Use Re-link on this bank and approve the statement/liabilities access on the bank's consent screen. If these are checking or savings accounts only, there is no statement data to get and this can be ignored.";
    default:
      return `Statement data unavailable: ${code ?? message}`;
  }
}
