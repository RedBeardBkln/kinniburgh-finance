// Pure, DB-free math for ANNUAL and SEMI-ANNUAL budget lines (property tax,
// insurance premium, …).
//
// Model: the line's monthly budget is transferred into its funding account every
// month and accrues there; the full amount is paid out in one lump on the due
// date — once a year (annual) or every six months (semi-annual: the chosen due
// month and the month six after it, e.g. Jun & Dec). For semi-annual the
// "amount due" is the amount of EACH payment. All money here is integer cents (never floats), and nothing imports
// Prisma, so it is safe to use from client components as well as the server.

/** Frequencies that accrue monthly and pay out in one lump on a due date. */
export type LumpSumFrequency = "annual" | "semiannual";

export function isLumpSumFrequency(f: string | null | undefined): f is LumpSumFrequency {
  return f === "annual" || f === "semiannual";
}

/** Months between payments: 12 for annual, 6 for semi-annual. */
export function cycleMonthsFor(f: string | null | undefined): number {
  return f === "semiannual" ? 6 : 12;
}

/** The month(s) of the year a payment falls in, ascending (semi-annual: month and month + 6). */
export function dueMonthsFor(month: number, cycleMonths: number): number[] {
  const months: number[] = [];
  for (let k = 0; k < 12 / cycleMonths; k++) months.push(((month - 1 + k * cycleMonths) % 12) + 1);
  return months.sort((a, b) => a - b);
}

export interface AnnualFundingInput {
  /** The line's monthly budget — the amount transferred in each month. */
  monthlyCents: number;
  /** Amount due on each due date (the annual total, or each semi-annual payment). */
  totalDueCents: number;
  /** Months between payments (12 = annual, the default; 6 = semi-annual). */
  cycleMonths?: number;
  /** 1–12 */
  dueMonth: number;
  /** Day of month, 1–31 (clamped to the month's length, e.g. Feb 30 → Feb 28/29). */
  dueDay: number;
  today: Date;
}

export interface AnnualFundingAssessment {
  nextDueDate: Date;
  previousDueDate: Date;
  /** Whole months elapsed since the previous due date (0 to the cycle length). */
  monthsElapsed: number;
  /** Estimated amount accrued so far this cycle (assumes the monthly amount was transferred every month). */
  accruedToDateCents: number;
  /** Amount that will have accrued by the due date: one monthly transfer per month of the cycle. */
  projectedAtDueCents: number;
  /** How far short of the total due the projection is (0 when fully funded). */
  shortfallCents: number;
  /** Smallest monthly amount that fully funds the bill (amount due / cycle months, rounded up to the cent). */
  requiredMonthlyCents: number;
  isUnderfunded: boolean;
}

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The due date in `year`, with the day clamped to the month's length. */
export function annualDueDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, Math.min(day, daysInMonth(year, month))));
}

/**
 * True when `day` can ever occur in `month` — Feb 29 is allowed (it falls back
 * to Feb 28 in non-leap years), Feb 30 / Apr 31 are not.
 */
export function isValidAnnualDay(month: number, day: number): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= daysInMonth(2024, month); // 2024 is a leap year
}

/** First due date on or after `today`. */
export function nextAnnualDueDate(today: Date, month: number, day: number): Date {
  const t = startOfDayUTC(today);
  const thisYear = annualDueDate(t.getUTCFullYear(), month, day);
  return thisYear.getTime() >= t.getTime() ? thisYear : annualDueDate(t.getUTCFullYear() + 1, month, day);
}

export function assessAnnualFunding(input: AnnualFundingInput): AnnualFundingAssessment {
  const { monthlyCents, totalDueCents, dueMonth, dueDay } = input;
  const cycleMonths = input.cycleMonths ?? 12;
  const today = startOfDayUTC(input.today);

  // Every due date from last year through next year, ascending; the next one is
  // the first on/after today and the previous one sits just before it.
  const dueDates: Date[] = [];
  for (let year = today.getUTCFullYear() - 1; year <= today.getUTCFullYear() + 1; year++) {
    for (const month of dueMonthsFor(dueMonth, cycleMonths)) dueDates.push(annualDueDate(year, month, dueDay));
  }
  dueDates.sort((a, b) => a.getTime() - b.getTime());
  const nextIndex = dueDates.findIndex((dt) => dt.getTime() >= today.getTime());
  const nextDueDate = dueDates[nextIndex] as Date;
  const previousDueDate = dueDates[nextIndex - 1] as Date;

  const rawMonths =
    (today.getUTCFullYear() - previousDueDate.getUTCFullYear()) * 12 +
    (today.getUTCMonth() - previousDueDate.getUTCMonth()) -
    (today.getUTCDate() < previousDueDate.getUTCDate() ? 1 : 0);
  const monthsElapsed = Math.max(0, Math.min(cycleMonths, rawMonths));

  const accruedToDateCents = monthlyCents * monthsElapsed;
  const projectedAtDueCents = monthlyCents * cycleMonths;
  const shortfallCents = Math.max(0, totalDueCents - projectedAtDueCents);
  const requiredMonthlyCents = Math.ceil(totalDueCents / cycleMonths);

  return {
    nextDueDate,
    previousDueDate,
    monthsElapsed,
    accruedToDateCents,
    projectedAtDueCents,
    shortfallCents,
    requiredMonthlyCents,
    isUnderfunded: shortfallCents > 0,
  };
}

export interface AccountReserveAssessment {
  /** Sum of what the account's annual bills should have accrued by now. */
  reservedCents: number;
  /** How much of that reserve the account balance does not cover (0 when covered). */
  shortfallCents: number;
  isShort: boolean;
}

/**
 * Compares an account's actual balance against the money its annual bills
 * should have accrued by now. A balance below the reserve means the reserved
 * funds have been spent or never arrived — a necessary-condition check (the
 * account may also need to cover other bills), so it never says "fine" for a
 * balance that is already too low. Returns null when the balance is unknown.
 */
export function assessAccountReserve(
  balanceCents: number | null,
  accruedToDateCents: number[]
): AccountReserveAssessment | null {
  if (balanceCents === null) return null;
  const reservedCents = accruedToDateCents.reduce((sum, c) => sum + c, 0);
  const shortfallCents = Math.max(0, reservedCents - balanceCents);
  return { reservedCents, shortfallCents, isShort: shortfallCents > 0 };
}
