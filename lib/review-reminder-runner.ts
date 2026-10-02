// DB-aware runner for the review-queue reminder. Called by
// app/api/cron/review-reminders/route.ts (cron has no NextAuth session, so this
// calls NO actions/*.ts export and does no requireAuth()). The timing rules
// live in lib/review-reminder.ts and are unit tested.
//
// Exactly one reminder per batch: the batch is CLAIMED with a conditional
// updateMany (reminderStatus null -> "sending") and the text is only sent when
// that claim updated exactly one row, so overlapping or repeated cron runs can
// never double-text. A failed reminder is recorded and NOT retried. A run that
// dies between the claim and the result leaves "sending" (never re-sent;
// Eric can Resend by hand).
//
// The reminder mints a NEW link token (only a hash of the first one is stored,
// so the old link cannot be re-sent); the original link keeps working too.
// Nothing here logs tokens, addresses, bodies, or links.

import { db } from "@/lib/db";
import { REMINDER_DELAY_MS, isReminderDue, isWithinSendWindow } from "@/lib/review-reminder";
import { loadQueueItems, mintReminderToken } from "@/lib/review-queue-server";
import {
  GENERIC_SEND_ERROR,
  getAssigneeSmsAddress,
  getSmsSender,
  resolveAppBaseUrl,
  sendReviewSms,
  type SmsSender,
} from "@/lib/sms-sender";

export interface ReminderRunSummary {
  /** True when the run exited early because it is outside the 09:00-20:00 ET window. */
  outsideWindow: boolean;
  /** Candidate batches loaded from the DB. */
  considered: number;
  sent: number;
  failed: number;
  /** Not due / nothing left to tag / lost the claim to another run. */
  skipped: number;
}

export async function runReviewReminders(
  now: Date = new Date(),
  sender: SmsSender = getSmsSender()
): Promise<ReminderRunSummary> {
  const summary: ReminderRunSummary = {
    outsideWindow: false,
    considered: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  if (!isWithinSendWindow(now)) {
    summary.outsideWindow = true;
    return summary;
  }

  // Coarse DB pre-filter; isReminderDue below is the authority.
  const candidates = await db.reviewBatch.findMany({
    where: {
      status: "submitted",
      firstOpenedAt: null,
      reminderStatus: null,
      smsStatus: "sent",
      smsSentAt: { lte: new Date(now.getTime() - REMINDER_DELAY_MS) },
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      status: true,
      firstOpenedAt: true,
      smsStatus: true,
      smsSentAt: true,
      reminderStatus: true,
      expiresAt: true,
      createdBy: { select: { name: true } },
    },
  });
  summary.considered = candidates.length;

  for (const batch of candidates) {
    if (!isReminderDue(batch, now).due || batch.expiresAt === null) {
      summary.skipped += 1;
      continue;
    }

    // Nothing left to tag (everything was tagged elsewhere): don't nag.
    let waiting = 0;
    try {
      waiting = (await loadQueueItems(batch.id)).length;
    } catch {
      console.error("[review-reminder] checking a batch's items failed");
      summary.skipped += 1;
      continue;
    }
    if (waiting === 0) {
      summary.skipped += 1;
      continue;
    }

    // Claim-then-send. The conditions repeat the eligibility ones so a link
    // opened (or a batch closed) since the read above also loses the claim.
    const claim = await db.reviewBatch.updateMany({
      where: { id: batch.id, status: "submitted", firstOpenedAt: null, reminderStatus: null },
      data: { reminderStatus: "sending" },
    });
    if (claim.count !== 1) {
      summary.skipped += 1;
      continue;
    }

    let error: string | null = null;
    try {
      const { token } = await mintReminderToken(batch.id, batch.expiresAt);
      const result = await sendReviewSms({
        address: getAssigneeSmsAddress(),
        baseUrl: resolveAppBaseUrl(),
        token,
        kind: "reminder",
        senderName: batch.createdBy.name,
        sender,
      });
      if (!result.ok) error = result.error;
    } catch {
      console.error("[review-reminder] sending a reminder failed");
      error = GENERIC_SEND_ERROR;
    }

    try {
      await db.reviewBatch.update({
        where: { id: batch.id },
        data:
          error === null
            ? { reminderStatus: "sent", reminderSentAt: now, reminderError: null }
            : { reminderStatus: "failed", reminderError: error },
      });
    } catch {
      console.error("[review-reminder] recording a reminder result failed");
    }
    if (error === null) summary.sent += 1;
    else summary.failed += 1;
  }

  return summary;
}
