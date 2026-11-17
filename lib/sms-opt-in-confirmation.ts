// The opt-in confirmation text (twilio-sms-consent follow-up): sent once, right after a NEW consent row is written on the
// Settings page (a first opt-in or a changed number; never for "already on"). Carriers expect a web-form opt-in to be
// confirmed by text.
//
// Never throws and never undoes the saved consent: the caller only adds a sentence to its message. Sent only when the four
// TWILIO_* variables pass pre-flight (independent of REVIEW_DELIVERY, so it works while review links still go by e-mail).
// Same privacy rules as lib/twilio-sms.ts: the number and the body are never logged, errors are fixed sentences.

import { SMS_OPT_IN_CONFIRMATION_TEXT } from "@/lib/sms-consent-text";
import { createTwilioSmsSender, getTwilioConfig, type FetchFn } from "@/lib/twilio-sms";

type Env = Record<string, string | undefined>;

export type OptInConfirmationResult =
  | { status: "sent" }
  | { status: "not_configured" }
  | { status: "failed"; error: string };

export const OPT_IN_CONFIRMATION_SENT = "A confirmation text was sent.";
export const OPT_IN_CONFIRMATION_NOT_CONFIGURED = "No confirmation text was sent because texting is not set up yet.";

export async function sendOptInConfirmation(
  phoneE164: string,
  opts: { env?: Env; fetchFn?: FetchFn } = {}
): Promise<OptInConfirmationResult> {
  const cfg = getTwilioConfig(opts.env ?? process.env);
  if (!cfg.ok) return { status: "not_configured" };
  try {
    const sender = createTwilioSmsSender(cfg.config, opts.fetchFn, (body) => body);
    const res = await sender.send(phoneE164, SMS_OPT_IN_CONFIRMATION_TEXT);
    return res.ok ? { status: "sent" } : { status: "failed", error: res.error };
  } catch {
    return { status: "failed", error: "The confirmation text could not be sent." };
  }
}

/** The sentence added after "Texts are on." */
export function describeOptInConfirmation(result: OptInConfirmationResult): string {
  if (result.status === "sent") return OPT_IN_CONFIRMATION_SENT;
  if (result.status === "not_configured") return OPT_IN_CONFIRMATION_NOT_CONFIGURED;
  return `The confirmation text could not be sent: ${result.error}`;
}
