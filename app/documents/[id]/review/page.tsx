import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import {
  getDocumentWithExtraction,
  getLedgerPresenceByAccount,
  skipExtraction,
} from "@/actions/documents";
import { listEntityAccounts, listBankStatements } from "@/actions/bank-statements";
import { getEntityBySlug } from "@/lib/entity";
import { DocumentReviewClient } from "@/components/documents/document-review-client";
import { ExtractionRunner } from "@/components/documents/extraction-runner";
import Link from "next/link";
import type { Route } from "next";
import type { ExtractedDocument } from "@/lib/doc-extract";
import { needsCreditCardReclassification } from "@/lib/statement-review";
import {
  deriveStatementStage,
  effectiveDocumentStatus,
  hasUsableExtraction,
  importableRowIndices,
  stageNeedsAttention,
} from "@/lib/statement-import";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ bucket?: string }>;
}

// This page is a pure read. It never starts an extraction: a page view (or a
// Next.js link prefetch of one) used to run a slow, non-idempotent Claude call
// as a side effect of rendering, which raced itself, threw on
// revalidatePath, and could leave a row stuck on "processing". Extraction is
// started only by <ExtractionRunner>, from the browser, as a server action.
export default async function DocumentReviewPage({ params, searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const { id } = await params;
  const { bucket } = await searchParams;
  const doc = await getDocumentWithExtraction(id);

  const extraction = doc.extractionData as ExtractedDocument | null;
  const rows = extraction?.transactionRows ?? [];
  // Real, reviewable data — judged by the data itself, never the status label,
  // because the two can disagree (a "failed" label can sit on a complete
  // extraction, and a "complete" label on an unparseable stub).
  const usable = hasUsableExtraction(extraction);
  // A "processing" lock older than a few minutes is a dead extraction.
  const docStatus = effectiveDocumentStatus(doc.extractionStatus, doc.updatedAt);
  // Extracted before the account was known to be a credit card (no row carries
  // a lineType) — re-read it with the credit-card prompt.
  const staleCreditCard = usable && needsCreditCardReclassification(doc.bankStatement?.account?.accountType, extraction);

  // When arriving from a business/personal statements page (?bucket=<entity-slug>),
  // point the breadcrumb/back-link there instead of the generic vault.
  const entity = bucket ? await getEntityBySlug(bucket) : null;
  const backHref = (entity ? `/business/${bucket}/statements` : "/documents") as Route;
  const backLabel = entity ? "Statements" : "Documents";

  const isBankStatement = doc.docType === "bank_statement";
  const accounts = isBankStatement ? await listEntityAccounts(doc.entityId) : null;
  // The business-expense override is only meaningful — and only rendered —
  // for a document belonging to the Personal entity. Server-side enforcement
  // lives in importStatementTransactions.
  const canFlagBusinessExpense = doc.entity.type === "personal";

  const ledgerPresence =
    isBankStatement && usable && accounts && accounts.length > 0
      ? await getLedgerPresenceByAccount(id, accounts.map((a) => a.id))
      : {};

  const importable = importableRowIndices(rows);
  const linkedPresence = ledgerPresence[doc.bankStatement?.accountId ?? ""] ?? [];
  const rowsInLedger = importable.filter((i) => linkedPresence[i]).length;
  const missing = importable.length - rowsInLedger;
  const confirmed = !!doc.bankStatement?.confirmedAt;
  const stage = deriveStatementStage({
    documentStatus: docStatus,
    hasUsableData: usable,
    importableRows: importable.length,
    rowsInLedger,
    confirmed,
  });

  // Sibling navigation, in the same order as the Statements table
  // (periodEnd desc). "Needs attention" is judged by where the TRANSACTIONS
  // stand (extracted? in the ledger?), not by BankStatement.extractStatus,
  // which only says whether the period and balances were read — that made
  // "Skip to next unextracted" skip straight past statements that were read
  // but never imported.
  let nextReviewHref: Route | null = null;
  let nextAttentionHref: Route | null = null;
  if (isBankStatement && entity) {
    const siblings = await listBankStatements(doc.entityId);
    const currentIndex = siblings.findIndex((s) => s.documentId === id);
    const next = currentIndex >= 0 ? siblings[currentIndex + 1] : undefined;
    if (next?.documentId) {
      nextReviewHref = `/documents/${next.documentId}/review?bucket=${bucket}` as Route;
    }
    if (currentIndex >= 0) {
      // Forward from the current position first, then wrap around the rest.
      const ordered = [...siblings.slice(currentIndex + 1), ...siblings.slice(0, currentIndex)];
      const target = ordered.find((s) => s.documentId && stageNeedsAttention(s.stage));
      if (target?.documentId) {
        nextAttentionHref = `/documents/${target.documentId}/review?bucket=${bucket}` as Route;
      }
    }
  }

  // Remounts the runner whenever the extraction's state changes (a run just
  // finished, the status moved on), so a runner that succeeded but is still
  // needed — e.g. nothing readable came back — starts fresh in its new mode
  // instead of sitting on a stale "extracting…" spinner.
  const runnerKey = `${id}-${docStatus ?? "none"}-${usable}-${doc.extractedAt?.getTime() ?? 0}`;
  // What (if anything) needs to run or be retried before there is data to review.
  let runner: ReactNode = null;
  if (staleCreditCard) {
    runner = <ExtractionRunner key={runnerKey} documentId={id} mode="auto" force />;
  } else if (!usable) {
    if (docStatus === null || docStatus === "pending") {
      runner = <ExtractionRunner key={runnerKey} documentId={id} mode="auto" />;
    } else if (docStatus === "processing") {
      runner = <ExtractionRunner key={runnerKey} documentId={id} mode="wait" />;
    } else if (docStatus === "failed") {
      runner = (
        <ExtractionRunner
          key={runnerKey}
          documentId={id}
          mode="manual"
          message="Extraction failed. The document may be unsupported, corrupted, or too large."
        />
      );
    } else if (docStatus === "skipped") {
      runner = (
        <ExtractionRunner
          key={runnerKey}
          documentId={id}
          mode="manual"
          message="Extraction was skipped for this document."
          buttonLabel="Extract anyway"
        />
      );
    } else {
      // "complete" with nothing readable in it — e.g. an old response that was
      // cut off. Never leave the owner on a dead end.
      runner = (
        <ExtractionRunner
          key={runnerKey}
          documentId={id}
          mode="manual"
          message="This document was marked extracted, but no readable data was saved."
          buttonLabel="Re-run extraction"
        />
      );
    }
  }

  const showReview = usable && !staleCreditCard;

  // Banner: says plainly whether the transactions have reached the ledger.
  // "Extracted" alone is not the same as "imported", and a green check next to
  // "not yet confirmed" read as done when nothing had been imported.
  let banner: { tone: "green" | "amber" | "red" | "muted"; text: string } | null = null;
  if (showReview) {
    if (!isBankStatement) {
      banner = { tone: "green", text: `✓ Extracted${confirmed ? " and confirmed" : ""}.` };
    } else if (stage === "imported") {
      banner = {
        tone: "green",
        text: `✓ All ${importable.length} transactions from this statement are in your ledger.${confirmed ? "" : " Confirm below to mark it reviewed."}`,
      };
    } else if (stage === "confirmed_not_imported") {
      banner = {
        tone: "red",
        text: `This statement is marked confirmed, but ${missing} of its ${importable.length} transactions are NOT in your ledger. Review the rows below and import them.`,
      };
    } else if (stage === "ready_to_import") {
      banner = {
        tone: "amber",
        text: `Extracted, but not imported yet: ${missing} of ${importable.length} transactions are not in your ledger. Review the rows below, then click “Confirm extraction & import”.`,
      };
    } else if (stage === "no_transactions") {
      banner = { tone: "muted", text: "No importable transactions were found on this statement." };
    }
  }
  const bannerClass = {
    green: "border-green-200 bg-green-50 text-green-800",
    amber: "border-amber-300 bg-amber-50 text-amber-900",
    red: "border-red-300 bg-red-50 text-red-900",
    muted: "border-border bg-muted/30 text-muted-foreground",
  } as const;

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

        {banner && (
          <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${bannerClass[banner.tone]}`}>
            <span>{banner.text}</span>
            {/* prefetch={false}: no longer required for correctness now that this
                page is side-effect free, but a prefetch still renders the whole
                page server-side for nothing. */}
            <div className="flex items-center gap-3">
              {nextAttentionHref && (
                <Link href={nextAttentionHref} prefetch={false} className="hover:underline">
                  Skip to next needing attention →
                </Link>
              )}
              {nextReviewHref && (
                <Link href={nextReviewHref} prefetch={false} className="hover:underline">
                  Next statement →
                </Link>
              )}
              <Link href={backHref} prefetch={false} className="hover:underline">
                ← Back to {backLabel}
              </Link>
            </div>
          </div>
        )}

        {runner}

        {showReview && extraction && (
          <DocumentReviewClient
            documentId={id}
            extraction={extraction}
            entityId={doc.entityId}
            isBankStatement={isBankStatement}
            accounts={accounts ?? undefined}
            defaultAccountId={doc.bankStatement?.accountId ?? null}
            canFlagBusinessExpense={canFlagBusinessExpense}
            ledgerPresence={ledgerPresence}
            backHref={backHref}
            backLabel={backLabel}
            nextReviewHref={nextReviewHref}
          />
        )}

        <div className="flex items-center gap-3">
          {!usable && docStatus !== "skipped" && (
            <form action={async () => { "use server"; await skipExtraction(id); redirect(backHref); }}>
              <button type="submit" className="text-sm text-muted-foreground hover:underline">
                Skip — store without extraction
              </button>
            </form>
          )}
          {!banner && nextAttentionHref && (
            <Link href={nextAttentionHref} prefetch={false} className="text-sm text-muted-foreground hover:underline">
              Skip to next needing attention →
            </Link>
          )}
          <Link href={backHref} prefetch={false} className="text-sm text-muted-foreground hover:underline">
            ← Back to {backLabel}
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
