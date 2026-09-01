import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { ensurePersonalWorkspace } from "@/actions/tax-planning";
import { getTaxWorkspace } from "@/actions/tax";
import {
  baseOpportunitiesForHousehold,
  evaluateAnswers,
  formatOpportunityForDisplay,
  PERSONAL_FORM_PLAN,
  REFUND_OBJECTIVE_STATEMENT,
} from "@/lib/tax-guidance";
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

  const [questions, docs] = await Promise.all([
    db.taxQuestion.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
    }),
    db.document.findMany({
      where: { entityId: workspace.entityId, taxYear: year, archivedAt: null },
      orderBy: { createdAt: "desc" },
    }),
  ]);

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
            <a href="/tax" className="hover:underline">Tax Workspaces</a>
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
          opportunities={baseOps}
          formPlan={PERSONAL_FORM_PLAN}
          refundObjective={REFUND_OBJECTIVE_STATEMENT}
          unansweredCount={unanswered}
        />
      </div>
    </AppShell>
  );
}