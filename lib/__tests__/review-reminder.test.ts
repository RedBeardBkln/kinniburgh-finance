import { describe, it, expect } from "vitest";
import {
  REMINDER_DELAY_MS,
  REMINDER_SEND_WINDOW,
  isReminderDue,
  isWithinSendWindow,
  type ReminderBatchState,
} from "@/lib/review-reminder";

const HOUR = 60 * 60 * 1000;

// A summer instant well inside the window: 2026-07-15 15:00Z = 11:00 EDT.
const NOW = new Date("2026-07-15T15:00:00Z");

function batch(over: Partial<ReminderBatchState> = {}): ReminderBatchState {
  return {
    status: "submitted",
    firstOpenedAt: null,
    smsStatus: "sent",
    smsSentAt: new Date(NOW.getTime() - 25 * HOUR),
    reminderStatus: null,
    expiresAt: new Date(NOW.getTime() + 5 * 24 * HOUR),
    ...over,
  };
}

describe("isWithinSendWindow (09:00-20:00 America/New_York, start inclusive, end exclusive)", () => {
  it("summer (EDT, UTC-4): edges", () => {
    expect(isWithinSendWindow(new Date("2026-07-15T12:59:00Z"))).toBe(false); // 08:59 EDT
    expect(isWithinSendWindow(new Date("2026-07-15T13:00:00Z"))).toBe(true); // 09:00 EDT
    expect(isWithinSendWindow(new Date("2026-07-15T23:59:00Z"))).toBe(true); // 19:59 EDT
    expect(isWithinSendWindow(new Date("2026-07-16T00:00:00Z"))).toBe(false); // 20:00 EDT
  });

  it("winter (EST, UTC-5): edges", () => {
    expect(isWithinSendWindow(new Date("2026-01-15T13:59:00Z"))).toBe(false); // 08:59 EST
    expect(isWithinSendWindow(new Date("2026-01-15T14:00:00Z"))).toBe(true); // 09:00 EST
    expect(isWithinSendWindow(new Date("2026-01-16T00:59:00Z"))).toBe(true); // 19:59 EST
    expect(isWithinSendWindow(new Date("2026-01-16T01:00:00Z"))).toBe(false); // 20:00 EST
  });

  it("overnight is outside (the existing 08:00 UTC crons would land at 03-04am ET)", () => {
    expect(isWithinSendWindow(new Date("2026-07-15T08:00:00Z"))).toBe(false); // 04:00 EDT
    expect(isWithinSendWindow(new Date("2026-01-15T08:00:00Z"))).toBe(false); // 03:00 EST
  });

  it("midnight local (the h23/24 formatting edge) is outside, not NaN-inside", () => {
    expect(isWithinSendWindow(new Date("2026-07-15T04:00:00Z"))).toBe(false); // 00:00 EDT
  });

  it("DST transition days evaluate in local time (spring forward 2026-03-08, fall back 2026-11-01)", () => {
    // Spring forward: 02:00 EST -> 03:00 EDT on 2026-03-08. 13:00Z is 09:00 EDT.
    expect(isWithinSendWindow(new Date("2026-03-08T13:00:00Z"))).toBe(true);
    expect(isWithinSendWindow(new Date("2026-03-08T12:59:00Z"))).toBe(false); // 08:59 EDT
    // Fall back: 02:00 EDT -> 01:00 EST on 2026-11-01. 14:00Z is 09:00 EST.
    expect(isWithinSendWindow(new Date("2026-11-01T14:00:00Z"))).toBe(true);
    expect(isWithinSendWindow(new Date("2026-11-01T13:59:00Z"))).toBe(false); // 08:59 EST
  });

  it("the daily 15:00 UTC cron lands inside the window on every day of the year", () => {
    const start = Date.UTC(2026, 0, 1, 15, 0, 0);
    for (let d = 0; d < 366; d++) {
      const at = new Date(start + d * 24 * HOUR);
      expect(isWithinSendWindow(at, REMINDER_SEND_WINDOW), at.toISOString()).toBe(true);
    }
  });
});

