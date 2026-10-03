"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { archiveDonation } from "@/actions/donations";
import { getTaxDocumentSignedUrl } from "@/actions/tax-planning";
import { DonationForm } from "@/components/donations/donation-form";
import { DONATION_KIND_LABELS, DONATION_SUBSTANTIATION_LABELS, type DonationKind, type DonationSubstantiation } from "@/lib/donations";
import { formatCentsDisplay } from "@/lib/tax-extraction-schema";
import type { DocumentOption, DonationRowView } from "@/lib/donations-build";

const FLAG_CLASS: Record<string, string> = {
  action: "bg-amber-100 text-amber-900",
  cpa: "bg-purple-100 text-purple-900",
  info: "bg-blue-100 text-blue-900",
};

/** "125050" cents -> "1250.50" for the edit form (integer split, no float). */
function centsToDollarString(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function DonationTable({
  rows,
  year,
  personalEntityId,
  documents,
}: {
  rows: DonationRowView[];
  year: number;
  personalEntityId: string | null;
  documents: DocumentOption[];
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function archive(id: string, recipient: string) {
    if (!window.confirm(`Archive the gift to ${recipient}? It is kept for the record but no longer counted.`)) return;
    setError(null);
    startTransition(async () => {
      const res = await archiveDonation(id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  async function openReceipt(documentId: string) {
    setError(null);
    try {
      const url = await getTaxDocumentSignedUrl(documentId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setError("Could not open the receipt.");
    }
  }

  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-muted-foreground">No donations logged for {year}.</p>;
  }

  return (
    <div>
      {error && <p className="px-4 pt-2 text-xs text-destructive">{error}</p>}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="px-4 py-2 font-medium">Date</th>
            <th className="px-4 py-2 font-medium">Recipient</th>
            <th className="px-4 py-2 font-medium">Kind</th>
            <th className="px-4 py-2 text-right font-medium">Amount</th>
            <th className="px-4 py-2 font-medium">Record</th>
            <th className="px-4 py-2 font-medium">Flags</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) =>
            editingId === r.id ? (
              <tr key={r.id} className="border-b last:border-0">
                <td colSpan={7} className="px-4 py-3">
                  <DonationForm
                    defaultDate={r.dateIso}
                    year={year}
                    personalEntityId={personalEntityId}
                    documents={documents}
                    initial={{
                      id: r.id,
                      dateIso: r.dateIso,
                      recipient: r.recipient,
                      amount: centsToDollarString(r.amountCents),
                      kind: r.kind as DonationKind,
                      substantiation: r.substantiation as DonationSubstantiation,
                      receiptDocumentId: r.receiptDocumentId,
                      notes: r.notes ?? "",
                    }}
                    onDone={() => setEditingId(null)}
                    onCancel={() => setEditingId(null)}
                  />
                </td>
              </tr>
            ) : (
              <tr key={r.id} className="border-b last:border-0 align-top hover:bg-muted/30">
                <td className="px-4 py-2 tabular-nums">{r.dateLabel}</td>
                <td className="px-4 py-2">
                  {r.recipient}
                  {r.notes && <span className="ml-1.5 block text-xs text-muted-foreground">{r.notes}</span>}
                </td>
                <td className="px-4 py-2 text-xs">{DONATION_KIND_LABELS[r.kind as DonationKind] ?? r.kind}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{formatCentsDisplay(r.amountCents)}</td>
                <td className="px-4 py-2 text-xs">
                  {DONATION_SUBSTANTIATION_LABELS[r.substantiation as DonationSubstantiation] ?? r.substantiation}
                  {r.receiptDocumentId && (
                    <button
                      type="button"
                      onClick={() => openReceipt(r.receiptDocumentId as string)}
                      className="ml-2 text-primary hover:underline"
                    >
                      {r.receiptName ?? "View receipt"}
                    </button>
                  )}
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-col gap-1">
                    {r.flags.map((f) => (
                      <span key={f.code} className={`rounded px-1.5 py-0.5 text-[11px] ${FLAG_CLASS[f.level] ?? ""}`}>
                        {f.message}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2 text-right text-xs">
                  <button type="button" onClick={() => setEditingId(r.id)} className="text-primary hover:underline">
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => archive(r.id, r.recipient)}
                    disabled={isPending}
                    className="ml-3 text-destructive hover:underline disabled:opacity-50"
                  >
                    Archive
                  </button>
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>
    </div>
  );
}
