// Twilio implementation of SmsSender for the review queue (twilio-sms-consent), selected by REVIEW_DELIVERY=twilio.
//
// Plain fetch to the Twilio Messages REST API (no twilio package):
//   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
//   application/x-www-form-urlencoded: To (E.164), MessagingServiceSid, Body; HTTP Basic auth with API key SID : secret.
// Sources (checked 2026-11-16): twilio.com/docs/messaging/api/message-resource, twilio.com/docs/usage/requests-to-twilio,
// twilio.com/docs/api/errors/21610. A 2xx means the message was ACCEPTED by Twilio, not delivered (no status callback here).
//
// No database, nothing constructed at import time (the fetch is injected). Privacy rules, same as lib/sms-sender.ts: NEVER log
// the recipient, the body, the link or a credential (this file has no console call at all), and every error string returned is
// a FIXED sentence: Twilio's own `message` / `more_info` text is never read into a result, only its numeric `code`.

import type { SmsResult, SmsSender } from "@/lib/sms-sender";

export type TwilioConfig = {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  messagingServiceSid: string;
};

type Env = Record<string, string | undefined>;

export const TWILIO_ENV_VARS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_MESSAGING_SERVICE_SID",
] as const;

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
// UNVERIFIED shape (plan R6): an API key SID is assumed to be SK + 32 hex like the other SIDs. A key that does not match is
// refused here (fail closed, the variable is named), never sent.
const API_KEY_SID = /^SK[0-9a-fA-F]{32}$/;
const MESSAGING_SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;
/** Printable ASCII, no whitespace, 16-128 characters. */
const API_KEY_SECRET = /^[\x21-\x7E]{16,128}$/;

export function twilioNotConfiguredError(names: readonly string[]): string {
  const list = names.join(", ");
  return `Twilio is not configured (${list} ${names.length === 1 ? "is" : "are"} missing or malformed), so no text was sent.`;
}

export const TWILIO_OPTED_OUT_ERROR = "The recipient has opted out by replying STOP.";
export const TWILIO_UNREACHABLE_ERROR = "Twilio could not be reached, so no text was sent.";
export const TWILIO_BAD_CREDENTIALS_ERROR = "Twilio rejected the app's credentials (error 20003).";
export const TWILIO_INVALID_NUMBER_ERROR = "Twilio says the stored number is not a valid phone number (error 21211).";
export const TWILIO_NOT_MOBILE_ERROR = "Twilio says the stored number cannot receive texts (error 21614).";
export const TWILIO_NO_VALID_NUMBER_ERROR = "No valid mobile number is on file for the assignee.";

/** Pre-flight: all four variables present and well-formed. The error names variables only, never a value. */
export function getTwilioConfig(env: Env = process.env): { ok: true; config: TwilioConfig } | { ok: false; error: string } {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const apiKeySid = env.TWILIO_API_KEY_SID?.trim() ?? "";
  const apiKeySecret = env.TWILIO_API_KEY_SECRET?.trim() ?? "";
  const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? "";
  const bad: string[] = [];
  if (!ACCOUNT_SID.test(accountSid)) bad.push("TWILIO_ACCOUNT_SID");
  if (!API_KEY_SID.test(apiKeySid)) bad.push("TWILIO_API_KEY_SID");
  if (!API_KEY_SECRET.test(apiKeySecret)) bad.push("TWILIO_API_KEY_SECRET");
  if (!MESSAGING_SERVICE_SID.test(messagingServiceSid)) bad.push("TWILIO_MESSAGING_SERVICE_SID");
  if (bad.length > 0) return { ok: false, error: twilioNotConfiguredError(bad) };
  return { ok: true, config: { accountSid, apiKeySid, apiKeySecret, messagingServiceSid } };
}

// GSM 03.38 BASIC character table (the escape character and the extension table, e.g. [ ] { } \ ^ ~ | and the euro sign,
// are deliberately NOT included: a body using them never gets the footer, so the footer can never push a text into two
// segments or into UCS-2).
const GSM7_BASIC = new Set(
  Array.from(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ" +
      "ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
      "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿" +
      "abcdefghijklmnopqrstuvwxyzäöñüà"
  )
);

