"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { startCheckout } from "@/actions/public-invoice";

// "Pay online" on the client's invoice page. The amount is the balance the SERVER reads when the button is clicked (the action takes the
// token only); the browser then opens Stripe's hosted Checkout page. Errors are static sentences.
export function PayOnlineButton({ token, amountText }: { token: string; amountText: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        size="lg"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            try {
              const r = await startCheckout(token);
              if (r.ok) window.location.assign(r.url);
              else setError(r.error);
            } catch {
              setError("Online payment is not available right now. Please try again later.");
            }
          });
        }}
      >
        {pending ? "Opening secure checkout…" : `Pay ${amountText} online`}
      </Button>
      <p className="text-xs text-muted-foreground">Card or US bank account (ACH), through Stripe.</p>
      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}
