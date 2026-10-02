// DB-aware wrapper that texts the assignee about a batch and records the outcome
// on the batch (smsStatus / smsSentAt / smsError). Deliberately NOT a
// "use server" module: it is called by requireAuth()-gated actions
// (actions/review-assignments.ts), which own authorization.
//
// Contract: NEVER throws and never rolls anything back. A failed text is a
// recorded, visible state on the batch (Eric sees it with Resend / Get link
// options), not an error that undoes a Submit. Nothing here logs the token,
// the recipient address, the body, or the link.

import { db } from "@/lib/db";
import {
  GENERIC_SEND_ERROR,
  getSmsSender,
  resolveDeliveryAddress,
  resolveAppBaseUrl,
  sendReviewSms,
  type SmsResult,
  type SmsSender,
} from "@/lib/sms-sender";

/**
 * Sends the initial / resend text for a submitted batch and records the result.
 *
 * Recording semantics (one set of columns, so these are the rules):
 *  - smsStatus / smsError describe the MOST RECENT attempt (what Eric sees).
 *  - smsSentAt is the time of the most recent SUCCESSFUL text and is not
 *    cleared by a later failure. The 24h reminder clock runs from it, so a
 *    manual Resend moves the reminder baseline to that resend.
 */
export async function sendBatchText(
  batchId: string,
  token: string,
  kind: "initial" | "resend",
  opts: { sender?: SmsSender; now?: Date } = {}
): Promise<SmsResult> {
  const now = opts.now ?? new Date();
  let result: SmsResult;
  try {
    const [batch, count] = await Promise.all([
      db.reviewBatch.findUnique({
        where: { id: batchId },
        select: {
          createdBy: { select: { name: true } },
          assignee: { select: { email: true } },
        },
      }),
      db.transactionAssignment.count({ where: { batchId, status: "pending" } }),
    ]);
    result = await sendReviewSms({
      address: resolveDeliveryAddress(batch?.assignee.email),
      baseUrl: resolveAppBaseUrl(),
      token,
      kind,
      count,
      senderName: batch?.createdBy.name,
      sender: opts.sender ?? getSmsSender(),
    });
  } catch {
    console.error("[review-sms] preparing a text failed");
    result = { ok: false, error: GENERIC_SEND_ERROR };
  }

  try {
    await db.reviewBatch.update({
      where: { id: batchId },
      data: result.ok
        ? { smsStatus: "sent", smsSentAt: now, smsError: null }
        : { smsStatus: "failed", smsError: result.error },
    });
  } catch {
    // The text outcome could not be recorded; the caller still gets the truth.
    console.error("[review-sms] recording a text result failed");
  }
  return result;
}
