import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import {
  getDocumentWithExtraction,
  triggerExtraction,
  skipExtraction,
} from "@/actions/documents";
import { listEntityAccounts, listBankStatements } from "@/actions/bank-statements";
import { getEntityBySlug } from "@/lib/entity";
import { DocumentReviewClient } from "@/components/documents/document-review-client";
import Link from "next/link";
import type { Route } from "next";
import type { ExtractedDocument } from "@/lib/doc-extract";
import { needsCreditCardReclassification } from "@/lib/statement-review";

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

  // Auto-trigger extraction if not yet attempted, OR if a prior extraction
  // ran before the linked account was known to be a credit card (no row
  // carries a lineType at all yet) — a self-healing re-check for the
  // extraction-timing gap described in the plan's Risks section.
  let extraction = doc.extractionData as ExtractedDocument | null;
  // Mirrors doc.extractionStatus, but reassigned below when we actually run
  // triggerExtraction this render — doc itself is never re-fetched, so
  // every status check further down must read this, not doc.extractionStatus
  // directly, or a failed extraction silently falls through every branch
  // (no error shown, no retry button) since doc.extractionStatus still holds
  // whatever it was *before* the attempt (e.g. null for a first-time
  // extraction). triggerExtraction's own try/catch guarantees this
  // correspondence: non-null return means it persisted "complete", null
  // means it persisted "failed" — no second DB round-trip needed to know
  // which.
  let extractionStatus = doc.extractionStatus;
  // Real, already-usable data (transaction rows, or any extracted fields)
  // from a prior attempt — checked independently of extractionStatus,
  // because the two can drift. BankStatement has its own separate
  // extractStatus (period/balance only, set by actions/bank-statements.ts's
  // retry/confirm flows) that drives the "Extracted" badge on the
  // statements list — it has no relationship to *this* Document's own
  // extractionStatus (transaction rows, set only by triggerExtraction
  // below). A statement can show "Extracted" on the list while this page
  // has never run its own extraction at all, or ran it once successfully
  // and then had extractionStatus clobbered by an unrelated failed
  // re-attempt (Next.js prefetching this same link on hover can race a
  // second triggerExtraction call against the first — confirmed live
  // against a real EK Consulting Capital One statement: extractionStatus
  // ended up "failed" while extractionData still held a real, complete
  // 13-row result from an earlier successful attempt whose write simply
  // landed first). Once real data exists, never silently blow it away with
  // another slow, non-idempotent AI call just because extractionStatus
  // doesn't currently say "complete" — only re-trigger for a genuinely
  // empty document or the credit-card reclassification case below, which
  // already only fires for real stale data.
  const hasUsableData = !!(
    extraction && ((extraction.transactionRows?.length ?? 0) > 0 || Object.keys(extraction.data ?? {}).length > 0)
  );
  // Drives the "already extracted, skip ahead?" banner — true whenever
  // there's real data to show and we're not about to overwrite it this
  // render (see hasUsableData above for why this can be true even when
  // extractionStatus itself says something other than "complete").
  let alreadyExtracted = hasUsableData;
  const staleCreditCardExtraction = needsCreditCardReclassification(
    doc.bankStatement?.account?.accountType,
    extraction
  );
  if ((!hasUsableData && !doc.extractionStatus) || doc.extractionStatus === "pending" || staleCreditCardExtraction) {
    // force: true only for the reclassification case — triggerExtraction's
    // own hasUsableData short-circuit would otherwise skip the re-run
    // entirely once real (if lineType-less) data already exists, silently
    // defeating this self-heal. The other two conditions only ever fire for
    // a genuinely empty/pending document, where force is irrelevant.
    extraction = await triggerExtraction(id, { force: staleCreditCardExtraction });
    extractionStatus = extraction ? "complete" : "failed";
    alreadyExtracted = false;
  }

  // When arriving from a business/personal statements page (?bucket=<entity-slug>),
  // point the breadcrumb/back-link there instead of the generic vault, and
  // (for bank/credit-card statements) fetch the entity's accounts for a real
  // picker.
  const entity = bucket ? await getEntityBySlug(bucket) : null;
  const backHref = (entity ? `/business/${bucket}/statements` : "/documents") as Route;
  const backLabel = entity ? "Statements" : "Documents";

  const isBankStatement = doc.docType === "bank_statement";
  const accounts = isBankStatement ? await listEntityAccounts(doc.entityId) : null;
  // The business-expense override is only meaningful — and only rendered —
  // for a document belonging to the Personal entity (see plan's Required
  // Finding 2). Server-side enforcement lives in importStatementTransactions;
  // this just controls whether the checkbox appears at all.
  const canFlagBusinessExpense = doc.entity.type === "personal";

  // "Next statement on the list" -- same order the Bank Statements table
  // uses (periodEnd desc). Only meaningful when we arrived from that page
  // (?bucket=) and there's a sibling statement after this one.
  let nextReviewHref: Route | null = null;
  // "Next statement that still needs extraction" -- for skipping past a run
  // of already-extracted statements straight to one that needs attention.
  // Searches forward from the current position first, then wraps around the
  // rest of the list, so it finds one wherever it sits, not just directly
  // after this statement.
  let nextUnextractedHref: Route | null = null;
  if (isBankStatement && entity) {
    const siblingStatements = await listBankStatements(doc.entityId);
    const currentIndex = siblingStatements.findIndex((s) => s.documentId === id);
    const next = currentIndex >= 0 ? siblingStatements[currentIndex + 1] : undefined;
    if (next?.documentId) {
      nextReviewHref = `/documents/${next.documentId}/review?bucket=${bucket}` as Route;
    }

    if (currentIndex >= 0) {
      const ordered = [
        ...siblingStatements.slice(currentIndex + 1),
        ...siblingStatements.slice(0, currentIndex),
      ];
      const nextUnextracted = ordered.find(
        (s) => s.documentId && s.documentId !== id && s.extractStatus !== "complete"
      );
      if (nextUnextracted?.documentId) {
        nextUnextractedHref = `/documents/${nextUnextracted.documentId}/review?bucket=${bucket}` as Route;
      }
    }
  }

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {entity && entity.type === "business" ? (
            <>
              <Link href={"/business" as Route} className="hover:underline">Business</Link>
              <span>/</span>
              <span>{entity.navLabel ?? entity.name}</span>
              <span>/</span>
              <Link href={backHref} className="hover:underline">{backLabel}</Link>
              <span>/</span>
              <span>Review extraction</span>
            </>
          ) : entity ? (
            <>
              <span>Personal</span>
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

        {alreadyExtracted && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm">
            <span className="text-green-800">
              ✓ Already extracted{doc.bankStatement?.confirmedAt ? " and confirmed" : " — not yet confirmed"}.
            </span>
            {/* prefetch={false} on both: visiting either target page can trigger
                a real, non-idempotent AI extraction call as a side effect of
                its own render — never prefetch that in the background. */}
            <div className="flex items-center gap-3">
              {nextUnextractedHref && (
                <Link href={nextUnextractedHref} prefetch={false} className="text-green-800 hover:underline">
                  Skip to next unextracted →
                </Link>
              )}
              {nextReviewHref && (
                <Link href={nextReviewHref} prefetch={false} className="text-green-800 hover:underline">
                  Next statement →
                </Link>
              )}
              <Link href={backHref} className="text-green-800 hover:underline">
                ← Back to {backLabel}
              </Link>
            </div>
          </div>
        )}

        {extractionStatus === "failed" && !extraction && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Extraction failed. The document may be unsupported, corrupted, or too large.
            <form action={async () => { "use server"; await triggerExtraction(id, { force: true }); }}>
              <button type="submit" className="ml-3 underline">Try again</button>
            </form>
          </div>
        )}

        {extractionStatus === "processing" && (
          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            Extraction in progress…
          </div>
        )}

        {extraction && (
          <DocumentReviewClient
            documentId={id}
            extraction={extraction}
            entityId={doc.entityId}
            isBankStatement={isBankStatement}
            accounts={accounts ?? undefined}
            defaultAccountId={doc.bankStatement?.accountId ?? null}
            canFlagBusinessExpense={canFlagBusinessExpense}
            backHref={backHref}
            backLabel={backLabel}
            nextReviewHref={nextReviewHref}
          />
        )}

        {extractionStatus === "skipped" && (
          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            Extraction was skipped for this document.
          </div>
        )}

        <div className="flex items-center gap-3">
          {extractionStatus !== "skipped" && (
            <form action={async () => { "use server"; await skipExtraction(id); redirect(backHref); }}>
              <button type="submit" className="text-sm text-muted-foreground hover:underline">
                Skip — store without extraction
              </button>
            </form>
          )}
          {/* Already shown in the green banner above when alreadyExtracted — avoid
              showing it twice on the same page. prefetch={false}: same reason
              as the banner's copy of this link above. */}
          {!alreadyExtracted && nextUnextractedHref && (
            <Link href={nextUnextractedHref} prefetch={false} className="text-sm text-muted-foreground hover:underline">
              Skip to next unextracted →
            </Link>
          )}
          <Link href={backHref} className="text-sm text-muted-foreground hover:underline">
            ← Back to {backLabel}
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
