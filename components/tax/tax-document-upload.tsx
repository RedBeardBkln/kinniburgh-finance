"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { documentTypeLabel } from "@/lib/doc-naming";
import { MAX_BATCH_FILES, summarizeUploadBatch, type UploadBatchResult } from "@/lib/tax-doc-batch";
import { validateTaxDocumentFile } from "@/lib/tax-document-upload";
import {
  requestTaxDocumentUploadSlot,
  finalizeTaxDocumentUpload,
  updateTaxDocument,
  getTaxDocumentSignedUrl,
} from "@/actions/tax-planning";
import { archiveDocument, triggerExtraction } from "@/actions/documents";
import { runWithConcurrencyLimit } from "@/lib/concurrency";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DocumentRow {
  id: string;
  docType: string;
  documentName: string | null;
  notes: string | null;
  extractionStatus: string | null;
  createdAt: string;
}

interface Props {
  entityId: string;
  taxYear: number;
  documents: DocumentRow[];
  /** Document ids findUnparseableExtractions flagged as an unparseable/likely
   *  -mistagged extraction — defaults to [] (no behavior change for any
   *  existing caller). Drives a per-row anchor + amber highlight so
   *  TaxDraftNumbers's "Jump to this document" link resolves to a visible,
   *  distinguished row. */
  flaggedDocumentIds?: string[];
}

const DOC_TYPE_OPTIONS = [
  { value: "w2", label: "W-2 (wage statement)" },
  { value: "1099", label: "1099 (interest/dividend/contractor)" },
  { value: "k1", label: "K-1 (partnership/S-corp)" },
  { value: "mortgage_interest", label: "Form 1098 (mortgage interest)" },
  { value: "property_tax", label: "Property tax bill" },
  { value: "tax_return", label: "Prior-year tax return" },
  { value: "extension", label: "Extension confirmation" },
  { value: "bank_statement", label: "Bank/investment statement" },
  { value: "other", label: "Other document" },
];

// Batch uploads run with a bounded concurrency limit rather than fully
// serial (slow for many files) or fully unbounded parallel (risks tripping
// Supabase/Vercel per-connection throttling) — matches the bank-statement
// upload precedent's concurrency value.
const BATCH_CONCURRENCY_LIMIT = 4;

type TaxDocType =
  | "w2" | "1099" | "k1" | "extension" | "property_tax"
  | "mortgage_interest" | "tax_return" | "bank_statement" | "other";

/**
 * Runs the 3-step direct-to-storage upload flow for a single tax document:
 * request a signed upload slot → PUT the bytes straight to Supabase Storage
 * → finalize (creates the Document row, runs extraction inline for
 * extractable docTypes — in both single-file and batch mode). Returns a
 * UploadBatchResult-shaped object so summarizeUploadBatch keeps working
 * unmodified.
 */
