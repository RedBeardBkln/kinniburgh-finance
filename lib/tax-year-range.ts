// Pure: year input validation for the "Add a tax year" tax workspace entry
// point. Mirrors the bounds already baked into ensureTaxWorkspace's zod
// schema and uploadTaxDocument's existing taxYear check.

export const MIN_TAX_YEAR = 2000;

/**
 * Validates a candidate tax year: must be an integer, no earlier than
 * MIN_TAX_YEAR, and no later than currentYear + 1 (one year ahead of the
 * current year is allowed so a workspace can be opened in advance — e.g. for
 * an entity whose first-ever filing is next year — without yet appearing in
 * the normal year-grouped list on /tax, which only ever shows currentYear
 * and earlier).
 */
export function isValidPriorYear(year: number, currentYear: number): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(currentYear) &&
    year >= MIN_TAX_YEAR &&
    year <= currentYear + 1
  );
}
