import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { loadFormsPageData } from "@/lib/tax-forms-build";
import { buildTy2025Return } from "@/lib/tax2025-build";
import { loadSheet } from "@/lib/tax2025-sheet-load";
import type { CardConclusion } from "@/lib/tax2025-sheet-conclusions";
import { FormCard } from "@/components/tax/forms/form-card";
import { FormsSummary } from "@/components/tax/forms/forms-summary";
import { PDF_SUPPORTED_YEAR, PdfDownloadButtons } from "@/components/tax/forms/pdf-download-buttons";
import { EntityFormsSectionView } from "@/components/tax/forms/entity-forms-section";
import { YearNotice } from "@/components/tax/forms/year-notice";
import { defaultFilingTaxYear } from "@/lib/tax-default-year";

interface PageProps {
  params: Promise<{ year: string }>;
}

// Rendering is READ-ONLY: this page never creates or modifies anything while it
// loads (it does not call ensurePersonalWorkspace / ensureTaxWorkspace — see
// lib/tax-forms-build.ts). Writes happen only when the owner clicks a missing
// field's fix (answer / upload dialogs), via their own server actions.
export default async function TaxFormsPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { year: yearStr } = await params;
  const year = Number(yearStr);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) notFound();

  // For 2025 the engine's conclusions (home office, QBI, Additional Medicare, 8889, 8880, 2210,
  // Schedule 3, SE ...) are printed on the matching cards. READ-ONLY and failure-tolerant: loadSheet
  // never throws, and on any error the cards simply show no conclusion. It never touches the counters.
  const [data, workspaceYears, sheet] = await Promise.all([
    loadFormsPageData(year),
    db.taxWorkspace.findMany({ select: { taxYear: true }, distinct: ["taxYear"] }),
    year === PDF_SUPPORTED_YEAR ? loadSheet(year, { build: buildTy2025Return }) : Promise.resolve(null),
  ]);
  const conclusions: Record<string, CardConclusion> = sheet?.kind === "ok" ? sheet.conclusions : {};

  // Year chips: every workspace year + the current year (+ the one being viewed).
  const currentYear = new Date().getUTCFullYear();
  const yearSet = new Set<number>(workspaceYears.map((w) => w.taxYear));
  yearSet.add(currentYear);
  yearSet.add(year);
  const years = Array.from(yearSet).sort((a, b) => b - a);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <YearNotice viewedYear={year} defaultYear={defaultFilingTaxYear()} hrefForDefaultYear={`/tax/forms/${defaultFilingTaxYear()}`} />
        <div>
          <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
            <Link href="/tax" className="hover:underline">
              Tax Workspaces
            </Link>
            <span>/</span>
            <span>Forms {year}</span>
          </div>
          <h1 className="text-2xl font-semibold">Tax Forms — {year}</h1>
          <p className="text-sm text-muted-foreground">
            The federal and Connecticut forms the system can determine for the household and each business entity, why
            each is needed, which uploaded documents feed it, and how ready it is. Anything the system cannot determine
            is marked &quot;Needs CPA input&quot; — it is never asserted as required. Drafts for your CPA — not tax
            advice.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {years.map((y) => (
              <Link
                key={y}
                href={`/tax/forms/${y}` as Route}
                className={`rounded-full border px-3 py-1 text-xs ${
                  y === year ? "bg-primary text-primary-foreground" : "hover:bg-accent"
                }`}
              >
                {y}
              </Link>
            ))}
            <Link
              href={`/tax/forms/${year}/cpa-summary` as Route}
              className="ml-2 rounded-full border border-primary/40 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/10"
            >
              CPA summary
            </Link>
          </div>
        </div>

        {year === PDF_SUPPORTED_YEAR ? <PdfDownloadButtons year={year} /> : null}

        <FormsSummary data={data} />

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Federal — {data.householdLabel}</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {data.federal.map((entry) => (
              <FormCard key={entry.id} entry={entry} taxYear={year} conclusion={conclusions[entry.id]} />
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Connecticut — household</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {data.connecticut.map((entry) => (
              <FormCard key={entry.id} entry={entry} taxYear={year} conclusion={conclusions[entry.id]} />
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Needs CPA input</h2>
            <p className="text-sm text-muted-foreground">
              Forms and credits the guidance mentions but the system cannot determine from the data it holds. Listed so
              nothing is forgotten — not asserted as required.
            </p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {data.needsCpaInput.map((entry) => (
              <FormCard key={entry.id} entry={entry} taxYear={year} conclusion={conclusions[entry.id]} />
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Business entities</h2>
            <p className="text-sm text-muted-foreground">
              {data.entities.some((section) => section.slug === "sudden-valley")
                ? "Grouped under the household return. EK Consulting and Sudden Valley activity is reported on the household forms above unless the CPA says otherwise."
                : "Grouped under the household return. EK Consulting activity is reported on the household forms above unless the CPA says otherwise."}
            </p>
          </div>
          {data.entities.map((section) => (
            <EntityFormsSectionView key={section.entityId} section={section} taxYear={year} />
          ))}
        </section>

        <p className="text-xs text-muted-foreground">
          {`This page only reads existing data. Applicability shown here comes from the system's configuration, your
          documents and planning answers — your CPA makes the final determination.`}
        </p>
      </div>
    </AppShell>
  );
}