describe("isReminderDue", () => {
  it("is due: submitted, never opened, text sent >= 24h ago, in window, nothing sent yet", () => {
    expect(isReminderDue(batch(), NOW)).toEqual({ due: true });
  });

  it("24h boundary: 1ms under is too early, exactly 24h and over are due", () => {
    const sentAt = (ms: number) => new Date(NOW.getTime() - ms);
    expect(isReminderDue(batch({ smsSentAt: sentAt(REMINDER_DELAY_MS - 1) }), NOW)).toEqual({
      due: false,
      reason: "too_early",
    });
    expect(isReminderDue(batch({ smsSentAt: sentAt(REMINDER_DELAY_MS) }), NOW)).toEqual({ due: true });
    expect(isReminderDue(batch({ smsSentAt: sentAt(REMINDER_DELAY_MS + 1) }), NOW)).toEqual({ due: true });
  });

  it("fires 24-48h after the text with a once-a-day run: a text at 16:00Z is not due at the next 15:00Z run, but is the day after", () => {
    const sentAt = new Date("2026-07-14T16:00:00Z");
    const run1 = new Date("2026-07-15T15:00:00Z"); // 23h later
    const run2 = new Date("2026-07-16T15:00:00Z"); // 47h later
    expect(isReminderDue(batch({ smsSentAt: sentAt }), run1)).toMatchObject({ due: false, reason: "too_early" });
    expect(isReminderDue(batch({ smsSentAt: sentAt }), run2)).toEqual({ due: true });
  });

  it("24h is measured on absolute time across a DST change (not 'same wall clock tomorrow')", () => {
    // Sent 2026-03-07 15:00Z (10:00 EST). Spring forward happens the next morning,
    // so the next 15:00Z run (11:00 EDT, 2026-03-08) is exactly 24h of elapsed time.
    const sentAt = new Date("2026-03-07T15:00:00Z");
    const run = new Date("2026-03-08T15:00:00Z");
    expect(run.getTime() - sentAt.getTime()).toBe(24 * HOUR);
    expect(isReminderDue(batch({ smsSentAt: sentAt, expiresAt: new Date("2026-03-20T00:00:00Z") }), run)).toEqual({
      due: true,
    });
    // Fall back: 2026-10-31 15:00Z (11:00 EDT) -> 2026-11-01 15:00Z (10:00 EST) is still exactly 24h elapsed.
    const sent2 = new Date("2026-10-31T15:00:00Z");
    const run2 = new Date("2026-11-01T15:00:00Z");
    expect(isReminderDue(batch({ smsSentAt: sent2, expiresAt: new Date("2026-11-20T00:00:00Z") }), run2)).toEqual({
      due: true,
    });
  });

  it("not due once she has opened the link", () => {
    expect(isReminderDue(batch({ firstOpenedAt: new Date(NOW.getTime() - HOUR) }), NOW)).toEqual({
      due: false,
      reason: "already_opened",
    });
  });

  it("exactly one reminder: sending, sent, and failed all block another", () => {
    for (const reminderStatus of ["sending", "sent", "failed"]) {
      expect(isReminderDue(batch({ reminderStatus }), NOW)).toEqual({
        due: false,
        reason: "reminder_already_handled",
      });
    }
  });

  it("not due when the first text failed or never went out", () => {
    expect(isReminderDue(batch({ smsStatus: "failed" }), NOW)).toMatchObject({ reason: "text_not_sent" });
    expect(isReminderDue(batch({ smsStatus: null, smsSentAt: null }), NOW)).toMatchObject({
      reason: "text_not_sent",
    });
    expect(isReminderDue(batch({ smsStatus: "sent", smsSentAt: null }), NOW)).toMatchObject({
      reason: "text_not_sent",
    });
  });

  it("not due for completed / cancelled / draft batches", () => {
    for (const status of ["completed", "cancelled", "draft"]) {
      expect(isReminderDue(batch({ status }), NOW)).toEqual({ due: false, reason: "not_submitted" });
    }
  });

  it("not due once the batch has expired (exclusive at expiresAt) or has no expiry", () => {
    expect(isReminderDue(batch({ expiresAt: new Date(NOW.getTime() + 1) }), NOW)).toEqual({ due: true });
    expect(isReminderDue(batch({ expiresAt: new Date(NOW.getTime()) }), NOW)).toEqual({
      due: false,
      reason: "expired",
    });
    expect(isReminderDue(batch({ expiresAt: null }), NOW)).toEqual({ due: false, reason: "expired" });
  });

  it("outside the 09:00-20:00 ET window it is deferred, not skipped for good", () => {
    const night = new Date("2026-07-15T08:00:00Z"); // 04:00 EDT
    expect(
      isReminderDue(batch({ smsSentAt: new Date(night.getTime() - 30 * HOUR) }), night)
    ).toEqual({ due: false, reason: "outside_window" });
    // the same batch is due at a later in-window run
    expect(
      isReminderDue(batch({ smsSentAt: new Date(night.getTime() - 30 * HOUR) }), new Date("2026-07-15T15:00:00Z"))
    ).toEqual({ due: true });
  });
});
