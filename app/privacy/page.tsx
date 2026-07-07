import Link from "next/link";

export const metadata = {
  title: "Privacy Policy — Banana Stand",
};

export default function PrivacyPage() {
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

        <h1 className="text-2xl font-bold tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-8">
          Effective date: July 7, 2026 &nbsp;·&nbsp; Last updated: July 7, 2026
        </p>

        <div className="prose prose-sm max-w-none space-y-8 text-sm leading-relaxed text-foreground">

          <section className="space-y-3">
            <h2 className="text-base font-semibold">1. About This Application</h2>
            <p>
              Banana Stand (<strong>ericandeva.com</strong>) is a private personal financial
              management application operated by Eric Kinniburgh. Access is restricted to two
              named individuals — the account holders — and is not open to the general public.
              This policy describes how we collect, use, store, and protect information within
              the application.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">2. Information We Collect</h2>
            <p>We collect the following categories of information:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>Account information:</strong> Email address, hashed password, and
                multi-factor authentication credentials used to access the application.
              </li>
              <li>
                <strong>Financial account data:</strong> Bank account names, account numbers
                (last four digits), balances, and transaction history retrieved via Plaid from
                linked financial institutions.
              </li>
              <li>
                <strong>Transaction data:</strong> Payee names, amounts, dates, and
                user-assigned categories and tags for personal financial tracking.
              </li>
              <li>
                <strong>Uploaded documents:</strong> Receipt images and financial documents
                uploaded voluntarily for record-keeping purposes.
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">3. How We Use Your Information</h2>
            <p>
              All information collected is used exclusively to provide personal financial
              management functionality to the account holders. We do not sell, rent, share, or
              disclose personal or financial information to any third party for marketing,
              advertising, or commercial purposes.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">4. Plaid</h2>
            <p>
              We use Plaid Technologies, Inc. to connect to financial institutions. When you
              link a bank account, Plaid authenticates directly with your institution and
              provides us with read-only access to account and transaction data. We do not
              receive or store your bank login credentials. Plaid&apos;s use of your information is
              governed by the{" "}
              <a
                href="https://plaid.com/legal/end-user-privacy-policy"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-muted-foreground"
              >
                Plaid End User Privacy Policy
              </a>
              .
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">5. Data Storage and Security</h2>
            <p>
              Data is stored in a private PostgreSQL database hosted on Supabase (SOC 2 Type II
              certified). The application is hosted on Vercel (SOC 2 Type II certified).
            </p>
            <p>
              Plaid access tokens and other sensitive credentials are encrypted at rest using
              AES-256-GCM. All data is transmitted over TLS 1.2 or higher. Access to the
              application requires a password and mandatory multi-factor authentication.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">6. Data Retention</h2>
            <p>
              Financial data is retained for as long as an account is active. If you request
              account deletion, all personal and financial data associated with your account
              will be permanently removed within 30 days.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">7. Your Rights</h2>
            <p>You may request at any time to:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Access the personal and financial data stored about you.</li>
              <li>Correct inaccurate data.</li>
              <li>Delete your account and all associated data.</li>
              <li>Disconnect any linked financial institution.</li>
            </ul>
            <p>
              To exercise any of these rights, contact us at the address below.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">8. Changes to This Policy</h2>
            <p>
              We may update this policy from time to time. The effective date at the top of
              this page will reflect the most recent revision. Continued use of the application
              following any update constitutes acceptance of the revised policy.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold">9. Contact</h2>
            <p>
              Questions about this policy may be directed to:
              <br />
              <strong>Eric Kinniburgh</strong>
              <br />
              <a
                href="mailto:ekinniburgh@gmail.com"
                className="underline hover:text-muted-foreground"
              >
                ekinniburgh@gmail.com
              </a>
            </p>
          </section>

        </div>
      </div>
    </div>
  );
}
