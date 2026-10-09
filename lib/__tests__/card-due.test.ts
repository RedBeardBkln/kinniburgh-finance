import { describe, it, expect } from "vitest";
import { classifyCardDue, shouldRemindCardPayment, CARD_REMINDER_WINDOW_DAYS } from "@/lib/card-due";

function d(iso: string, hour = 12): Date {
  return new Date(`${iso}T${String(hour).padStart(2, "0")}:00:00Z`);
}

describe("classifyCardDue", () => {
  it("classifies overdue", () => {
    const info = classifyCardDue(d("2026-08-25"), d("2026-08-31"));
    expect(info.daysUntilDue).toBeLessThan(0);
    expect(info.urgency).toBe("overdue");
  });

  it("classifies due today as imminent", () => {
    const info = classifyCardDue(d("2026-08-31", 13), d("2026-08-31", 12));
    expect(info.urgency).toBe("imminent");
  });

  it("classifies 3 days out as soon", () => {
    const info = classifyCardDue(d("2026-09-03"), d("2026-08-31"));
    expect(info.urgency).toBe("soon");
  });

  it("classifies 10 days out as upcoming", () => {
    const info = classifyCardDue(d("2026-09-10"), d("2026-08-31"));
    expect(info.urgency).toBe("upcoming");
  });
});

describe("shouldRemindCardPayment", () => {
  it("reminds inside the window", () => {
    expect(shouldRemindCardPayment(d("2026-08-31", 13), d("2026-08-31", 12))).toBe(true);
    const within = classifyCardDue(d("2026-09-04"), d("2026-08-31"));
    expect(within.daysUntilDue).toBeLessThanOrEqual(CARD_REMINDER_WINDOW_DAYS);
    expect(shouldRemindCardPayment(d("2026-09-04"), d("2026-08-31"))).toBe(true);
  });

  it("does not remind outside the window", () => {
    expect(shouldRemindCardPayment(d("2026-09-20"), d("2026-08-31"))).toBe(false);
  });

  it("does not fire the standard reminder once overdue (escalation handles it)", () => {
    expect(shouldRemindCardPayment(d("2026-08-25"), d("2026-08-31"))).toBe(false);
  });
});
import { formatCalendarDate } from "../card-due";

describe("formatCalendarDate", () => {
  it("shows a UTC-midnight due date as that same calendar day, not the evening before", () => {
    const due = new Date("2026-10-12T00:00:00.000Z");
    expect(formatCalendarDate(due)).toBe("Oct 12");
    expect(formatCalendarDate(due, "long")).toBe("October 12");
    // The old America/New_York formatting rendered this as the day before.
    expect(
      due.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })
    ).toBe("Oct 11");
  });

  it("handles month and year boundaries", () => {
    expect(formatCalendarDate(new Date("2027-01-01T00:00:00.000Z"))).toBe("Jan 1");
    expect(formatCalendarDate(new Date("2026-12-31T00:00:00.000Z"), "long")).toBe("December 31");
  });
});
