import Link from "next/link";
import {
  PRIVACY_SMS_FREQUENCY,
  PRIVACY_SMS_NO_SHARING,
  PRIVACY_SMS_OPTIONAL,
  PRIVACY_SMS_RATES,
  SMS_CONSENT_TEXT,
} from "@/lib/sms-consent-text";

// Public Terms and Conditions (in middleware PUBLIC_PATHS), including the SMS program terms that Twilio toll-free
// verification asks for. The SMS sentences reuse the constants the privacy page and the consent card use, so the three
// never drift apart.

export const metadata = {
  title: "Terms and Conditions — Banana Stand",
};

const TERMS_EFFECTIVE_DATE = "November 16, 2026";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8">
          <Link
            href="/login"
            className="text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            ← Back
          </Link>
        </div>

        <h1 className="text-2xl font-bold tracking-tight mb-2">Terms and Conditions</h1>
        <p className="text-sm text-muted-foreground mb-8">
          Effective date: {TERMS_EFFECTIVE_DATE} &nbsp;·&nbsp; Last updated: {TERMS_EFFECTIVE_DATE}
        </p>

        <div className="prose prose-sm max-w-none space-y-8 text-sm leading-relaxed text-foreground">
          <section className="space-y-3">
            <h2 className="text-base font-semibold">1. About Banana Stand</h2>
            <p>
              Banana Stand (<strong>ericandeva.com</strong>) is a private bookkeeping and personal finance
              application operated by Eric Kinniburgh Consulting, LLC. Access is limited to invited account
              holders. By signing in you agree to these terms and to the{" "}
              <Link href="/privacy" className="underline hover:text-muted-foreground">
                Privacy Policy
              </Link>
              .
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">2. Use of the Application</h2>
            <p>
              Keep your password and multi-factor authentication device secure and do not share your account.
              Information in the application, including forecasts and summaries, is provided for your own
              record-keeping and is not financial, investment, legal or tax advice.
            </p>
          </section>

          <section id="sms" className="space-y-3">
            <h2 className="text-base font-semibold">3. Text Message (SMS) Program</h2>
            <p>
              <strong>Program name:</strong> Banana Stand review notifications.
            </p>
            <p>
              <strong>What you receive:</strong> text messages about transactions assigned to you for review,
              each with a link to the review page, and a reminder when an assigned review is still waiting.
              Messages are informational only; there is no marketing.
            </p>
            <p>
              <strong>How you opt in:</strong> on the Settings &gt; Notifications page, by entering your own
              mobile number and ticking the box that reads: &ldquo;{SMS_CONSENT_TEXT}&rdquo;
            </p>
            <p>{PRIVACY_SMS_OPTIONAL}</p>
            <p>{PRIVACY_SMS_FREQUENCY}</p>
            <p>{PRIVACY_SMS_RATES}</p>
            <p>
              <strong>To opt out:</strong> reply <strong>STOP</strong> to any message. You will receive one
              confirmation and no further messages. You can also turn texts off on the Settings &gt;
              Notifications page.
            </p>
            <p>
              <strong>For help:</strong> reply <strong>HELP</strong> to any message, or e-mail{" "}
              <a href="mailto:ekinniburgh@gmail.com" className="underline hover:text-muted-foreground">
                ekinniburgh@gmail.com
              </a>
              .
            </p>
            <p>Carriers are not liable for delayed or undelivered messages.</p>
            <p>
              {PRIVACY_SMS_NO_SHARING} See the{" "}
              <Link href="/privacy#text-messages" className="underline hover:text-muted-foreground">
                Privacy Policy
              </Link>{" "}
              for how your number is handled.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">4. Changes to These Terms</h2>
            <p>
              We may update these terms from time to time. The effective date at the top of this page shows
              the most recent revision.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">5. Contact</h2>
            <p>
              Eric Kinniburgh Consulting, LLC
              <br />
              <a href="mailto:ekinniburgh@gmail.com" className="underline hover:text-muted-foreground">
                ekinniburgh@gmail.com
              </a>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
