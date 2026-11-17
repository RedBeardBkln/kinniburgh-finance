// DB-aware resolver for WHERE a review-queue text goes (twilio-sms-consent). Not a "use server" module and no auth of its own:
// it is called by lib/review-sms-server.ts (from requireAuth()-gated actions) and lib/review-reminder-runner.ts (the cron), so
// the initial text, a resend and the 24h reminder all go through the same path.
//
// - REVIEW_DELIVERY=twilio: the assignee's OWN stored number, only while their current consent is on. No number / no consent /
//   withdrawn / table missing / read error -> address null with a fixed reason, which the caller records as a visible failed
//   send. There is never a fallback to the email or the gateway address.
// - email / sms: exactly resolveDeliveryAddress() (unchanged behaviour).
// Never throws, never logs the address.

import { readSendableNumber as defaultReadSendableNumber, SMS_CONSENT_READ_ERROR, type SendableNumber } from "@/lib/sms-consent-store";
import { getDeliveryChannel, resolveDeliveryAddress } from "@/lib/sms-sender";

type Env = Record<string, string | undefined>;

export type ReviewRecipient = { address: string | null; addressError?: string };

export async function resolveReviewRecipient(
  assignee: { id: string | null | undefined; email: string | null | undefined },
  env: Env = process.env,
  deps: { readSendableNumber: (userId: string) => Promise<SendableNumber> } = { readSendableNumber: defaultReadSendableNumber }
): Promise<ReviewRecipient> {
  try {
    if (getDeliveryChannel(env) !== "twilio") return { address: resolveDeliveryAddress(assignee.email, env) };
    if (!assignee.id) return { address: null, addressError: SMS_CONSENT_READ_ERROR };
    const read = await deps.readSendableNumber(assignee.id);
    return read.ok ? { address: read.phoneE164 } : { address: null, addressError: read.error };
  } catch {
    return { address: null, addressError: SMS_CONSENT_READ_ERROR };
  }
}
