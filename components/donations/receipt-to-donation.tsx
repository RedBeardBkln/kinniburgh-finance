"use client";

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { DonationForm, type DonationFormPrefill } from "@/components/donations/donation-form";
import type { ReceiptFlag, ReceiptGiftView } from "@/lib/donation-receipt";
import { formatCentsDisplay } from "@/lib/tax-extraction-schema";

// "Add to donation log" panel on a donation receipt's review screen. It shows
// what the receipt says (the EFFECTIVE values: the owner's saved corrections win),
// the advisory flags, any gift already logged from this letter, and an
// owner-clicked prefilled form. Nothing is ever saved automatically: the only
// call that creates a gift is the form's own submit button. No deductible or
// reduced amount is computed here.

const FLAG_CLASS: Record<string, string> = {
  action: "bg-amber-100 text-amber-900",
  cpa: "bg-purple-100 text-purple-900",
  info: "bg-slate-100 text-slate-700",
};

export function ReceiptFlagList({ flags }: { flags: ReceiptFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <ul className="space-y-1">
      {flags.map((f) => (
        <li key={f.code} className={`rounded px-2 py-1 text-xs ${FLAG_CLASS[f.level] ?? ""}`}>
          {f.message}
        </li>
      ))}
    </ul>
  );
}

interface ReceiptToDonationProps {
  view: ReceiptGiftView;
  personalEntityId: string | null;
  /** Name of the bucket the document is filed under (shown when it is not Personal). */
  entityLabel: string;
}

export function ReceiptToDonation({ view, personalEntityId, entityLabel }: ReceiptToDonationProps) {
  const [open, setOpen] = useState(false);
  const [another, setAnother] = useState(false);

  if (view.state === "not_personal") {
    return (
      <p className="text-sm text-muted-foreground">
        The donation log is for the Personal bucket; this receipt is filed under {entityLabel}.
      </p>
    );
  }
  if (view.state === "not_extracted") {
    return (
      <p className="text-sm text-muted-foreground">
        This receipt has no usable AI reading yet, so there is nothing to prefill. Run the extraction first.
      </p>
    );
  }
  if (view.state === "withheld_by_policy") {
    return (
      <p className="text-sm text-muted-foreground">
        The values are withheld until you verify this receipt (the app is set to use verified readings only). Confirm it
        above, then come back here.
      </p>
    );
  }

  const hasLinked = view.linkedGifts.length > 0;
  const year = view.docTaxYear ?? new Date().getUTCFullYear();
  const prefill: DonationFormPrefill = {
    ...view.prefill,
    receiptDocumentId: view.documentId,
    receiptLabel: view.name,
    initialConfirmShared: another,
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Uses the saved values above (your corrections win). Save corrections first if you changed something.{" "}
        {view.verified ? (
          <span className="font-medium text-green-700">Basis: verified by you.</span>
        ) : (
          <span className="font-medium text-amber-700">
            Basis: AI reading - not verified yet; check each value against the document.
          </span>
        )}
      </p>
      {view.summary !== "" && <p className="text-sm">{view.summary}</p>}
      <ReceiptFlagList flags={view.flags} />

      {hasLinked && (
        <div className="space-y-1 rounded-md border p-2 text-xs">
          <p className="font-medium">Already logged from this receipt</p>
          <ul className="space-y-0.5">
            {view.linkedGifts.map((g) => (
              <li key={g.id}>
                {g.dateLabel} - {g.recipient} - {formatCentsDisplay(g.amountCents)}{" "}
                <Link href={`/tax/donations/${g.year}` as Route} className="text-primary hover:underline">
                  Open the {g.year} donation log
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {open ? (
        <div className="rounded-md border p-3">
          <DonationForm
            // Remount when switching between "add" and "add another".
            key={another ? "another" : "first"}
            defaultDate={`${year}-12-31`}
            year={year}
            personalEntityId={personalEntityId}
            documents={[]}
            prefill={prefill}
            onDone={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setAnother(hasLinked);
            setOpen(true);
          }}
          className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          {hasLinked ? "Add another gift from this letter" : "Add to donation log"}
        </button>
      )}
      <p className="text-[11px] text-muted-foreground">
        Nothing is saved until you press the save button in the form. Drafts for you to review - not tax advice.
      </p>
    </div>
  );
}
