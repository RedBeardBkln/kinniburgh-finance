import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import {
  getDocumentWithExtraction,
  triggerExtraction,
  skipExtraction,
} from "@/actions/documents";
import { DocumentReviewClient } from "@/components/documents/document-review-client";
import Link from "next/link";
import type { Route } from "next";
import type { ExtractedDocument } from "@/lib/doc-extract";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function DocumentReviewPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const { id } = await params;
  const doc = await getDocumentWithExtraction(id);

  // Auto-trigger extraction if not yet attempted
  let extraction = doc.extractionData as ExtractedDocument | null;
  if (!doc.extractionStatus || doc.extractionStatus === "pending") {
    extraction = await triggerExtraction(id);
  }

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Link href={"/documents" as Route} className="hover:underline">Documents</Link>
          <span>/</span>
          <span>Review extraction</span>
        </div>

        <div>
          <h1 className="text-2xl font-semibold">Document Review</h1>
          <p className="text-sm text-muted-foreground">
            {doc.entity.name} · {doc.docType} · uploaded {doc.createdAt.toLocaleDateString("en-US", { timeZone: "America/New_York" })}
          </p>
        </div>

        {doc.extractionStatus === "failed" && !extraction && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Extraction failed. The document may be unsupported, corrupted, or too large.
            <form action={async () => { "use server"; await triggerExtraction(id); }}>
              <button type="submit" className="ml-3 underline">Try again</button>
            </form>
          </div>
        )}

        {doc.extractionStatus === "processing" && (
          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            Extraction in progress…
          </div>
        )}

        {extraction && (
          <DocumentReviewClient
            documentId={id}
            extraction={extraction}
            entityId={doc.entityId}
          />
        )}

        {doc.extractionStatus === "skipped" && (
          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            Extraction was skipped for this document.
          </div>
        )}

        <div className="flex items-center gap-3">
          {doc.extractionStatus !== "skipped" && (
            <form action={async () => { "use server"; await skipExtraction(id); redirect("/documents" as Route); }}>
              <button type="submit" className="text-sm text-muted-foreground hover:underline">
                Skip — store without extraction
              </button>
            </form>
          )}
          <Link href={"/documents" as Route} className="text-sm text-muted-foreground hover:underline">
            ← Back to documents
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