async function uploadFile(
  file: File,
  entityId: string,
  taxYear: number,
  docType: TaxDocType,
  notes: string | undefined
): Promise<UploadBatchResult> {
  const fileName = file.name || "file";

  const precheck = validateTaxDocumentFile(file.type, file.size);
  if (!precheck.ok) {
    return { fileName, success: false, error: precheck.error };
  }

  try {
    const slot = await requestTaxDocumentUploadSlot({
      entityId,
      fileType: file.type,
      fileSize: file.size,
    });
    if (!slot.ok) throw new Error(slot.error);

    const putRes = await fetch(slot.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!putRes.ok) {
      throw new Error(`Upload to storage failed (status ${putRes.status})`);
    }

    const finalized = await finalizeTaxDocumentUpload({
      documentId: slot.documentId,
      fileKey: slot.fileKey,
      entityId,
      fileType: file.type,
      taxYear,
      docType,
      notes,
    });
    if (!finalized.ok) throw new Error(finalized.error);

    return {
      fileName,
      success: true,
      documentId: finalized.documentId,
      documentName: finalized.documentName,
      extraction: finalized.extraction,
    };
  } catch (e) {
    return { fileName, success: false, error: e instanceof Error ? e.message : "Upload failed" };
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TaxDocumentUpload({ entityId, taxYear, documents, flaggedDocumentIds = [] }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setUploadMsg(null);
    setUploadError(null);
    const formEl = e.currentTarget;
    const formData = new FormData(formEl);

    const files = formData.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) {
      setUploadError("Select at least one file.");
      return;
    }
    // Client-side only — no server-side "whole batch" entry point remains to
    // enforce this in the new per-file request-slot/finalize design (mirrors
    // the already-shipped bank-statement precedent, whose own batch cap is
    // also client-only). Imported from lib/tax-doc-batch.ts, never re-hardcoded.
    if (files.length > MAX_BATCH_FILES) {
      setUploadError(`Too many files — upload at most ${MAX_BATCH_FILES} at a time.`);
      return;
    }

    const docType = formData.get("docType") as TaxDocType;
    const notes = formData.get("notes")?.toString().trim() || undefined;

    setUploading(true);
    try {
      const results = await runWithConcurrencyLimit(
        files,
        BATCH_CONCURRENCY_LIMIT,
        (file) => uploadFile(file, entityId, taxYear, docType, notes)
      );
      setUploadMsg(summarizeUploadBatch(results));
      formEl.reset();
      startTransition(() => router.refresh());
    } catch {
      // Per-file failures (bad type, too large, extraction error) are already
      // surfaced individually via the returned batch results, not this catch —
      // this only fires for a genuinely unexpected failure (e.g. an
      // auth/network problem affecting the whole batch).
      setUploadError("Upload failed — check your files and try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          Upload {taxYear} tax documents
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          W-2s, 1099s, 1098s, property tax bills, prior-year returns. Select multiple files at once to
          upload them together. Claude parses the fields; originals are stored privately in the
          platform&apos;s tax vault. Never shared outside this system.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleUpload} className="grid gap-3 sm:grid-cols-4 items-end">
          <div className="space-y-1 sm:col-span-2">
            <label className="text-xs font-medium">Files (PDF/JPEG/PNG/WebP, max 20MB each)</label>
            <input
              name="file"
              type="file"
              multiple
              accept="application/pdf,image/jpeg,image/png,image/webp"
              required
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Document type</label>
            <select
              name="docType"
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              required
            >
              {DOC_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <input type="hidden" name="entityId" value={entityId} />
          <input type="hidden" name="taxYear" value={taxYear} />
          <button
            type="submit"
            disabled={uploading}
            className="rounded-md bg-primary px-4 py-2 h-9 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {uploading ? "Uploading & parsing…" : "Upload & Parse"}
          </button>
        </form>
        {uploadMsg && (
          <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
            {uploadMsg}
          </p>
        )}
        {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}

        {documents.length > 0 && (
          <div className="overflow-x-auto border-t pt-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 font-medium">Document</th>
                  <th className="py-2 px-3 font-medium">Type</th>
                  <th className="py-2 px-3 font-medium">Parsed</th>
                  <th className="py-2 px-3 font-medium">Uploaded</th>
                  <th className="py-2 px-3 font-medium text-right">Edit</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <DocumentRowEditable
                    key={d.id}
                    doc={d}
                    entityId={entityId}
                    taxYear={taxYear}
                    flagged={flaggedDocumentIds.includes(d.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Editable document row ─────────────────────────────────────────────────────

function DocumentRowEditable({
  doc,
  entityId,
  taxYear,
  flagged,
}: {
  doc: DocumentRow;
  entityId: string;
  taxYear: number;
  flagged: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(doc.documentName ?? documentTypeLabel(doc.docType));
  const [docType, setDocType] = useState<string>(doc.docType);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);

  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const [swapping, setSwapping] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  const swapInputRef = useRef<HTMLInputElement>(null);

  async function handleSave() {
    if (!name.trim()) {
      setError("Name can't be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    const originalDocType = doc.docType;
    const result = await updateTaxDocument({
      documentId: doc.id,
      documentName: name.trim(),
      docType: docType as "w2" | "1099" | "k1" | "extension" | "property_tax" | "mortgage_interest" | "tax_return" | "bank_statement" | "other",
    });
    setSaving(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setEditing(false);

    // Auto re-extract only when the docType actually changed — the old
    // extraction is only provably wrong in that case. A pure rename (same
    // docType) would just re-run the same prompt against unchanged data.
    if (docType !== originalDocType) {
      setExtracting(true);
      setExtractError(null);
      setStatusMsg("DocType changed — re-extracting…");
      try {
        await triggerExtraction(doc.id);
      } catch {
        setExtractError("Retyped, but re-extraction failed — try the Re-extract button.");
      } finally {
        setExtracting(false);
        setStatusMsg(null);
        router.refresh();
      }
    } else {
      router.refresh();
    }
  }

  async function handleView() {
    setViewError(null);
    setViewLoading(true);
    try {
      const url = await getTaxDocumentSignedUrl(doc.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      // Server action errors are sanitized boilerplate in production (Next.js
      // strips the real message) — never show the raw error to the user here.
      setViewError("Couldn't open this document — it may be missing from storage.");
    } finally {
      setViewLoading(false);
    }
  }

  async function handleReExtract() {
    setExtractError(null);
    setExtracting(true);
    try {
      await triggerExtraction(doc.id);
      router.refresh();
    } catch {
      setExtractError("Re-extraction failed — try again.");
    } finally {
      setExtracting(false);
    }
  }

  async function handleArchive() {
    if (!confirm(`Archive "${displayName}"? It will no longer appear in this document list.`)) {
      return;
    }
    setArchiveError(null);
    setArchiving(true);
    try {
      await archiveDocument(doc.id);
      router.refresh();
    } catch {
      setArchiveError("Archive failed — try again.");
    } finally {
      setArchiving(false);
    }
  }

  async function handleSwapFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so selecting the same file again still fires onChange.
    e.target.value = "";
    if (!file) return;

    setSwapError(null);
    setSwapping(true);
    try {
      const result = await uploadFile(
        file,
        entityId,
        taxYear,
        doc.docType as TaxDocType,
        doc.notes ?? undefined
      );
      if (!result.success) {
        // Upload failed — the old document is never touched. Nothing lost.
        setSwapError(result.error);
        return;
      }
      // Deliberate unconditional re-extraction, even though
      // finalizeTaxDocumentUpload already extracts inline for extractable
      // docTypes — see plan's swap-design justification (simplicity over
      // efficiency, avoids duplicating a private server-side gate here).
      await triggerExtraction(result.documentId);
      // Only archive the old document after the new one has fully landed —
      // a failed swap must never strand the household without either file.
      await archiveDocument(doc.id);
      router.refresh();
    } catch {
      setSwapError("Swap failed — the original document was not changed.");
    } finally {
      setSwapping(false);
    }
  }

  const typeLabel = documentTypeLabel(docType);
  const displayName = doc.documentName ?? documentTypeLabel(doc.docType);

  return (
    <tr
      id={`doc-${doc.id}`}
      className={
        flagged
          ? "border-b border-amber-200 bg-amber-50 last:border-0 dark:border-amber-900 dark:bg-amber-950/40"
          : "border-b last:border-0"
      }
    >
      <td className={`py-2 ${flagged ? "border-l-2 border-l-amber-500 pl-2" : ""}`}>
        {editing ? (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            className="w-full min-w-[180px] rounded border px-2 py-1 text-sm"
            placeholder="Document name"
            autoFocus
          />
        ) : (
          <span className="font-medium">{doc.documentName ?? documentTypeLabel(doc.docType)}</span>
        )}
        {error && <span className="block text-xs text-destructive mt-0.5">{error}</span>}
      </td>
      <td className="py-2 px-3">
        {editing ? (
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            className="rounded border bg-background px-2 py-1 text-sm"
          >
            {DOC_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">{typeLabel}</span>
        )}
        {flagged && (
          <span className="ml-1.5 rounded border border-amber-400 bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-200">
            ⚠ check type
          </span>
        )}
      </td>
      <td className="py-2 px-3 text-xs">
        {doc.extractionStatus === "complete" ? (
          <span className="text-green-600">✓ Parsed</span>
        ) : doc.extractionStatus === "failed" ? (
          <span className="text-destructive">Failed</span>
        ) : doc.extractionStatus ? (
          <span className="text-amber-600">{doc.extractionStatus}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-2 px-3 text-xs text-muted-foreground whitespace-nowrap">
        {fmtDate(doc.createdAt)}
      </td>
      <td className="py-2 px-3 text-right whitespace-nowrap">
        {editing ? (
          <span className="inline-flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-xs font-medium text-primary hover:underline disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setName(doc.documentName ?? documentTypeLabel(doc.docType));
                setDocType(doc.docType);
                setError(null);
              }}
              disabled={saving}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <button
              onClick={handleView}
              disabled={viewLoading}
              className="text-xs font-medium text-primary hover:underline disabled:opacity-60"
            >
              {viewLoading ? "Opening…" : "View"}
            </button>
            <button
              onClick={() => setEditing(true)}
              className="text-xs text-primary hover:underline"
            >
              Rename / retype
            </button>
            <button
              onClick={handleReExtract}
              disabled={extracting}
              className="text-xs text-primary hover:underline disabled:opacity-60"
            >
              {extracting ? "Re-extracting…" : "Re-extract"}
            </button>
            <input
              ref={swapInputRef}
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handleSwapFileChange}
            />
            <button
              onClick={() => swapInputRef.current?.click()}
              disabled={swapping}
              className="text-xs text-primary hover:underline disabled:opacity-60"
            >
              {swapping ? "Swapping…" : "Swap file"}
            </button>
            <button
              onClick={handleArchive}
              disabled={archiving}
              className="text-xs font-medium text-destructive hover:underline disabled:opacity-60"
            >
              {archiving ? "Archiving…" : "Archive"}
            </button>
          </span>
        )}
        {statusMsg && <span className="block text-xs text-muted-foreground mt-0.5">{statusMsg}</span>}
        {viewError && <span className="block text-xs text-destructive mt-0.5">{viewError}</span>}
        {extractError && <span className="block text-xs text-destructive mt-0.5">{extractError}</span>}
        {archiveError && <span className="block text-xs text-destructive mt-0.5">{archiveError}</span>}
        {swapError && <span className="block text-xs text-destructive mt-0.5">{swapError}</span>}
      </td>
    </tr>
  );
}
