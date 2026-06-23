import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}) {
  const { error } = await resend.emails.send({
    from: "WISKIN Books <onboarding@resend.dev>",
    to,
    subject,
    html,
  });
  if (error) throw new Error(`Email failed: ${error.message}`);
}
