import type { Metadata } from "next";

// Stripe Checkout's cancel page for an invoice payment. Static: it reads nothing and carries no token.

export const metadata: Metadata = {
  title: "No payment made",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function InvoicePaymentCancelledPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="max-w-sm space-y-2 text-center">
        <h1 className="text-xl font-semibold">No payment was made</h1>
        <p className="text-base text-muted-foreground">You can use the link in your e-mail to try again.</p>
      </div>
    </main>
  );
}
