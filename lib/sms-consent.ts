// Pure SMS consent rules (twilio-sms-consent): the wording hash, US mobile number normalization and refusals, the fold of the
// append-only consent log into a current state, the plan of the next consent event, and masking for display.
//
// Server-only in practice (it imports node:crypto); client components import the wording from lib/sms-consent-text.ts instead.
// No database, no clock, no network. Error strings NEVER contain the input (a test pins it).

import { createHash } from "node:crypto";
import { SMS_CONSENT_TEXT, SMS_CONSENT_VERSION } from "@/lib/sms-consent-text";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 of the exact consent wording in force (pinned by a test together with SMS_CONSENT_VERSION). */
export const SMS_CONSENT_SHA256 = sha256Hex(SMS_CONSENT_TEXT);

/** How consent was given; the only value today. */
export const SMS_CONSENT_METHOD = "settings_web_form";

export const SMS_CONSENT_KINDS = ["consented", "withdrawn"] as const;
export type SmsConsentKind = (typeof SMS_CONSENT_KINDS)[number];

export const PHONE_INPUT_MAX = 32;

export const PHONE_EMPTY_ERROR = "Enter your mobile number.";
export const PHONE_TOO_LONG_ERROR = "That is too long for a phone number.";
export const PHONE_CHARACTERS_ERROR =
  "Use digits only (spaces, dashes, dots, brackets and a leading +1 are fine).";
export const PHONE_SSN_ERROR = "That looks like a Social Security number, not a phone number.";
export const PHONE_US_ONLY_ERROR = "Only US mobile numbers are supported.";
export const PHONE_SHAPE_ERROR = "Enter a 10-digit US mobile number.";

export type NormalizeResult = { ok: true; e164: string } | { ok: false; error: string };

const ALLOWED_CHARS = /^[0-9 +().-]+$/;
const SSN_SHAPE = /^\d{3}-\d{2}-\d{4}$/;
/** NANP: area code and exchange both start 2-9. */
const NANP_TEN = /^[2-9]\d{2}[2-9]\d{6}$/;
/** A normalized, sendable US number. */
export const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

/** A typed US mobile number -> E.164 (+1XXXXXXXXXX), or a fixed error that never echoes the input. */
export function normalizeUsMobile(raw: string): NormalizeResult {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length === 0) return { ok: false, error: PHONE_EMPTY_ERROR };
  if (s.length > PHONE_INPUT_MAX) return { ok: false, error: PHONE_TOO_LONG_ERROR };
  if (!ALLOWED_CHARS.test(s)) return { ok: false, error: PHONE_CHARACTERS_ERROR };
  const digits = s.replace(/\D/g, "");
  // SSN shape is refused before anything else (a 9-digit input is never a US phone number).
  if (SSN_SHAPE.test(s) || digits.length === 9) return { ok: false, error: PHONE_SSN_ERROR };
  const plusCount = (s.match(/\+/g) ?? []).length;
  if (plusCount > 1 || (plusCount === 1 && !s.startsWith("+"))) return { ok: false, error: PHONE_CHARACTERS_ERROR };
  let ten: string;
  if (plusCount === 1) {
    if (!digits.startsWith("1")) return { ok: false, error: PHONE_US_ONLY_ERROR };
    if (digits.length !== 11) return { ok: false, error: PHONE_SHAPE_ERROR };
    ten = digits.slice(1);
  } else if (digits.length === 10) {
    ten = digits;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    ten = digits.slice(1);
  } else {
    return { ok: false, error: PHONE_SHAPE_ERROR };
  }
  if (!NANP_TEN.test(ten)) return { ok: false, error: PHONE_SHAPE_ERROR };
  return { ok: true, e164: `+1${ten}` };
}

/** Display form of a stored number: the last four digits only ("ending 0123"). The full number is never shown. */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  return digits.length >= 4 ? `ending ${digits.slice(-4)}` : "ending ----";
}

export type ConsentEventRow = {
  seq: number;
  kind: string;
  phoneE164: string;
  wordingVersion: string;
  wordingSha256: string;
  createdAt: Date;
};

