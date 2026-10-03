// Pure, DB-free formatter shared by every UI call site that displays a
// Budget/ScheduledBill's due date (budget report, envelope page, monthly
// review). Defensively treats a missing/unrecognized `frequency` as
// "monthly" — old `MonthlyReview.data` JSON rows predate this feature and
// have no `frequency` key at all (see plan Risks #6).

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface ScheduleLike {
  frequency: string | null | undefined;
  payDay: number | null;
  payDayOfWeek: number | null;
  biweeklyAnchorDate: string | Date | null;
  /** 1–12; only used when frequency is "annual". */
  payMonth?: number | null;
}

function normalizeFrequency(f: string | null | undefined): "monthly" | "weekly" | "biweekly" | "annual" {
  return f === "weekly" || f === "biweekly" || f === "annual" ? f : "monthly";
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

/**
 * Formats a due-date string: "15th" (monthly), "Weekly · Mon", "Biweekly · Mon",
 * "Annual · Oct 15".
 */
export function formatSchedule(s: ScheduleLike): string {
  const frequency = normalizeFrequency(s.frequency);

  if (frequency === "annual") {
    const month = s.payMonth ? MONTH_NAMES[s.payMonth - 1] : undefined;
    return month && s.payDay ? `Annual · ${month} ${s.payDay}` : "Annual · —";
  }
  if (frequency === "weekly") {
    const dayName = s.payDayOfWeek !== null ? DAY_NAMES[s.payDayOfWeek] ?? "—" : "—";
    return `Weekly · ${dayName}`;
  }
  if (frequency === "biweekly") {
    const dayName = s.payDayOfWeek !== null ? DAY_NAMES[s.payDayOfWeek] ?? "—" : "—";
    return `Biweekly · ${dayName}`;
  }
  return s.payDay ? ordinal(s.payDay) : "—";
}

/**
 * Sort key for the "By Due Date" sort: weekly/biweekly rows sort together,
 * ordered by weekday, ahead of monthly rows ordered by day-of-month, then annual
 * rows ordered by month/day. Arbitrary
 * but well-defined (see plan Risks #8) — revisit with the user if desired.
 */
export function scheduleSortKey(s: ScheduleLike): [number, number] {
  const frequency = normalizeFrequency(s.frequency);
  if (frequency === "monthly") {
    return [1, s.payDay ?? 99];
  }
  if (frequency === "annual") {
    return [2, (s.payMonth ?? 13) * 100 + (s.payDay ?? 99)];
  }
  return [0, s.payDayOfWeek ?? 99];
}
