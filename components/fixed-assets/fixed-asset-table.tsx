"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { archiveFixedAsset } from "@/actions/fixed-assets";
import { getTaxDocumentSignedUrl } from "@/actions/tax-planning";
import { FixedAssetForm } from "@/components/fixed-assets/fixed-asset-form";
import { formatCentsDisplay } from "@/lib/tax-extraction-schema";
import type { DocumentOption } from "@/lib/donations-build";
import type { FixedAssetRowView } from "@/lib/fixed-assets-build";

/** 125050 cents -> "1250.50" for the edit form (integer split, no float). */
function centsToDollarString(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function FixedAssetTable({
  rows,
  year,
  entityId,
  entityLabel,
  defaultRealProperty,
  documents,
}: {
  rows: FixedAssetRowView[];
  year: number;
  entityId: string;
  entityLabel: string;
  defaultRealProperty: boolean;
  documents: DocumentOption[];
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function archive(id: string, description: string) {
    if (!window.confirm(`Archive "${description}"? It is kept for the record but no longer counted.`)) return;
    setError(null);
    startTransition(async () => {
      const res = await archiveFixedAsset(id);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  async function openInvoice(documentId: string) {
    setError(null);
    try {
      const url = await getTaxDocumentSignedUrl(documentId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setError("Could not open the invoice.");
    }
  }

  if (rows.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-muted-foreground">No assets recorded for {entityLabel}.</p>;
  }

  return (
    <div>
      {error && <p className="px-4 pt-2 text-xs text-destructive">{error}</p>}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="px-4 py-2 font-medium">Description</th>
            <th className="px-4 py-2 font-medium">Placed in service</th>
            <th className="px-4 py-2 text-right font-medium">Cost</th>
            <th className="px-4 py-2 text-right font-medium">Land value</th>
            <th className="px-4 py-2 text-right font-medium">Business use</th>
            <th className="px-4 py-2 font-medium">Invoice</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) =>
            editingId === r.id ? (
              <tr key={r.id} className="border-b last:border-0">
                <td colSpan={7} className="px-4 py-3">
                  <FixedAssetForm
                    entityId={entityId}
                    entityLabel={entityLabel}
                    year={year}
                    defaultRealProperty={defaultRealProperty}
                    documents={documents}
                    initial={{
                      id: r.id,
                      description: r.description,
                      placedInServiceIso: r.placedInServiceIso,
                      costBasis: centsToDollarString(r.costBasisCents),
                      isRealProperty: r.isRealProperty,
                      landValue: r.landValueCents === null ? "" : centsToDollarString(r.landValueCents),
                      businessUsePercent: r.businessUsePercent,
                      invoiceDocumentId: r.invoiceDocumentId,
                      notes: r.notes ?? "",
                    }}
                    onDone={() => setEditingId(null)}
                    onCancel={() => setEditingId(null)}
                  />
                </td>
              </tr>
            ) : (
              <tr
                key={r.id}
                className={`border-b last:border-0 align-top hover:bg-muted/30 ${r.afterViewedYear ? "text-muted-foreground" : ""}`}
              >
                <td className="px-4 py-2">
                  {r.description}
                  {r.isRealProperty && (
                    <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[11px]">Real property</span>
                  )}
                  {r.notes && <span className="block text-xs text-muted-foreground">{r.notes}</span>}
                </td>
                <td className="px-4 py-2 tabular-nums">
                  {r.placedInServiceLabel}
                  {r.afterViewedYear && <span className="block text-[11px] italic">after {year}</span>}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{formatCentsDisplay(r.costBasisCents)}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">
                  {r.landValueCents === null ? "—" : formatCentsDisplay(r.landValueCents)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{r.businessUsePercent}%</td>
                <td className="px-4 py-2 text-xs">
                  {r.invoiceDocumentId ? (
                    <button
                      type="button"
                      onClick={() => openInvoice(r.invoiceDocumentId as string)}
                      className="text-primary hover:underline"
                    >
                      {r.invoiceName ?? "View invoice"}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2 text-right text-xs">
                  <button type="button" onClick={() => setEditingId(r.id)} className="text-primary hover:underline">
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => archive(r.id, r.description)}
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
