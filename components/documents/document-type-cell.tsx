"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { changeDocumentType, runDocumentExtraction } from "@/actions/documents";
import { isExtractableDocType } from "@/lib/document-extraction-state";
import { RETYPE_TARGET_OPTIONS, isRetypableFrom, retypeTargetLabel } from "@/lib/document-retype";

// The "Document Type" cell on /documents: the type badge plus an always-visible
// "Change type" control (donation-receipt-document-type). Re-typing writes only
// the type (and a placeholder name); when the new type has an extraction schema
// the document is then read with the AI (one API call), so its values can be
// reviewed. A VERIFIED document cannot be re-typed here: the owner un-verifies it
// on the review screen first (the same rule the tax workspace enforces).

interface DocumentTypeCellProps {
  documentId: string;
  docType: string;
  /** Badge text and classes, decided by the page. */
  label: string;
  badgeClass: string;
  /** The row's extraction kind (describeExtraction): "verified" blocks the control. */
  extractionKind: string | null;
}

export function DocumentTypeCell({ documentId, docType, label, badgeClass, extractionKind }: DocumentTypeCellProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [next, setNext] = useState(docType);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const badge = (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${badgeClass}`}>{label}</span>
  );
  if (!isRetypableFrom(docType)) return badge;

  if (extractionKind === "verified") return badge;

  async function save() {
    if (next === docType) {
      setEditing(false);
      return;
    }
    setError(null);
    if (
      isExtractableDocType(next) &&
      !window.confirm(
        `Change this document's type to ${retypeTargetLabel(next)}? It will be read with AI (one API call, about 20-60 seconds) so its values can be reviewed. Your file is not changed.`
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await changeDocumentType({ documentId, docType: next });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.extract) {
        const read = await runDocumentExtraction(documentId, { force: true });
        if (!read.ok) {
          setError(`Type changed, but reading it failed: ${read.error}. Use Retry in the Extraction column.`);
        }
      }
      setEditing(false);
      router.refresh();
    } catch {
      setError("Could not change the type - try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="space-y-1">
        {badge}
        <div>
          <button
            type="button"
            onClick={() => {
              setNext(docType);
              setError(null);
              setEditing(true);
            }}
            className={`text-[11px] hover:underline ${docType === "other" ? "text-amber-700" : "text-primary"}`}
          >
            {docType === "other" ? "Donation or tax document? Change type" : "Change type"}
          </button>
        </div>
        {error && <p className="text-[11px] text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {badge}
      <select
        value={next}
        onChange={(e) => setNext(e.target.value)}
        disabled={busy}
        aria-label="New document type"
        className="w-full rounded-md border border-input bg-background px-1.5 py-1 text-xs"
      >
        {RETYPE_TARGET_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-muted-foreground">
        Changes the label and, for tax types, reads the document with AI. Your file is not changed.
      </p>
      {busy && <p className="text-[11px] text-muted-foreground">Working - reading the document can take up to a minute...</p>}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground disabled:opacity-60"
        >
          {busy ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={busy}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
