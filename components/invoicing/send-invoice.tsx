"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MODAL_OVERLAY, modalPanelClass } from "@/components/ui/modal-frame";
import { cn } from "@/lib/utils";
import { sendInvoice } from "@/actions/invoices";
import { ErrorLine, OkLine, useRunner } from "@/components/invoicing/shared";
import { newRequestKey } from "@/lib/invoicing/request-key";

// "Send invoice" / "Resend invoice" on an issued invoice (owner only; the action is owner-only on the server as well). Nothing is
// e-mailed until the owner confirms in this dialog. Recipients are the client's contacts ticked "Receives invoices"; the list and the
// "e-mail is set up" flag are decided on the server and passed in as plain values.

export function SendInvoiceButton({
  slug,
  documentId,
  displayNumber,
  sendCount,
  lastSentText,
  recipients,
  emailReady,
  payLinkNote = null,
}: {
  slug: string;
  documentId: string;
  displayNumber: string;
  sendCount: number;
  lastSentText: string | null;
  recipients: string[];
  emailReady: boolean;
  /** Phase 2: a plain sentence about the pay link this send will (or will not) carry, decided on the server; null = none. */
  payLinkNote?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [requestKey, setRequestKey] = useState("");
  const { pending, error, ok, run, setError, setOk } = useRunner();
  const resend = sendCount > 0;
  const label = resend ? "Resend invoice" : "Send invoice";
  const blocked = !emailReady ? "E-mail is not set up yet (INVOICE_EMAIL_FROM is not set in Vercel, or is not an address on the verified domain)." : recipients.length === 0 ? "No contact of this client is ticked \"Receives invoices\"." : null;

  return (
    <div className="space-y-1">
      <Button
        size="sm"
        onClick={() => {
          setError(null);
          setRequestKey(newRequestKey());
          setOpen(true);
        }}
        disabled={pending}
      >
        {label}
      </Button>
      {lastSentText ? (
        <p className="text-xs text-muted-foreground">
          Last sent {lastSentText}
          {sendCount > 1 ? ` (sent ${sendCount} times)` : ""}
        </p>
      ) : null}
      <OkLine message={open ? null : ok} />
      {open ? (
        <div className={MODAL_OVERLAY} role="dialog" aria-modal="true" aria-label={label}>
          <div className={cn(modalPanelClass("md"), "space-y-4 bg-background p-5 shadow-lg")}>
            <h2 className="text-base font-semibold">
              {label} {displayNumber}
            </h2>
            {blocked ? (
              <p className="text-sm text-yellow-800">{blocked}</p>
            ) : (
              <div className="space-y-2 text-sm">
                <p>The invoice PDF will be e-mailed to:</p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {recipients.map((r) => (
                    <li key={r} className="break-all">
                      {r}
                    </li>
                  ))}
                </ul>
                {resend ? <p className="text-xs text-muted-foreground">It was already sent {lastSentText ? `on ${lastSentText}` : "before"}; this sends it again.</p> : null}
                {payLinkNote ? <p className="text-xs text-muted-foreground">{payLinkNote}</p> : null}
                <p className="text-xs text-muted-foreground">Recipients come from the client&apos;s contacts ticked &quot;Receives invoices&quot;.</p>
              </div>
            )}
            <ErrorLine message={error} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button
                disabled={pending || blocked !== null}
                onClick={() =>
                  run(
                    async () => {
                      const r = await sendInvoice({ slug, documentId, requestKey });
                      if ("error" in r) setRequestKey(newRequestKey()); // a retry is a new send attempt
                      return r;
                    },
                    {
                      onSuccess: (r) => {
                        setOpen(false);
                        const link = "payLink" in r ? r.payLink : "not_applicable";
                        setOk(
                          link === "included"
                            ? `Invoice ${displayNumber} was e-mailed. Included a pay link.`
                            : link === "omitted_not_configured"
                              ? `Invoice ${displayNumber} was e-mailed, without a pay link: online payments are not set up (see Invoicing settings).`
                              : `Invoice ${displayNumber} was e-mailed.`
                        );
                      },
                    }
                  )
                }
              >
                {pending ? "Sending…" : label}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