export type FoldedConsentState =
  | { status: "on"; phoneE164: string; since: Date; wordingVersion: string; wordingSha256: string }
  | { status: "off"; lastWithdrawnAt: Date | null }
  | { status: "unknown" };

/** Current consent = the row with the highest seq. An unrecognised kind on that row is "unknown" (callers fail closed). */
export function foldConsentState(rows: readonly ConsentEventRow[]): FoldedConsentState {
  if (rows.length === 0) return { status: "off", lastWithdrawnAt: null };
  const latest = [...rows].sort((a, b) => a.seq - b.seq)[rows.length - 1]!;
  if (latest.kind === "consented") {
    return {
      status: "on",
      phoneE164: latest.phoneE164,
      since: latest.createdAt,
      wordingVersion: latest.wordingVersion,
      wordingSha256: latest.wordingSha256,
    };
  }
  if (latest.kind === "withdrawn") return { status: "off", lastWithdrawnAt: latest.createdAt };
  return { status: "unknown" };
}

export type ConsentRequest =
  | { action: "consent"; phoneE164: string; agreed: unknown; wordingVersion: string }
  | { action: "withdraw" };

export type PlannedConsentRow = {
  kind: SmsConsentKind;
  phoneE164: string;
  wordingVersion: string;
  wordingSha256: string;
  method: typeof SMS_CONSENT_METHOD;
};

export type ConsentPlan =
  | { kind: "row"; row: PlannedConsentRow }
  | { kind: "noop"; message: string }
  | { kind: "refused"; error: string };

export const CONSENT_NOT_AGREED_ERROR = "Tick the box to agree to text messages.";
export const CONSENT_STALE_PAGE_ERROR = "This page is out of date. Refresh and try again.";
export const CONSENT_ALREADY_ON_MESSAGE = "Texts are already on for this number.";
export const CONSENT_ALREADY_OFF_MESSAGE = "Texts are already off.";
export const CONSENT_UNKNOWN_STATE_ERROR =
  "Your stored text-message setting is not recognised, so nothing was changed. Turn texts on again to replace it.";

/** The next event for a request, or a no-op / refusal. Pure; the store re-runs it inside its transaction. */
export function planConsentEvent(current: FoldedConsentState, request: ConsentRequest): ConsentPlan {
  if (request.action === "consent") {
    if (request.agreed !== true) return { kind: "refused", error: CONSENT_NOT_AGREED_ERROR };
    if (request.wordingVersion !== SMS_CONSENT_VERSION) return { kind: "refused", error: CONSENT_STALE_PAGE_ERROR };
    if (!US_E164.test(request.phoneE164)) return { kind: "refused", error: PHONE_SHAPE_ERROR };
    if (
      current.status === "on" &&
      current.phoneE164 === request.phoneE164 &&
      current.wordingVersion === SMS_CONSENT_VERSION
    ) {
      return { kind: "noop", message: CONSENT_ALREADY_ON_MESSAGE };
    }
    return {
      kind: "row",
      row: {
        kind: "consented",
        phoneE164: request.phoneE164,
        wordingVersion: SMS_CONSENT_VERSION,
        wordingSha256: SMS_CONSENT_SHA256,
        method: SMS_CONSENT_METHOD,
      },
    };
  }
  if (current.status === "unknown") return { kind: "refused", error: CONSENT_UNKNOWN_STATE_ERROR };
  if (current.status !== "on") return { kind: "noop", message: CONSENT_ALREADY_OFF_MESSAGE };
  return {
    kind: "row",
    row: {
      kind: "withdrawn",
      phoneE164: current.phoneE164,
      wordingVersion: current.wordingVersion,
      wordingSha256: current.wordingSha256,
      method: SMS_CONSENT_METHOD,
    },
  };
}

/** The AuditLog `after` payload for a consent event: ids, kind, seq and wording version only (never the phone number). */
export function consentAuditPayload(event: { id: string; kind: SmsConsentKind; seq: number; wordingVersion: string }): {
  eventId: string;
  kind: SmsConsentKind;
  seq: number;
  wordingVersion: string;
} {
  return { eventId: event.id, kind: event.kind, seq: event.seq, wordingVersion: event.wordingVersion };
}
