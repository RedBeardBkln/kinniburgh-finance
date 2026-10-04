"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createFixedAsset, updateFixedAsset } from "@/actions/fixed-assets";
import { uploadTaxFile } from "@/components/tax/tax-document-upload";
import type { DocumentOption } from "@/lib/donations-build";

// One form for adding AND editing a fixed asset. It RECORDS inputs for the return:
// it never computes depreciation, picks a class, or decides Section 179 / bonus,
// and never shows a building basis. Dollar fields are plain text parsed to cents
// on the server - never Number()/parseFloat on the client.

const INPUT =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50";
const LABEL = "text-xs font-medium text-muted-foreground";

export interface FixedAssetFormInitial {
  id: string;
  description: string;
  placedInServiceIso: string;
  costBasis: string; // dollars string
  isRealProperty: boolean;
  landValue: string; // dollars string, "" when none
  businessUsePercent: number;
  invoiceDocumentId: string | null;
  notes: string;
}

interface FixedAssetFormProps {
  entityId: string;
  entityLabel: string;
  year: number;
  /** Pre-check "building / real property" (Sudden Valley). */
  defaultRealProperty: boolean;
  documents: DocumentOption[];
  initial?: FixedAssetFormInitial;
  /** Quick-add dialog: no invoice picker/upload (that lives on the full page). */
  hideInvoice?: boolean;
  onDone?: () => void;
  onCancel?: () => void;
}

export function FixedAssetForm({
  entityId,
  entityLabel,
  year,
  defaultRealProperty,
  documents,
  initial,
  hideInvoice = false,
  onDone,
  onCancel,
}: FixedAssetFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const [description, setDescription] = useState(initial?.description ?? "");
  const [placed, setPlaced] = useState(initial?.placedInServiceIso ?? "");
  const [costBasis, setCostBasis] = useState(initial?.costBasis ?? "");
  const [isRealProperty, setIsRealProperty] = useState(initial?.isRealProperty ?? defaultRealProperty);
  const [landValue, setLandValue] = useState(initial?.landValue ?? "");
  const [usePercent, setUsePercent] = useState(String(initial?.businessUsePercent ?? 100));
  const [invoiceId, setInvoiceId] = useState<string>(initial?.invoiceDocumentId ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [docOptions, setDocOptions] = useState<DocumentOption[]>(documents);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function uploadInvoice() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose an invoice file first.");
      return;
    }
    setUploading(true);
    setError(null);
    setMessage(null);
    // docType "other" is never AI-extracted: no API cost, no extraction side effects.
    const result = await uploadTaxFile(file, entityId, year, "other", undefined);
    setUploading(false);
    if (!result.success) {
      setError(result.error ?? "Upload failed");
      return;
    }
    if (!result.documentId) {
      setError("Upload finished but no document id was returned.");
      return;
    }
    const label = result.documentName ?? result.fileName;
    setDocOptions((prev) => [{ id: result.documentId as string, label }, ...prev]);
    setInvoiceId(result.documentId);
    setMessage(`Uploaded ${result.fileName} and selected it.`);
    if (fileRef.current) fileRef.current.value = "";
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const payload = {
        description,
        placedInServiceDate: placed,
        costBasis,
        isRealProperty,
        landValue: isRealProperty ? landValue : null,
        // A percent, not money. Non-numeric text becomes NaN and is rejected by the server.
        businessUsePercent: /^\d+$/.test(usePercent.trim()) ? Number.parseInt(usePercent.trim(), 10) : Number.NaN,
        invoiceDocumentId: invoiceId === "" ? null : invoiceId,
        notes: notes.trim() === "" ? null : notes,
      };
      const result = initial
        ? await updateFixedAsset(initial.id, payload)
        : await createFixedAsset({ ...payload, entityId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!initial) {
        setDescription("");
        setPlaced("");
        setCostBasis("");
        setLandValue("");
        setUsePercent("100");
        setInvoiceId("");
        setNotes("");
      }
      router.refresh();
      onDone?.();
    });
  }

  const busy = isPending || uploading;
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1">
        <label className={LABEL}>Description ({entityLabel})</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={isRealProperty ? "56 Arbor Rd building" : "MacBook Pro"}
          required
          maxLength={200}
          disabled={busy}
          className={INPUT}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={LABEL}>Placed in service (date)</label>
          <input type="date" value={placed} onChange={(e) => setPlaced(e.target.value)} required disabled={busy} className={INPUT} />
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Cost basis (dollars, as you paid)</label>
          <input
            type="text"
            inputMode="decimal"
            value={costBasis}
            onChange={(e) => setCostBasis(e.target.value)}
            placeholder="2400.00"
            required
            disabled={busy}
            className={`${INPUT} font-mono`}
          />
        </div>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isRealProperty}
          onChange={(e) => setIsRealProperty(e.target.checked)}
          disabled={busy}
          className="h-4 w-4 rounded border-input"
        />
        This is a building / real property
      </label>

      {isRealProperty && (
        <div className="space-y-1">
          <label className={LABEL}>Land value (dollars - the part of the cost that is land)</label>
          <input
            type="text"
            inputMode="decimal"
            value={landValue}
            onChange={(e) => setLandValue(e.target.value)}
            placeholder="60000.00"
            required
            disabled={busy}
            className={`${INPUT} font-mono`}
          />
          <p className="text-[11px] text-muted-foreground">
            Enter 0 only if the whole cost is building or improvement.
          </p>
        </div>
      )}

      <div className="space-y-1">
        <label className={LABEL}>Business use (whole percent, 1-100)</label>
        <input
          type="text"
          inputMode="numeric"
          value={usePercent}
          onChange={(e) => setUsePercent(e.target.value)}
          required
          disabled={busy}
          className={`${INPUT} sm:w-32`}
        />
        <p className="text-[11px] text-muted-foreground">Whole numbers only - a fractional percent (like 37.5) cannot be recorded here.</p>
      </div>

      {hideInvoice ? (
        <p className="text-[11px] text-muted-foreground">
          To attach the purchase invoice, edit this asset on the full fixed-asset page after saving.
        </p>
      ) : (
        <div className="space-y-2 rounded-md border p-2">
          <div className="space-y-1">
            <label className={LABEL}>Purchase invoice / closing statement (optional)</label>
            <select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} disabled={busy} className={INPUT}>
              <option value="">None attached</option>
              {docOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              disabled={busy}
              className="text-xs"
            />
            <button
              type="button"
              onClick={uploadInvoice}
              disabled={busy}
              className="rounded-md border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "Upload an invoice"}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Uploaded files are filed under {entityLabel} for {year} and are not read by the AI.
          </p>
        </div>
      )}

      <div className="space-y-1">
        <label className={LABEL}>Notes (optional)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={2000}
          disabled={busy}
          className={INPUT}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      {message && <p className="text-xs text-green-700">{message}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {isPending ? "Saving…" : initial ? "Save changes" : "Add asset"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy} className="text-xs text-muted-foreground hover:text-foreground">
            Cancel
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Recorded inputs only - you review each entry. This app does not calculate depreciation, choose a MACRS class,
        or decide Section 179 / bonus depreciation.
      </p>
    </form>
  );
}
