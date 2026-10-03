"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createDonation, updateDonation } from "@/actions/donations";
import { uploadTaxFile } from "@/components/tax/tax-document-upload";
import {
  DONATION_KINDS,
  DONATION_KIND_LABELS,
  DONATION_SUBSTANTIATION,
  DONATION_SUBSTANTIATION_LABELS,
  type DonationKind,
  type DonationSubstantiation,
} from "@/lib/donations";
import { flagsForDonation } from "@/lib/donation-substantiation";
import { parseDollarsToCents } from "@/lib/money-input";
import type { DocumentOption } from "@/lib/donations-build";

// One form for adding AND editing a charitable gift. Amounts are plain text and
// are parsed to cents on the server (and, for the advisory flags below, with the
// pure lib/money-input parser) - never with Number()/parseFloat on the client.
// The substantiation flags are advisory only: they never block saving and never
// state a deduction.

const INPUT =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50";
const LABEL = "text-xs font-medium text-muted-foreground";

export interface DonationFormInitial {
  id: string;
  dateIso: string;
  recipient: string;
  amount: string; // dollars string, e.g. "1250.50"
  kind: DonationKind;
  substantiation: DonationSubstantiation;
  receiptDocumentId: string | null;
  notes: string;
}

interface DonationFormProps {
  /** Default date for a new gift (YYYY-MM-DD), inside the viewed tax year. */
  defaultDate: string;
  year: number;
  /** Personal entity id - needed only for the optional receipt upload. */
  personalEntityId: string | null;
  documents: DocumentOption[];
  initial?: DonationFormInitial;
  /** Quick-add dialog: no receipt picker/upload (that lives on the full page). */
  hideReceipt?: boolean;
  onDone?: () => void;
  onCancel?: () => void;
}

export function DonationForm({
  defaultDate,
  year,
  personalEntityId,
  documents,
  initial,
  hideReceipt = false,
  onDone,
  onCancel,
}: DonationFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const [date, setDate] = useState(initial?.dateIso ?? defaultDate);
  const [recipient, setRecipient] = useState(initial?.recipient ?? "");
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [kind, setKind] = useState<DonationKind>(initial?.kind ?? "cash");
  const [substantiation, setSubstantiation] = useState<DonationSubstantiation>(initial?.substantiation ?? "none");
  const [receiptDocumentId, setReceiptDocumentId] = useState<string>(initial?.receiptDocumentId ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [docOptions, setDocOptions] = useState<DocumentOption[]>(documents);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const parsedAmount = parseDollarsToCents(amount);
  const liveFlags = parsedAmount.ok
    ? flagsForDonation({
        amountCents: parsedAmount.cents,
        kind,
        substantiation,
        receiptDocumentId: receiptDocumentId || null,
      })
    : [];

  async function uploadReceipt() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a receipt file first.");
      return;
    }
    if (!personalEntityId) {
      setError("The Personal entity was not found.");
      return;
    }
    setUploading(true);
    setError(null);
    setMessage(null);
    // docType "other" is never AI-extracted: no API cost, no extraction side effects.
    const result = await uploadTaxFile(file, personalEntityId, year, "other", undefined);
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
    setReceiptDocumentId(result.documentId);
    setMessage(`Uploaded ${result.fileName} and selected it.`);
    if (fileRef.current) fileRef.current.value = "";
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const payload = {
        date,
        recipient,
        amount,
        kind,
        substantiation,
        receiptDocumentId: receiptDocumentId === "" ? null : receiptDocumentId,
        notes: notes.trim() === "" ? null : notes,
      };
      const result = initial ? await updateDonation(initial.id, payload) : await createDonation(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!initial) {
        setRecipient("");
        setAmount("");
        setNotes("");
        setReceiptDocumentId("");
        setSubstantiation("none");
      }
      router.refresh();
      onDone?.();
    });
  }

  const busy = isPending || uploading;
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={LABEL}>Date of gift</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required disabled={busy} className={INPUT} />
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Amount (dollars; for non-cash, the fair market value you state)</label>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="250.00"
            required
            disabled={busy}
            className={`${INPUT} font-mono`}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className={LABEL}>Recipient / organization</label>
        <input
          type="text"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="Connecticut Food Bank"
          required
          maxLength={200}
          disabled={busy}
          className={INPUT}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className={LABEL}>Kind</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as DonationKind)} disabled={busy} className={INPUT}>
            {DONATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {DONATION_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Record you have</label>
          <select
            value={substantiation}
            onChange={(e) => setSubstantiation(e.target.value as DonationSubstantiation)}
            disabled={busy}
            className={INPUT}
          >
            {DONATION_SUBSTANTIATION.map((s) => (
              <option key={s} value={s}>
                {DONATION_SUBSTANTIATION_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {liveFlags.length > 0 && (
        <ul className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          {liveFlags.map((f) => (
            <li key={f.code}>{f.message}</li>
          ))}
        </ul>
      )}

      {hideReceipt ? (
        <p className="text-[11px] text-muted-foreground">
          To attach the receipt or acknowledgment, edit this gift on the full donation log page after saving.
        </p>
      ) : (
        <div className="space-y-2 rounded-md border p-2">
          <div className="space-y-1">
            <label className={LABEL}>Receipt / acknowledgment (optional)</label>
            <select
              value={receiptDocumentId}
              onChange={(e) => setReceiptDocumentId(e.target.value)}
              disabled={busy}
              className={INPUT}
            >
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
              onClick={uploadReceipt}
              disabled={busy}
              className="rounded-md border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {uploading ? "Uploading…" : "Upload a receipt"}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Uploaded files are filed under Personal for {year} and are not read by the AI.
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
          {isPending ? "Saving…" : initial ? "Save changes" : "Add donation"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy} className="text-xs text-muted-foreground hover:text-foreground">
            Cancel
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Log one entry per gift. Drafts for your CPA - not tax advice; whether a gift is deductible is your CPA&apos;s call.
      </p>
    </form>
  );
}
