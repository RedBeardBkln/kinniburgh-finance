// Pure, DB-free math for ANNUAL budget lines (property tax, insurance premium, …).
//
// Model: the line's monthly budget is transferred into its funding account every
// month and accrues there all year; the full amount is paid out on one date each
// year. All money here is integer cents (never floats), and nothing imports
// Prisma, so it is safe to use from client components as well as the server.

export interface AnnualFundingInput {
  /** The line's monthly budget — the amount transferred in each month. */
  monthlyCents: number;
  /** Total due on the annual due date. */
  totalDueCents: number;
  /** 1–12 */
  dueMonth: number;
  /** Day of month, 1–31 (clamped to the month's length, e.g. Feb 30 → Feb 28/29). */
  dueDay: number;
  today: Date;
}

export interface AnnualFundingAssessment {
  nextDueDate: Date;
  previousDueDate: Date;
  /** Whole months elapsed since the previous due date (0–12). */
  monthsElapsed: number;
  /** Estimated amount accrued so far this cycle (assumes the monthly amount was transferred every month). */
  accruedToDateCents: number;
  /** Amount that will have accrued by the due date: 12 monthly transfers per cycle. */
  projectedAtDueCents: number;
  /** How far short of the total due the projection is (0 when fully funded). */
  shortfallCents: number;
  /** Smallest monthly amount that fully funds the bill (total due / 12, rounded up to the cent). */
  requiredMonthlyCents: number;
  isUnderfunded: boolean;
}

const MONTHS_PER_CYCLE = 12;

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
  const today = startOfDayUTC(input.today);

  const nextDueDate = nextAnnualDueDate(today, dueMonth, dueDay);
  const previousDueDate = annualDueDate(nextDueDate.getUTCFullYear() - 1, dueMonth, dueDay);

  const rawMonths =
    (today.getUTCFullYear() - previousDueDate.getUTCFullYear()) * 12 +
    (today.getUTCMonth() - previousDueDate.getUTCMonth()) -
    (today.getUTCDate() < previousDueDate.getUTCDate() ? 1 : 0);
  const monthsElapsed = Math.max(0, Math.min(MONTHS_PER_CYCLE, rawMonths));

  const accruedToDateCents = monthlyCents * monthsElapsed;
  const projectedAtDueCents = monthlyCents * MONTHS_PER_CYCLE;
  const shortfallCents = Math.max(0, totalDueCents - projectedAtDueCents);
  const requiredMonthlyCents = Math.ceil(totalDueCents / MONTHS_PER_CYCLE);

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
