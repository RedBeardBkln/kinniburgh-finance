// The tax year the household is CURRENTLY filing a return for. A return for year Y is prepared and filed in
// year Y+1 (and extended returns run into the autumn of Y+1), so until the new calendar year starts the
// "working" tax year is the previous calendar year: in October 2026 that is 2025, not 2026. Landing on the
// current calendar year sent the owner to an empty 2026 questionnaire (55 answers entered in the wrong year).
// Index routes (/tax/forms, /tax/donations, /tax/fixed-assets) redirect here; every year stays reachable via
// the year chips.
export function defaultFilingTaxYear(now: Date = new Date()): number {
  return now.getUTCFullYear() - 1;
}
