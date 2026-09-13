// Pure: prior-year input validation for the "Add a prior year" tax workspace
// entry point. Mirrors the bounds already baked into ensureTaxWorkspace's zod
// schema and uploadTaxDocument's existing taxYear check.

export const MIN_TAX_YEAR = 2000;

/**
 * Validates a candidate prior tax year: must be an integer, no earlier than
 * MIN_TAX_YEAR, and no later than currentYear (this form is for years that
 * aren't already visible on /tax — the existing "Create Workspace" widget
 * already covers the current year).
 */
export function isValidPriorYear(year: number, currentYear: number): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(currentYear) &&
    year >= MIN_TAX_YEAR &&
    year <= currentYear
  );
}
