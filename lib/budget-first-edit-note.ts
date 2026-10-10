// Plain-language wording for the copy-on-first-edit save and for ending a line. PURE and CLIENT-SAFE: no Decimal, no
// Prisma, no Next, no Intl (so server and browser print the same text). The numbers come from the planner
// (lib/budget-materialize.ts via lib/budget-carry-forward-build.ts `loadFirstEditContext`); this file only words them.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "December 2026" for a YYYY-MM period; anything else is returned unchanged. */
export function monthName(period: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  return m ? `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}` : period;
}

function range(months: readonly string[]): string {
  const first = months[0] as string;
  const last = months[months.length - 1] as string;
  return `${monthName(first)} to ${monthName(last)}`;
}

/**
 * What the first change in a carried month saves. `months` = the months that will be saved (ascending, the viewed month
 * last); null = unknown (the count could not be read).
 */
export function firstEditSaveSentence(months: readonly string[] | null): string {
  if (months === null) {
    return "The first time you change something here, the whole list is saved for this month. If earlier months after the last saved one are also empty, they are saved too.";
  }
  if (months.length <= 1) return "The first time you change something here, the whole list is saved for this month.";
  return (
    `The first time you change something here, the list is saved for ${months.length} months (${range(months)}): this month and every empty month before it. ` +
    "Those months then keep their own amounts and no longer follow later changes made to earlier months."
  );
}

/** Same idea for a screen that may show several entities at once: one clause per entity. */
export function firstEditSaveSentenceFor(items: ReadonlyArray<{ name: string; months: readonly string[] | null }>): string {
  if (items.length === 1) return firstEditSaveSentence((items[0] as { months: readonly string[] | null }).months);
  const parts = items.map((i) => (i.months === null ? `${i.name}: not counted` : `${i.name}: ${i.months.length} month${i.months.length === 1 ? "" : "s"}`));
  const multi = items.some((i) => i.months === null || i.months.length > 1);
  return (
    `The first time you change a line here, that line's entity is saved for this month and any empty month before it (${parts.join(", ")}).` +
    (multi ? " Those earlier months then keep their own amounts and no longer follow later changes made to earlier months." : "")
  );
}

/** The muted line in the dashboard's budget-line dialog for a line that is only carried in the month shown. */
export function carriedEditNote(fromPeriod: string, months: readonly string[] | null): string {
  const lead = `Carried from ${monthName(fromPeriod)}: this month has no saved budget of its own yet.`;
  if (months === null) return `${lead} Changing the amount saves the carried budget for this month, and for any empty month before it.`;
  if (months.length <= 1) return `${lead} Changing the amount saves the carried budget for this month.`;
  return `${lead} Changing the amount saves the carried budget for ${months.length} months (${range(months)}): this month and every empty month before it. Those months then keep their own amounts.`;
}

/**
 * Confirm text for ending a line. `laterSavedMonths` = how many saved months AFTER the viewed one already have the line
 * (they are removed with it); null = unknown.
 */
export function endLineConfirmText(lineName: string, periodLabel: string, laterSavedMonths: number | null): string {
  let scope: string;
  if (laterSavedMonths === null) scope = `This removes the line from ${periodLabel} and every later month that already has it`;
  else if (laterSavedMonths === 0) scope = `This removes the line from ${periodLabel}; no later month has it saved`;
  else scope = `This removes the line from ${periodLabel} and the ${laterSavedMonths} later month${laterSavedMonths === 1 ? "" : "s"} that already ${laterSavedMonths === 1 ? "has" : "have"} it`;
  return (
    `End "${lineName}" from ${periodLabel} onward? ${scope}, and it stops appearing in the budget and the forecast from then on. ` +
    "Earlier months are not changed. The linked scheduled bill will also be deactivated."
  );
}
