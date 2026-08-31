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