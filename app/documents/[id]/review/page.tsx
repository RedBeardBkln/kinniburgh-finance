import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import {
  getDocumentWithExtraction,
  triggerExtraction,
  skipExtraction,
} from "@/actions/documents";
import { listEntityAccounts } from "@/actions/bank-statements";
import { getEntityBySlug } from "@/lib/entity";
import { DocumentReviewClient } from "@/components/documents/document-review-client";
import Link from "next/link";
import type { Route } from "next";
import type { ExtractedDocument } from "@/lib/doc-extract";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ bucket?: string }>;
}

export default async function DocumentReviewPage({ params, searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const { id } = await params;
  const { bucket } = await searchParams;
  const doc = await getDocumentWithExtraction(id);

  // Auto-trigger extraction if not yet attempted
  let extraction = doc.extractionData as ExtractedDocument | null;
  if (!doc.extractionStatus || doc.extractionStatus === "pending") {
    extraction = await triggerExtraction(id);
  }

  // When arriving from a business statements page (?bucket=<entity-slug>),
  // point the breadcrumb/back-link there instead of the generic vault, and
  // (for bank statements) fetch the entity's accounts for a real picker.
  const entity = bucket ? await getEntityBySlug(bucket) : null;
  const backHref = (entity ? `/business/${bucket}/statements` : "/documents") as Route;
  const backLabel = entity ? "Bank Statements" : "Documents";

  const accounts = doc.docType === "bank_statement"
    ? await listEntityAccounts(doc.entityId)
    : null;

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {entity ? (
            <>
              <Link href={"/business" as Route} className="hover:underline">Business</Link>
              <span>/</span>
              <span>{entity.navLabel ?? entity.name}</span>
              <span>/</span>
              <Link href={backHref} className="hover:underline">{backLabel}</Link>
              <span>/</span>
              <span>Review extraction</span>
            </>
          ) : (
            <>
              <Link href={backHref} className="hover:underline">{backLabel}</Link>
              <span>/</span>
              <span>Review extraction</span>
            </>
          )}
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
            accounts={accounts ?? undefined}
            defaultAccountId={doc.bankStatement?.accountId ?? null}
          />
        )}

        {doc.extractionStatus === "skipped" && (
          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            Extraction was skipped for this document.
          </div>
        )}

        <div className="flex items-center gap-3">
          {doc.extractionStatus !== "skipped" && (
            <form action={async () => { "use server"; await skipExtraction(id); redirect(backHref); }}>
              <button type="submit" className="text-sm text-muted-foreground hover:underline">
                Skip — store without extraction
              </button>
            </form>
          )}
          <Link href={backHref} className="text-sm text-muted-foreground hover:underline">
            ← Back to {backLabel}
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
