import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// At least one of `html` / `text` is required. `text` was added for the
// email-to-SMS gateway (lib/sms-sender.ts), which needs a plain-text body;
// existing html-only callers are unaffected.
export async function sendEmail({
  to,
  subject,
  html,
  text,
}: {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}) {
  if (html === undefined && text === undefined) {
    throw new Error("Email failed: no body provided");
  }
  const base = {
    from: process.env.EMAIL_FROM ?? "Banana Stand <onboarding@resend.dev>",
    to,
    subject,
  };
  const { error } = await resend.emails.send(
    html !== undefined ? { ...base, html, ...(text !== undefined ? { text } : {}) } : { ...base, text: text as string }
  );
  if (error) throw new Error(`Email failed: ${error.message}`);
}
