"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { documentTypeLabel } from "@/lib/doc-naming";
import { getTaxDocumentSignedUrl } from "@/actions/tax-planning";

export interface OtherYearDocument {
  id: string;
  docType: string;
  documentName: string | null;
  notes: string | null;
  taxYear: number | null;
  createdAt: string;
}

interface Props {
  documents: OtherYearDocument[];
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

/**
 * Collapsed, read-only "Other years" reference section — shows this entity's
 * documents from every year other than the one currently open, grouped by
 * year (descending). Each row has a "View" button that fetches a signed URL
 * on click (this is the first click-to-fetch pattern in this codebase; kept
 * deliberately minimal) and reports failure inline rather than failing silently.
 */
export function OtherYearDocuments({ documents }: Props) {
  const [open, setOpen] = useState(false);

  if (documents.length === 0) return null;

  const byYear = new Map<number | null, OtherYearDocument[]>();
  for (const doc of documents) {
    const list = byYear.get(doc.taxYear) ?? [];
    list.push(doc);
    byYear.set(doc.taxYear, list);
  }
  const years = Array.from(byYear.keys()).sort((a, b) => (b ?? -Infinity) - (a ?? -Infinity));

  return (
    <Card>
      <CardHeader className="pb-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between text-left"
        >
          <CardTitle className="text-base">
            Other years ({documents.length} document{documents.length !== 1 ? "s" : ""})
          </CardTitle>
          <span className="text-xs text-muted-foreground">{open ? "Hide ▲" : "Show ▼"}</span>
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          {years.map((year) => (
            <div key={year ?? "none"} className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {year ?? "No year"}
              </p>
              {byYear.get(year)!.map((doc) => (
                <OtherYearDocRow key={doc.id} doc={doc} />
              ))}
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function OtherYearDocRow({ doc }: { doc: OtherYearDocument }) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleView() {
    setError(null);
    setLoading(true);
    try {
      const url = await getTaxDocumentSignedUrl(doc.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open this document — try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="py-1">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
          {documentTypeLabel(doc.docType)}
        </span>
        <span className="flex-1 truncate text-muted-foreground">
          {doc.documentName ?? doc.notes ?? "—"}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
          {fmtDate(doc.createdAt)}
        </span>
        <button
          onClick={handleView}
          disabled={loading}
          className="shrink-0 text-xs font-medium text-primary hover:underline disabled:opacity-60"
        >
          {loading ? "Opening…" : "View"}
        </button>
      </div>
      {error && <p className="mt-0.5 text-right text-xs text-destructive">{error}</p>}
    </div>
  );
}
