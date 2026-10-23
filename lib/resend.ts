import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// At least one of `html` / `text` is required. `text` was added for the
// email-to-SMS gateway (lib/sms-sender.ts), which needs a plain-text body;
// existing html-only callers are unaffected.
// `to` may be a list, and `from`, `replyTo`, `attachments` and `idempotencyKey` are optional additions for the invoice e-mail
// (lib/invoicing/email.ts; invoices pass their own INVOICE_EMAIL_FROM sender); the original `{ to: string, subject, html?, text? }`
// call shape is unchanged and still sends from EMAIL_FROM.
export async function sendEmail({
  to,
  subject,
  html,
  text,
  from,
  replyTo,
  attachments,
  idempotencyKey,
}: {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
  attachments?: { filename: string; content: Buffer }[];
  idempotencyKey?: string;
}) {
  if (html === undefined && text === undefined) {
    throw new Error("Email failed: no body provided");
  }
  const base = {
    from: from ?? process.env.EMAIL_FROM ?? "Banana Stand <onboarding@resend.dev>",
    to,
    subject,
    ...(replyTo !== undefined ? { replyTo } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  };
  const { error } = await resend.emails.send(
    html !== undefined ? { ...base, html, ...(text !== undefined ? { text } : {}) } : { ...base, text: text as string },
    idempotencyKey !== undefined ? { idempotencyKey } : undefined
  );
  if (error) {
    // `providerCode` / `statusCode` are Resend's short error name (e.g. "validation_error") and HTTP status: safe to log, unlike the
    // message, which can contain addresses.
    const err = new Error(`Email failed: ${error.message}`) as Error & { providerCode?: string; statusCode?: number | null };
    err.providerCode = typeof error.name === "string" && /^[a-z_]{1,60}$/.test(error.name) ? error.name : "unknown";
    err.statusCode = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null;
    throw err;
  }
}

