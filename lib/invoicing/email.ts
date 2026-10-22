// The invoice e-mail (plan task 1.10). PURE: no DB, no network, no clock. The action (actions/invoices.ts#sendInvoice) reads the
// environment, renders the PDF and calls lib/resend.ts; this file only decides whether sending is configured, which addresses
// receive the invoice and what the message says.
//
// Rules kept here:
//  - an invoice is e-mailed ONLY when the owner clicks Send / Resend (or "Save as final and send"); nothing here schedules a send.
//  - invoices have their OWN sender, INVOICE_EMAIL_FROM (e.g. "LaunchTime Solutions <invoices@launchtime.solutions>"). EMAIL_FROM
//    is the app's other mail (Banana Stand: codes, review links) and is never used for an invoice, not even as a fallback.
//  - pre-flight fails closed: no API key, no INVOICE_EMAIL_FROM, a malformed one, or one on resend.dev (which can only reach the
//    account's own address) means no provider call at all.
//  - recipients are the client's contacts ticked "Receives invoices", de-duplicated case-insensitively, each a plain address.
//  - the body never carries bank / remit-to text (that is only in the PDF when the invoice ticks it); every header-bound value has
//    CR/LF removed; the HTML is escaped.

export type SendFailureCategory = "not_configured" | "no_recipients" | "provider_error";

export const SEND_FAILURE_MESSAGES: Record<SendFailureCategory, string> = {
  not_configured:
    "E-mail is not set up yet: the sending domain must be verified in Resend and INVOICE_EMAIL_FROM set in Vercel to an address on it. The invoice was not e-mailed; download the PDF to send it yourself.",
  no_recipients: "No contact of this client is ticked \"Receives invoices\". Open the client, tick it on at least one contact, then send again.",
  provider_error: "The e-mail service refused or failed to send the invoice, so it was not delivered. Try again, or download the PDF and send it yourself.",
};

export type Preflight = { ok: true; from: string } | { ok: false; category: "not_configured" };

/** The environment variable that holds the invoice sender. */
export const INVOICE_FROM_VAR = "INVOICE_EMAIL_FROM";

// "Display Name <address>" or a bare address; the display name may not contain quotes, angle brackets or control characters.
const FROM_WITH_NAME = /^([^"<>\u0000-\u001f\u007f]{1,100}?)\s*<([^<>\s]+)>$/;

/**
 * Whether the invoice e-mail can be sent with this environment, and the From to use. Reads RESEND_API_KEY and INVOICE_EMAIL_FROM
 * only (never EMAIL_FROM); the values are never shown or logged.
 */
export function emailPreflight(env: Readonly<Record<string, string | undefined>>): Preflight {
  const no = { ok: false, category: "not_configured" } as const;
  const key = (env["RESEND_API_KEY"] ?? "").trim();
  const from = (env[INVOICE_FROM_VAR] ?? "").trim();
  if (key === "" || from === "" || /[\u0000-\u001f\u007f]/.test(from)) return no;
  const m = FROM_WITH_NAME.exec(from);
  const address = m ? m[2]! : from;
  if (!isSendableAddress(address)) return no;
  if (/@resend\.dev$/i.test(address)) return no;
  return { ok: true, from: m ? `${m[1]!.trim()} <${address}>` : address };
}

// A conservative single-address check (no display names, no spaces, no CR/LF, no commas or angle brackets).
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isSendableAddress(raw: string): boolean {
  return raw.length <= 254 && ADDRESS.test(raw);
}

/** The addresses an invoice goes to: contacts ticked "Receives invoices", valid, de-duplicated (first spelling kept), in order. */
export function invoiceRecipients(contacts: readonly { email: string; receivesInvoices: boolean }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of contacts) {
    if (!c.receivesInvoices) continue;
    const email = c.email.trim();
    if (!isSendableAddress(email)) continue;
    const k = email.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(email);
  }
  return out;
}

/** Removes CR, LF and other control characters (header injection) and trims. */
export function headerSafe(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function escapeHtml(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface InvoiceEmailInput {
  displayNumber: string;
  /** The name the client knows the business by (the dba when set). */
  businessName: string;
  totalText: string;
  balanceText: string;
  /** e.g. "Due upon receipt" or "Due 2026-11-07". */
  dueText: string;
  footerText: string | null;
}

export interface InvoiceEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildInvoiceEmail(i: InvoiceEmailInput): InvoiceEmail {
  const number = headerSafe(i.displayNumber);
  const business = headerSafe(i.businessName);
  const subject = headerSafe(`Invoice ${number} from ${business}`);
  const paid = i.balanceText !== i.totalText;
  const lines = [
    "Hello,",
    "",
    `Please find attached invoice ${number} from ${business} for ${i.totalText}.`,
    paid ? `The balance due is ${i.balanceText}.` : null,
    `${headerSafe(i.dueText)}.`,
    "",
    "If you have any questions, simply reply to this e-mail.",
    "",
    headerSafe(i.footerText ?? "") || "Thank you for your business.",
    business,
  ].filter((l): l is string => l !== null);
  const text = lines.join("\n");
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#201D16">${lines
    .map((l) => (l === "" ? "" : `<p style="margin:0 0 4px">${escapeHtml(l)}</p>`))
    .join("")}</body></html>`;
  return { subject, text, html };
}
