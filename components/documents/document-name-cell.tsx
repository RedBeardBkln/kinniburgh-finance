"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { renameDocument } from "@/actions/documents";
import { DOCUMENT_NAME_MAX, validateDocumentName } from "@/lib/document-rename";

// The "Document Name" cell on /documents: the name plus an always-visible
// "Rename" control. Renaming writes only the display name (never the type, the
// extraction or its verification), so it is available on every row, including a
// verified document. No confirmation dialog: it is an inline edit that Cancel undoes.

interface DocumentNameFormProps {
  value: string;
  busy: boolean;
  error: string | null;
  onChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** The inline edit form (separate from the stateful cell so it can be rendered on its own). */
export function DocumentNameForm({ value, busy, error, onChange, onSave, onCancel }: DocumentNameFormProps) {
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={busy}
        aria-label="Document name"
        className="w-full rounded-md border border-input bg-background px-1.5 py-1 text-xs"
      />
      <p className="text-[11px] text-muted-foreground">
        Changes the name only. Up to {DOCUMENT_NAME_MAX} characters. Your file and its values are not changed.
      </p>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground disabled:opacity-60"
        >
          {busy ? "Saving..." : "Save name"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

interface DocumentNameCellProps {
  documentId: string;
  /** Document.documentName (null when the document was never named). */
  documentName: string | null;
  /** What the row shows when there is no name (the legacy upload note), or null. */
  fallbackText: string | null;
}

export function DocumentNameCell({ documentId, documentName, fallbackText }: DocumentNameCellProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(documentName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const checked = validateDocumentName(draft);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await renameDocument({ documentId, documentName: checked.name });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setEditing(false);
      router.refresh();
    } catch {
      setError("Could not rename the document - try again.");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <DocumentNameForm
        value={draft}
        busy={busy}
        error={error}
        onChange={setDraft}
        onSave={save}
        onCancel={() => {
          setEditing(false);
          setError(null);
        }}
      />
    );
  }

  const shown = documentName ?? fallbackText;
  return (
    <div className="space-y-1">
      <div className="truncate" title={shown ?? undefined}>
        {shown ?? <span className="text-muted-foreground">—</span>}
      </div>
      <button
        type="button"
        onClick={() => {
          setDraft(documentName ?? "");
          setError(null);
          setEditing(true);
        }}
        className="text-[11px] text-primary hover:underline"
        aria-label={`Rename ${shown ?? "this document"}`}
      >
        Rename
      </button>
    </div>
  );
}
