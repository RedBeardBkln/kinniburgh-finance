// Pure credit-card due-date helpers — client-safe.

export interface CardDueInfo {
  daysUntilDue: number;
  urgency: "overdue" | "imminent" | "soon" | "upcoming";
}

/**
 * Days until a due date (negative = days overdue) and urgency classification.
 * - overdue:  past the due date
 * - imminent: due today or tomorrow
 * - soon:     within 7 days (interest-free window closing)
 * - upcoming: more than 7 days out
 */
export function classifyCardDue(dueDate: Date, now: Date = new Date()): CardDueInfo {
  const daysUntilDue = Math.ceil(
    (dueDate.getTime() - now.getTime()) / 86400000
  );

  let urgency: CardDueInfo["urgency"];
  if (daysUntilDue < 0) urgency = "overdue";
  else if (daysUntilDue <= 1) urgency = "imminent";
  else if (daysUntilDue <= 7) urgency = "soon";
  else urgency = "upcoming";

  return { daysUntilDue, urgency };
}

/** Notification threshold: remind when due within this many days. */
export const CARD_REMINDER_WINDOW_DAYS = 5;

/** True when the daily notification check should fire for this card. */
export function shouldRemindCardPayment(dueDate: Date, now: Date = new Date()): boolean {
  const { daysUntilDue } = classifyCardDue(dueDate, now);
  // Remind from CARD_REMINDER_WINDOW_DAYS days out through the due date itself.
  // Past-due is handled with its own escalated message until resolved.
  return daysUntilDue >= 0 && daysUntilDue <= CARD_REMINDER_WINDOW_DAYS;
}