export function isGsm7Basic(text: string): boolean {
  for (const ch of text) if (!GSM7_BASIC.has(ch)) return false;
  return true;
}

/** One GSM-7 segment. */
export const SINGLE_SEGMENT_MAX = 160;
export const STOP_FOOTER = " Reply STOP to opt out.";

/**
 * Appends the STOP footer only when the whole text stays ONE GSM-7 segment (every character in the basic table and at most
 * 160 characters). Otherwise the body is sent unchanged (Twilio's Messaging Service still honours STOP).
 */
export function withStopFooter(body: string): string {
  const full = body + STOP_FOOTER;
  return isGsm7Basic(full) && full.length <= SINGLE_SEGMENT_MAX ? full : body;
}

/**
 * Brand prefix on every Twilio text (toll-free verification expects each message to name its sender). The review body is
 * capped at 140 characters, so prefix + body always fits one 160-character segment; the STOP footer is added after it only
 * when it still fits (withStopFooter).
 */
export const SMS_BRAND_PREFIX = "Banana Stand: ";

/** The exact Body sent to Twilio: brand prefix, the review text, then the STOP footer when it fits. */
export function formatTwilioBody(body: string): string {
  return withStopFooter(SMS_BRAND_PREFIX + body);
}

const E164_US = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

/** A fixed sentence for a Twilio error code; the provider's own text is never used. */
export function twilioErrorMessage(code: number | null, status: number): string {
  if (code === 21610) return TWILIO_OPTED_OUT_ERROR;
  if (code === 20003) return TWILIO_BAD_CREDENTIALS_ERROR;
  if (code === 21211) return TWILIO_INVALID_NUMBER_ERROR;
  if (code === 21614) return TWILIO_NOT_MOBILE_ERROR;
  if (code !== null) return `Twilio refused the message (error ${code}).`;
  return `Twilio refused the message (status ${Number.isInteger(status) ? status : 0}).`;
}

async function readErrorCode(res: Response): Promise<number | null> {
  try {
    const data: unknown = await res.json();
    if (data && typeof data === "object" && "code" in data) {
      const code = (data as { code: unknown }).code;
      if (typeof code === "number" && Number.isInteger(code) && code > 0 && code < 1_000_000) return code;
    }
  } catch {
    // not JSON: fall through to the HTTP status
  }
  return null;
}

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export const TWILIO_TIMEOUT_MS = 10_000;

export function createTwilioSmsSender(
  config: TwilioConfig,
  fetchFn: FetchFn = (i, init) => fetch(i, init),
  /** How the body is written on the wire. Default: brand prefix + STOP footer. The opt-in confirmation is already complete, so it is sent as-is. */
  format: (body: string) => string = formatTwilioBody
): SmsSender {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`;
  const authorization = `Basic ${btoa(`${config.apiKeySid}:${config.apiKeySecret}`)}`;
  return {
    async send(to, body): Promise<SmsResult> {
      if (!E164_US.test(to)) return { ok: false, error: TWILIO_NO_VALID_NUMBER_ERROR };
      let res: Response;
      try {
        res = await fetchFn(url, {
          method: "POST",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: to,
            MessagingServiceSid: config.messagingServiceSid,
            Body: format(body),
          }).toString(),
          signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
          cache: "no-store",
        });
      } catch {
        return { ok: false, error: TWILIO_UNREACHABLE_ERROR };
      }
      if (res.ok) return { ok: true };
      return { ok: false, error: twilioErrorMessage(await readErrorCode(res), res.status) };
    },
  };
}

/** A sender that refuses every send with a fixed error and never touches the network (Twilio selected but not configured). */
export function createRefusingSmsSender(error: string): SmsSender {
  return {
    async send(): Promise<SmsResult> {
      return { ok: false, error };
    },
  };
}
