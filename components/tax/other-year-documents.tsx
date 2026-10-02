"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { documentTypeLabel } from "@/lib/doc-naming";
import { getTaxDocumentSignedUrl } from "@/actions/tax-planning";
import { archiveWorkspaceStatement } from "@/actions/statement-archive";
import { buildStatementArchiveConfirmMessage } from "@/lib/statement-archive";
import { attributionLabel, type PersonRef } from "@/lib/document-attribution";

export interface OtherYearDocument {
  id: string;
  docType: string;
  documentName: string | null;
  notes: string | null;
  taxYear: number | null;
  createdAt: string;
  /** Attribution (read-only here; edit it in the current-year table or on /documents). */
  subjectType: string | null;
  subjectUserId: string | null;
  issuerName: string | null;
}

interface Props {
  workspaceId: string;
  documents: OtherYearDocument[];
  /** Household members (id + name only), used to label the person. */
  people?: PersonRef[];
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
 * Collapsed "Other years" reference section — shows this entity's
 * documents from every year other than the one currently open, grouped by
 * year (descending). Each row has a "View" button that fetches a signed URL
 * on click (this is the first click-to-fetch pattern in this codebase; kept
 * deliberately minimal) and reports failure inline rather than failing silently.
 * Bank-statement rows also get a confirm-guarded "Archive" button (soft
 * archive; the server action enforces entity ownership and docType).
 */
export function OtherYearDocuments({ workspaceId, documents, people = [] }: Props) {
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
                <OtherYearDocRow key={doc.id} doc={doc} workspaceId={workspaceId} people={people} />
              ))}
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function OtherYearDocRow({
  doc,
  workspaceId,
  people,
}: {
  doc: OtherYearDocument;
  workspaceId: string;
  people: PersonRef[];
}) {
  const router = useRouter();
  const subject = attributionLabel(
    {
      subjectType: doc.subjectType,
      subjectUser: doc.subjectUserId ? (people.find((p) => p.id === doc.subjectUserId) ?? null) : null,
    },
    people
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const busy = loading || archiving;

  async function handleArchive() {
    const name = doc.documentName ?? doc.notes ?? "this statement";
    if (!confirm(buildStatementArchiveConfirmMessage(name))) return;
    setError(null);
    setArchiving(true);
    try {
      const res = await archiveWorkspaceStatement({ workspaceId, documentId: doc.id });
      if ("error" in res) {
        setError(res.error);
      } else {
        router.refresh();
      }
    } catch {
      setError("Archive failed - try again.");
    } finally {
      setArchiving(false);
    }
  }

  async function handleView() {
    setError(null);
    setLoading(true);
    try {
      const url = await getTaxDocumentSignedUrl(doc.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      // Server action errors are sanitized boilerplate in production (Next.js
      // strips the real message) — never show err.message to the user here.
      setError("Couldn't open this document — it may be missing from storage.");
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
        <span
          className={
            subject.assigned
              ? "shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-xs"
              : "shrink-0 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700"
          }
        >
          {subject.label}
        </span>
        {doc.issuerName && (
          <span className="max-w-[10rem] shrink-0 truncate text-xs text-muted-foreground" title={doc.issuerName}>
            {doc.issuerName}
          </span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
          {fmtDate(doc.createdAt)}
        </span>
        <button
          onClick={handleView}
          disabled={busy}
          className="shrink-0 text-xs font-medium text-primary hover:underline disabled:opacity-60"
        >
          {loading ? "Opening…" : "View"}
        </button>
        {doc.docType === "bank_statement" && (
          <button
            onClick={handleArchive}
            disabled={busy}
            className="shrink-0 text-xs font-medium text-destructive hover:underline disabled:opacity-60"
          >
            {archiving ? "Archiving…" : "Archive"}
          </button>
        )}
      </div>
      {error && <p className="mt-0.5 text-right text-xs text-destructive">{error}</p>}
    </div>
  );
}
