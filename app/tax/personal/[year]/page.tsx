import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { ensurePersonalWorkspace } from "@/actions/tax-planning";
import { getTaxWorkspace } from "@/actions/tax";
import {
  baseOpportunitiesForHousehold,
  evaluateAnswers,
  formatOpportunityForDisplay,
  REFUND_OBJECTIVE_STATEMENT,
  withoutSuddenValleyItems,
} from "@/lib/tax-guidance";
import { isSuddenValleyActiveForYear } from "@/lib/sudden-valley-year";
import { PersonalTaxClient } from "@/components/tax/personal-tax-client";
import { buildPersonalTaxComputeInput, findUnparseableExtractions } from "@/lib/tax-compute-build";
import { computePersonalTaxReturn } from "@/lib/tax-compute";
import { serializeTaxComputeResult, type SerializedTaxDraft } from "@/lib/tax-compute-display";
import { suggestIssuerFromExtraction } from "@/lib/document-attribution";
import { describeDocumentRow } from "@/lib/document-extraction-state";
import { resolveTaxDocForCompute } from "@/lib/tax-extraction-policy";
import type { Route } from "next";

interface PageProps {
  params: Promise<{ year: string }>;
}

export default async function PersonalTaxWorkspacePage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { year: yearStr } = await params;
  const year = Number(yearStr);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) notFound();

  const workspaceId = await ensurePersonalWorkspace(year);
  const workspace = await getTaxWorkspace(workspaceId);

  // Sudden Valley (formed Feb 2026) only matters from its first year: for earlier
  // years its rental question and rental opportunities are not shown at all.
  const suddenValleyActive = await isSuddenValleyActiveForYear(year);

  const [allQuestions, people, allDocs] = await Promise.all([
    db.taxQuestion.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    }),
    // id + name only — never select email/passwordHash/totpSecret.
    db.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.document.findMany({
      where: { entityId: workspace.entityId, archivedAt: null },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const docs = allDocs.filter((d) => d.taxYear === year);
  const otherYearDocs = allDocs.filter((d) => d.taxYear !== year);

  const questions = withoutSuddenValleyItems(allQuestions, suddenValleyActive);

  // Evaluate which opportunities the answers act on / exclude
  const answerMap: Record<string, unknown> = {};
  for (const q of questions) {
    answerMap[q.key] = q.answer;
  }
  const { excluded, actOn } = evaluateAnswers(answerMap);

  const baseOps = withoutSuddenValleyItems(baseOpportunitiesForHousehold(), suddenValleyActive).map((op) => {
    const display = formatOpportunityForDisplay(op);
    const isExcluded = excluded.includes(op.key);
    const isActOn = actOn.includes(op.key);
    return {
      ...op,
      riskLabel: display.riskLabel,
      riskClass: display.riskClass,
      isExcluded,
      isActOn,
    };
  });

  const unanswered = questions.filter((q) => q.answer === null).length;
  const isExtensionYear = year === 2025;

  // ── Real computed draft tax numbers (TY2025-only engine) + gap detection ───
  let taxDraft: SerializedTaxDraft | null = null;
  let taxComputeError: string | null = null;
  let scheduleCDataMissing = false;
  let buildGaps: string[] = [];

  if (year === 2025) {
    const resolved = await buildPersonalTaxComputeInput(year);
    if ("error" in resolved) {
      taxComputeError = resolved.error;
    } else {
      taxDraft = serializeTaxComputeResult(computePersonalTaxReturn(resolved.input));
      scheduleCDataMissing = resolved.scheduleCDataMissing;
      buildGaps = resolved.buildGaps;
    }
  }

  // Cheap, pure, scans all documents regardless of tax year — matches
  // findUnparseableExtractions's own existing all-years scan design; a
  // mistagged document is a data-quality issue independent of which year's
  // workspace is open. Enriched with createdAt (not part of
  // findUnparseableExtractions's own return shape) so TaxDraftNumbers can
  // render "uploaded {date}" without a second query.
  // Effective values (owner corrections overlaid, verified-else-AI) - the same
  // loader boundary buildPersonalTaxComputeInput and the Forms page use.
  const unparseableExtractions = findUnparseableExtractions(
    allDocs.map((d) => {
      const resolved = resolveTaxDocForCompute(d);
      return {
        id: d.id,
        docType: d.docType,
        taxYear: d.taxYear,
        extractionStatus: d.extractionStatus,
        extractionData: resolved.extractionData,
      };
    })
  );
  const allDocsById = new Map(allDocs.map((d) => [d.id, d]));
  const mistaggedDocs = unparseableExtractions.map((doc) => ({
    id: doc.id,
    docType: doc.docType,
    taxYear: doc.taxYear,
    createdAt: (allDocsById.get(doc.id)?.createdAt ?? new Date(0)).toISOString(),
  }));

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link href="/tax" className="hover:underline">Tax Workspaces</Link>
            <span>/</span>
            <span>Personal {year}</span>
          </div>
          <h1 className="text-2xl font-semibold">Personal Taxes — {year}</h1>
          <p className="text-sm text-muted-foreground">
            {isExtensionYear
              ? "Extension filed & accepted by the IRS — extended deadline October 15, 2026 (confirm with CPA)."
              : "Federal + CT state return."}{" "}
            All outputs are drafts for your CPA to review.
          </p>
        </div>

        {isExtensionYear && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <p className="font-medium">Extension note</p>
            <p className="mt-0.5">
              The IRS extension moved your <strong>filing</strong> deadline to October 15, 2026 — it did
              NOT move the <strong>payment</strong> deadline. If a balance was due for {year}, interest has
              been accruing since April 15, {year + 1}. The review below quantifies where you stand.
            </p>
          </div>
        )}

        <PersonalTaxClient
          workspaceId={workspaceId}
          entityId={workspace.entityId}
          taxYear={year}
          status={workspace.status}
          deadline={workspace.deadline?.toISOString() ?? null}
          questions={questions.map((q) => ({
            id: q.id,
            key: q.key,
            category: q.category,
            question: q.question,
            options: q.options as { value: string; label: string; note: string }[] | null,
            answer: q.answer as string | null,
            answeredAt: q.answeredAt?.toISOString() ?? null,
          }))}
          documents={docs.map((d) => ({
            id: d.id,
            docType: d.docType,
            documentName: d.documentName,
            notes: d.notes,
            extractionStatus: d.extractionStatus,
            createdAt: d.createdAt.toISOString(),
            subjectType: d.subjectType,
            subjectUserId: d.subjectUserId,
            issuerName: d.issuerName,
            suggestedIssuer: suggestIssuerFromExtraction(d.docType, resolveTaxDocForCompute(d).extractionData),
            extraction: describeDocumentRow(d),
          }))}
          otherYearDocs={otherYearDocs.map((d) => ({
            id: d.id,
            docType: d.docType,
            documentName: d.documentName,
            notes: d.notes,
            taxYear: d.taxYear,
            createdAt: d.createdAt.toISOString(),
            subjectType: d.subjectType,
            subjectUserId: d.subjectUserId,
            issuerName: d.issuerName,
          }))}
          people={people}
          opportunities={baseOps}
          refundObjective={REFUND_OBJECTIVE_STATEMENT}
          unansweredCount={unanswered}
          taxDraft={taxDraft}
          taxComputeError={taxComputeError}
          scheduleCDataMissing={scheduleCDataMissing}
          buildGaps={buildGaps}
          mistaggedDocs={mistaggedDocs}
        />
      </div>
    </AppShell>
  );
}