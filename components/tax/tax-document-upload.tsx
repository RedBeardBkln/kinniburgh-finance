"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { documentTypeLabel } from "@/lib/doc-naming";
import { summarizeUploadBatch } from "@/lib/tax-doc-batch";
import { uploadTaxDocuments, updateTaxDocument } from "@/actions/tax-planning";

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

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

export function TaxDocumentUpload({ entityId, taxYear, documents }: Props) {
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

    setUploading(true);
    try {
      const results = await uploadTaxDocuments(formData);
      setUploadMsg(summarizeUploadBatch(results));
      formEl.reset();
      startTransition(() => router.refresh());
    } catch {
      // Server action errors are sanitized boilerplate in production (Next.js
      // strips the real message) — never show err.message to the user here.
      // Per-file failures (bad type, too large, extraction error) are already
      // surfaced individually via the returned batch results, not this catch —
      // this only fires for a genuinely unexpected failure (e.g. too many
      // files selected at once, or an auth/network problem).
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
                  <DocumentRowEditable key={d.id} doc={d} />
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

function DocumentRowEditable({ doc }: { doc: DocumentRow }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(doc.documentName ?? documentTypeLabel(doc.docType));
  const [docType, setDocType] = useState<string>(doc.docType);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!name.trim()) {
      setError("Name can't be empty.");
      return;
    }
    setSaving(true);
    setError(null);
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
  }

  const typeLabel = documentTypeLabel(docType);

  return (
    <tr className="border-b last:border-0">
      <td className="py-2">
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
          <button
            onClick={() => setEditing(true)}
            className="text-xs text-primary hover:underline"
          >
            Rename / retype
          </button>
        )}
      </td>
    </tr>
  );
}
