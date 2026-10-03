"use client";

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { DonationForm, type DonationFormPrefill } from "@/components/donations/donation-form";
import { ReceiptFlagList } from "@/components/donations/receipt-to-donation";
import type { ReceiptGiftView } from "@/lib/donation-receipt";

// "Receipts waiting to be logged": Personal donation_receipt documents that have
// no gift logged yet. Never auto-creates anything: "Add to donation log" opens the
// same prefilled form the receipt's review screen uses, and the owner must press
// that form's save button.

interface UnlinkedReceiptsProps {
  receipts: ReceiptGiftView[];
  year: number;
  personalEntityId: string;
}

function stateLabel(state: ReceiptGiftView["state"], verified: boolean): string {
  if (state === "ready") return verified ? "Verified" : "AI reading - not verified yet";
  if (state === "withheld_by_policy") return "Values withheld until verified";
  return "Not read yet";
}

export function UnlinkedReceipts({ receipts, year, personalEntityId }: UnlinkedReceiptsProps) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (receipts.length === 0) return null;

  return (
    <ul className="divide-y">
      {receipts.map((r) => {
        const prefill: DonationFormPrefill = {
          ...r.prefill,
          receiptDocumentId: r.documentId,
          receiptLabel: r.name,
        };
        return (
          <li key={r.documentId} className="space-y-2 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-sm font-medium">{r.name}</p>
                <p className="text-xs text-muted-foreground">
                  {r.summary !== "" ? `${r.summary} - ` : ""}
                  {stateLabel(r.state, r.verified)}
                  {r.docTaxYear === null && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900">
                      No year on file
                    </span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <Link href={`/documents/${r.documentId}/review` as Route} className="text-primary hover:underline">
                  {r.state === "ready" ? "View" : "Review receipt"}
                </Link>
                {r.state === "ready" && openId !== r.documentId && (
                  <button
                    type="button"
                    onClick={() => setOpenId(r.documentId)}
                    className="rounded-md bg-primary px-3 py-1 font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Add to donation log
                  </button>
                )}
              </div>
            </div>
            {r.state === "ready" && <ReceiptFlagList flags={r.flags} />}
            {r.state === "ready" && openId === r.documentId && (
              <div className="rounded-md border p-3">
                <DonationForm
                  defaultDate={`${year}-12-31`}
                  year={year}
                  personalEntityId={personalEntityId}
                  documents={[]}
                  prefill={prefill}
                  onDone={() => setOpenId(null)}
                  onCancel={() => setOpenId(null)}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
