// The tax year the household is CURRENTLY filing a return for. A return for year Y is prepared and filed in
// year Y+1 (and extended returns run into the autumn of Y+1), so until the new calendar year starts the
// "working" tax year is the previous calendar year: in October 2026 that is 2025, not 2026. Landing on the
// current calendar year sent the owner to an empty 2026 questionnaire (55 answers entered in the wrong year).
// Index routes (/tax/forms, /tax/donations, /tax/fixed-assets) redirect here; every year stays reachable via
// the year chips.
export function defaultFilingTaxYear(now: Date = new Date()): number {
  return now.getUTCFullYear() - 1;
}

/**
 * The notice shown on the Forms page and every questionnaire page when the viewed tax year is not the year
 * being filed (null = no notice). `hrefForDefaultYear` is the same page for the default filing year.
 */
export function yearNotice(
  viewedYear: number,
  defaultYear: number,
  hrefForDefaultYear: string
): { message: string; linkText: string; href: string } | null {
  if (viewedYear === defaultYear) return null;
  return {
    message: `You are viewing ${viewedYear}. The return due Oct 15, ${defaultYear + 1} is for ${defaultYear}:`,
    linkText: `open this page for ${defaultYear}`,
    href: hrefForDefaultYear,
  };
}
