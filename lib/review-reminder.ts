// Pure timing/eligibility rules for the single "you haven't opened it" reminder
// on a submitted review batch. No DB, no I/O: lib/review-reminder-runner.ts
// feeds this function and performs the claim-then-send.
//
// Timing notes (documented behaviour, not a bug):
//  - Vercel Hobby only allows a once-a-day cron, so the 24h rule is evaluated
//    once per day. A reminder therefore fires on the first daily run that is at
//    least 24h after the text: 24-48h after it, never sooner.
//  - Texts only go out 09:00-20:00 America/New_York (a window evaluated in NY
//    local time; the 24h span itself is measured on absolute timestamps, so
//    DST transitions can't shorten or lengthen it).

export const REMINDER_DELAY_MS = 24 * 60 * 60 * 1000;

export interface SendWindow {
  /** Inclusive local start hour (0-23). */
  startHour: number;
  /** Exclusive local end hour (1-24). */
  endHour: number;
  timeZone: string;
}

export const REMINDER_SEND_WINDOW: SendWindow = {
  startHour: 9,
  endHour: 20,
  timeZone: "America/New_York",
};

/** Local hour (0-23) of `now` in the window's time zone. */
function localHour(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value;
  return hour === undefined ? NaN : Number(hour) % 24;
}

/** 09:00 is inside, 20:00 is outside (start inclusive, end exclusive), in NY local time. */
export function isWithinSendWindow(now: Date, window: SendWindow = REMINDER_SEND_WINDOW): boolean {
  const hour = localHour(now, window.timeZone);
  if (Number.isNaN(hour)) return false;
  return hour >= window.startHour && hour < window.endHour;
}

export interface ReminderBatchState {
  status: string;
  firstOpenedAt: Date | null;
  /** Result of the most recent text to the assignee ("sent" | "failed" | null). */
  smsStatus: string | null;
  /** When the most recent SUCCESSFUL text was handed to the gateway. */
  smsSentAt: Date | null;
  reminderStatus: string | null;
  expiresAt: Date | null;
}

export type ReminderSkipReason =
  | "not_submitted"
  | "already_opened"
  | "reminder_already_handled"
  | "text_not_sent"
  | "too_early"
  | "expired"
  | "outside_window";

export type ReminderDecision = { due: true } | { due: false; reason: ReminderSkipReason };

/**
 * Whether the one reminder for this batch should go out right now. Order of
 * checks is stable so the reason is meaningful. "Opened" is `firstOpenedAt`,
 * which is only ever set by the client-side effect (never by a link-preview
 * bot's GET).
 */
export function isReminderDue(
  batch: ReminderBatchState,
  now: Date,
  window: SendWindow = REMINDER_SEND_WINDOW
): ReminderDecision {
  if (batch.status !== "submitted") return { due: false, reason: "not_submitted" };
  if (batch.firstOpenedAt !== null) return { due: false, reason: "already_opened" };
  // sending / sent / failed all count: exactly one reminder per batch, and a
  // failed one is never auto-retried (Eric resends by hand).
  if (batch.reminderStatus !== null) return { due: false, reason: "reminder_already_handled" };
  if (batch.smsStatus !== "sent" || batch.smsSentAt === null) {
    return { due: false, reason: "text_not_sent" };
  }
  if (now.getTime() - batch.smsSentAt.getTime() < REMINDER_DELAY_MS) {
    return { due: false, reason: "too_early" };
  }
  // Expiry is exclusive, same as the token rules (lib/review-token.ts).
  if (batch.expiresAt === null || now.getTime() >= batch.expiresAt.getTime()) {
    return { due: false, reason: "expired" };
  }
  if (!isWithinSendWindow(now, window)) return { due: false, reason: "outside_window" };
  return { due: true };
}
