// SMS sending for the "Assign to Eva" review queue.
//
// Today a text is an email to the assignee's carrier email-to-SMS gateway
// address, sent through the existing Resend setup (lib/resend.ts). The
// `SmsSender` interface is the swap point for a real provider (Twilio) later:
// nothing outside getSmsSender() knows how a text is actually delivered.
//
// Privacy rules for this file (a test pins them): NEVER log the recipient
// address, the message body, or the link; error strings returned to callers
// never contain an email address, a URL, or a token.

export type SmsResult = { ok: true } | { ok: false; error: string };

export interface SmsSender {
  /** Never throws for provider errors; returns a sanitized error string instead. */
  send(to: string, body: string): Promise<SmsResult>;
}

export type ReviewSmsKind = "initial" | "reminder" | "resend";

/** Carriers prepend the email subject to the text, so keep it tiny. */
export const SMS_SUBJECT = "Review";
/** Body budget: a single 160-char SMS minus room for the gateway-added subject. */
export const SMS_BODY_MAX = 140;

export const SMS_NOT_CONFIGURED_ERROR =
  "SMS gateway address is not configured (set EVA_SMS_GATEWAY_ADDRESS).";
export const BASE_URL_NOT_CONFIGURED_ERROR =
  "The app's public URL is not configured (NEXTAUTH_URL), so no link could be built.";
export const GENERIC_SEND_ERROR = "The text could not be sent.";

type Env = Record<string, string | undefined>;

const EMAIL_SHAPE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * Where the assignee's texts go. Today: a single env var (Eva is the only
 * assignee). Unset, blank or not-an-email-shaped -> null, which the caller
 * records as a visible failed send (never a silent no-op). The address itself
 * is never hardcoded or logged.
 */
export function getAssigneeSmsAddress(env: Env = process.env): string | null {
  const raw = env.EVA_SMS_GATEWAY_ADDRESS?.trim();
  if (!raw || !EMAIL_SHAPE.test(raw)) return null;
  return raw;
}

/**
 * Server-side public origin for building the link. Uses NEXTAUTH_URL (the
 * repo's existing convention, actions/auth.ts). Deliberately does NOT fall back
 * to VERCEL_URL: that is a per-deployment hostname that can be
 * deployment-protected or stale, which would put a dead link in a text. A
 * localhost value in a production runtime is treated as unreliable (null).
 */
export function resolveAppBaseUrl(env: Env = process.env): string | null {
  const raw = env.NEXTAUTH_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname;
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  const isProd = env.VERCEL_ENV === "production" || env.NODE_ENV === "production";
  if (isLocal && isProd) return null;
  return url.origin;
}

function safeSenderName(name: string | undefined): string {
  const cleaned = (name ?? "").replace(/[^\p{L} '.-]/gu, "").trim().split(/\s+/)[0] ?? "";
  return cleaned.length > 0 ? cleaned.slice(0, 20) : "Eric";
}

/**
 * The text itself: short, plain, one SMS. Always contains the URL; falls back
 * to a minimal wording if a very long host would push it over the budget.
 */
export function buildReviewSmsBody(input: {
  kind: ReviewSmsKind;
  url: string;
  /** Number of transactions waiting; omitted -> generic wording. */
  count?: number;
  senderName?: string;
}): string {
  const who = safeSenderName(input.senderName);
  let body: string;
  if (input.kind === "reminder") {
    body = `Reminder: ${who} has transactions for you to tag: ${input.url}`;
  } else {
    const what =
      input.count !== undefined && input.count > 0
        ? `${input.count} transaction${input.count === 1 ? "" : "s"}`
        : "transactions";
    body = `${who} has ${what} for you to tag: ${input.url}`;
  }
  if (body.length > SMS_BODY_MAX) body = `Transactions to tag: ${input.url}`;
  return body;
}

/**
 * Turns a thrown provider error into a message that is safe to store and show
 * Eric: no email addresses, URLs, or long token-like strings, and bounded
 * length. The useful part of a provider message (e.g. "domain is not
 * verified") survives.
 */
export function sanitizeSmsError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const cleaned = raw
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[^\s@,;<>()"']+@[^\s@,;<>()"']+/g, "[address]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return GENERIC_SEND_ERROR;
  return cleaned.length > 160 ? `${cleaned.slice(0, 157)}...` : cleaned;
}

type SendEmailFn = (args: { to: string; subject: string; text: string }) => Promise<void>;

// Imported lazily so merely importing this module never constructs the Resend
// client (it needs RESEND_API_KEY at construction).
const defaultSendEmail: SendEmailFn = async (args) => {
  const { sendEmail } = await import("@/lib/resend");
  await sendEmail(args);
};

/** Email-to-SMS gateway implementation of SmsSender (plain text, tiny subject). */
export function createEmailGatewaySmsSender(send: SendEmailFn = defaultSendEmail): SmsSender {
  return {
    async send(to, body) {
      try {
        await send({ to, subject: SMS_SUBJECT, text: body });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: sanitizeSmsError(err) };
      }
    },
  };
}

/** The sender in use. Swap this one function to move to Twilio. */
export function getSmsSender(): SmsSender {
  return createEmailGatewaySmsSender();
}

/**
 * Builds and sends one review text. Pure apart from the injected sender; the
 * DB-aware recording lives in lib/review-sms-server.ts. Never throws.
 */
export async function sendReviewSms(input: {
  /** From getAssigneeSmsAddress(); null -> a recorded, visible failure. */
  address: string | null;
  /** From resolveAppBaseUrl(); null -> a recorded, visible failure. */
  baseUrl: string | null;
  /** The raw token for the link (never logged or stored by this function). */
  token: string;
  kind: ReviewSmsKind;
  count?: number;
  senderName?: string;
  sender: SmsSender;
}): Promise<SmsResult> {
  if (!input.address) return { ok: false, error: SMS_NOT_CONFIGURED_ERROR };
  if (!input.baseUrl) return { ok: false, error: BASE_URL_NOT_CONFIGURED_ERROR };
  const body = buildReviewSmsBody({
    kind: input.kind,
    url: `${input.baseUrl}/queue/${input.token}`,
    count: input.count,
    senderName: input.senderName,
  });
  try {
    return await input.sender.send(input.address, body);
  } catch {
    return { ok: false, error: GENERIC_SEND_ERROR };
  }
}
