"use client";

import { useRouter } from "next/navigation";
import type { Route } from "next";
import { Button } from "@/components/ui/button";
import { duplicateInvoice, voidInvoice } from "@/actions/invoices";
import { ErrorLine, useRunner } from "@/components/invoicing/shared";

// Buttons on an invoice: download the PDF (anyone signed in), and, for the owner only, duplicate into a new draft, void. `canEdit` is a plain
// boolean decided on the server from the owner rule; every action here is owner-only on the server as well.

export function InvoiceActions({ slug, documentId, status, canEdit, voidBlockedReason }: { slug: string; documentId: string; status: string; canEdit: boolean; voidBlockedReason: string | null }) {
  const router = useRouter();
  const { pending, error, run } = useRunner();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <a href={`/api/invoicing/${documentId}/pdf`} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center rounded-md border border-input bg-background px-3 text-xs font-medium hover:bg-accent">
          Download PDF
        </a>
        {canEdit ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(() => duplicateInvoice({ slug, documentId }), {
                refresh: false,
                onSuccess: (r) => {
                  if ("id" in r) router.push(`/business/${slug}/invoices/${r.id}` as Route);
                },
              })
            }
          >
            Duplicate as new draft
          </Button>
        ) : null}
        {status === "issued" && canEdit ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending || voidBlockedReason !== null}
            title={voidBlockedReason ?? undefined}
            onClick={() => {
              const reason = window.prompt("Why is this invoice being voided? (The number is kept and never reused.)");
              if (reason && reason.trim() !== "") run(() => voidInvoice({ slug, documentId, reason }));
            }}
          >
            Void invoice
          </Button>
        ) : null}
      </div>
      {status === "issued" && canEdit && voidBlockedReason ? <p className="text-xs text-muted-foreground">{voidBlockedReason}</p> : null}
      <ErrorLine message={error} />
    </div>
  );
}
