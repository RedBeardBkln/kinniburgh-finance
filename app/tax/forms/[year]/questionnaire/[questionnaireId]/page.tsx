import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { QuestionnaireRunner } from "@/components/tax/forms/questionnaire-runner";
import { loadQuestionnairePage } from "@/lib/tax-questionnaire-build";
import { renderCopy } from "@/lib/tax-questionnaire";
import { SOURCES } from "@/lib/tax-questionnaire-content";
import { YearNotice } from "@/components/tax/forms/year-notice";
import { AnchorHighlight } from "@/components/tax/anchor-highlight";
import { defaultFilingTaxYear } from "@/lib/tax-default-year";

interface PageProps {
  params: Promise<{ year: string; questionnaireId: string }>;
  searchParams: Promise<{ entity?: string }>;
}

// READ-ONLY while rendering: the loader never creates a workspace or any row.
// Answers are written only by the server actions in actions/tax-questionnaires.ts.
export default async function TaxQuestionnairePage({ params, searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { year: yearStr, questionnaireId } = await params;
  const { entity } = await searchParams;
  const year = Number(yearStr);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) notFound();

  const page = await loadQuestionnairePage(year, questionnaireId, typeof entity === "string" ? entity : null);
  if (!page) notFound();

  const { def, ctx } = page;
  const introSources = (def.introSources ?? []).filter((id) => id in SOURCES);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-5">
        <AnchorHighlight />
        <YearNotice
          viewedYear={year}
          defaultYear={defaultFilingTaxYear()}
          hrefForDefaultYear={`/tax/forms/${defaultFilingTaxYear()}/questionnaire/${questionnaireId}${typeof entity === "string" ? `?entity=${encodeURIComponent(entity)}` : ""}`}
        />
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Link href="/tax" className="hover:underline">
              Tax Workspaces
            </Link>
            <span>/</span>
            <Link href={`/tax/forms/${year}` as Route} className="hover:underline">
              Forms {year}
            </Link>
            <span>/</span>
            <span>Questionnaire</span>
          </div>
          <h1 className="text-2xl font-semibold">{renderCopy(def.title, ctx)}</h1>
          <p className="text-sm text-muted-foreground">
            {page.formName}
            {page.entityName ? ` - ${page.entityName}` : ""} - tax year {year}
          </p>
          <p className="mt-2 text-sm">
            {renderCopy(def.intro, ctx)}
            {introSources.length > 0 && (
              <>
                {" "}
                <span className="text-xs text-muted-foreground">
                  Source:{" "}
                  {introSources.map((id, i) => (
                    <span key={id}>
                      {i > 0 && "; "}
                      <a href={SOURCES[id]!.url} target="_blank" rel="noreferrer" className="underline">
                        {SOURCES[id]!.title}
                      </a>
                    </span>
                  ))}
                </span>
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Facts for your return - not tax advice. Your answers are facts the return is computed from; you decide whether a form is
            required. A few answers are shared with the Planning screen and are marked.
            {year !== def.sourcesTaxYear &&
              ` IRS references on this page are from the ${def.sourcesTaxYear} instructions; confirm for ${year}.`}
          </p>
        </div>

        <QuestionnaireRunner
          year={year}
          def={def}
          entityId={page.entityId}
          ctx={ctx}
          effective={page.effective}
          bound={page.bound}
          prefill={page.prefill}
          note={page.note}
          noteMeta={page.noteMeta}
          stale={page.stale}
          userNames={page.userNames}
          meId={session.user.id}
          planningLinks={page.planningLinks}
        />

        <nav className="flex flex-wrap items-center gap-3 border-t pt-4 text-sm" aria-label="Questionnaire navigation">
          <Link href={`/tax/forms/${year}` as Route} className="rounded-md border px-3 py-2 hover:bg-accent">
            Back to forms
          </Link>
          {page.prev && (
            <Link href={page.prev.href as Route} className="rounded-md border px-3 py-2 hover:bg-accent">
              Previous: {page.prev.label}
            </Link>
          )}
          {page.next && (
            <Link href={page.next.href as Route} className="rounded-md border px-3 py-2 hover:bg-accent">
              Next: {page.next.label}
            </Link>
          )}
          <Link href={`/tax/forms/${year}/cpa-summary` as Route} className="rounded-md border px-3 py-2 hover:bg-accent">
            Open the questions and answers summary
          </Link>
        </nav>
      </div>
    </AppShell>
  );
}
