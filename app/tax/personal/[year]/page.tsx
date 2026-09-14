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
} from "@/lib/tax-guidance";
import { computePersonalFormPlan } from "@/lib/tax-form-plan";
import { getEntityBySlug } from "@/lib/entity";
import { computePL } from "@/lib/reports";
import { PersonalTaxClient } from "@/components/tax/personal-tax-client";
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

  const [questions, allDocs] = await Promise.all([
    db.taxQuestion.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    }),
    db.document.findMany({
      where: { entityId: workspace.entityId, archivedAt: null },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const docs = allDocs.filter((d) => d.taxYear === year);
  const otherYearDocs = allDocs.filter((d) => d.taxYear !== year);

  // ── Inputs for the computed form-readiness plan ─────────────────────────────
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

  const [ekcEntity, svEntity, solarLoanAccount] = await Promise.all([
    getEntityBySlug("ek-consulting"),
    getEntityBySlug("sudden-valley"),
    db.account.findUnique({
      where: {
        entityId_nickname: { entityId: workspace.entityId, nickname: "Solar loan" },
        archivedAt: null,
      },
      include: { debtDetail: true },
    }),
  ]);

  const [ekcPL, svPL, ekcMileageCount] = await Promise.all([
    ekcEntity ? computePL(ekcEntity.id, yearStart, yearEnd) : Promise.resolve(null),
    svEntity ? computePL(svEntity.id, yearStart, yearEnd) : Promise.resolve(null),
    ekcEntity
      ? db.mileageEntry.count({
          where: { entityId: ekcEntity.id, archivedAt: null, date: { gte: yearStart, lte: yearEnd } },
        })
      : Promise.resolve(0),
  ]);

  const formPlan = computePersonalFormPlan({
    documents: docs.map((d) => ({
      docType: d.docType,
      extractionStatus: d.extractionStatus,
      extractionData: d.extractionData,
    })),
    questions: questions.map((q) => ({
      key: q.key,
      answer: q.answer,
      skippedReason: q.skippedReason,
    })),
    ekConsultingPL: ekcPL ? { incomeLines: ekcPL.incomeLines, expenseLines: ekcPL.expenseLines } : null,
    suddenValleyPL: svPL ? { incomeLines: svPL.incomeLines, expenseLines: svPL.expenseLines } : null,
    ekConsultingMileageCount: ekcMileageCount,
    solarLoanOriginalCostCents: solarLoanAccount?.debtDetail?.originalBalanceCents ?? null,
  });

  // Evaluate which opportunities the answers act on / exclude
  const answerMap: Record<string, unknown> = {};
  for (const q of questions) {
    answerMap[q.key] = q.answer;
  }
  const { excluded, actOn } = evaluateAnswers(answerMap);

  const baseOps = baseOpportunitiesForHousehold().map((op) => {
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
          }))}
          otherYearDocs={otherYearDocs.map((d) => ({
            id: d.id,
            docType: d.docType,
            documentName: d.documentName,
            notes: d.notes,
            taxYear: d.taxYear,
            createdAt: d.createdAt.toISOString(),
          }))}
          opportunities={baseOps}
          formPlan={formPlan}
          refundObjective={REFUND_OBJECTIVE_STATEMENT}
          unansweredCount={unanswered}
        />
      </div>
    </AppShell>
  );
}