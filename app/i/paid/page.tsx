import type { Metadata } from "next";

// Stripe Checkout's success page for an invoice payment. Static: it reads nothing, carries no token and claims nothing beyond "received,
// will be confirmed" (the payment is recorded only when the signed webhook arrives).

export const metadata: Metadata = {
  title: "Payment received",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default function InvoicePaidPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="max-w-sm space-y-2 text-center">
        <h1 className="text-xl font-semibold">Thank you</h1>
        <p className="text-base text-muted-foreground">Your payment was received and will be confirmed shortly. Bank (ACH) payments can take a few business days.</p>
      </div>
    </main>
  );
}
