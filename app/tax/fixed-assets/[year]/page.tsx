import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { YearStatusNotice } from "@/components/tax/year-status-notice";
import { loadYearCloseStates } from "@/lib/tax-year-close-store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadFixedAssetsPage } from "@/lib/fixed-assets-build";
import { uncountedEntriesNote } from "@/lib/fixed-assets";
import { MAX_LOG_YEAR, MIN_LOG_YEAR } from "@/lib/tax-log-dates";
import { FixedAssetForm } from "@/components/fixed-assets/fixed-asset-form";
import { FixedAssetTable } from "@/components/fixed-assets/fixed-asset-table";
import { NoneConfirmation } from "@/components/tax/none-confirmation";

interface PageProps {
  params: Promise<{ year: string }>;
}

// Read-only render: the page never writes while loading. Writes happen only
// through the fixed-asset actions and the none-confirmation buttons.
export default async function TaxFixedAssetsPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { year: yearStr } = await params;
  const year = Number(yearStr);
  if (!Number.isInteger(year) || year < MIN_LOG_YEAR || year > MAX_LOG_YEAR) notFound();

  const view = await loadFixedAssetsPage(year);
  // Filed years get a check mark on the chip (soft label, fail-soft read; nothing is blocked).
  const closeLoad = await loadYearCloseStates();
  const closedYears = new Set(
    closeLoad.state === "ok" ? [...closeLoad.byYear.values()].filter((s) => s.status === "closed").map((s) => s.taxYear) : []
  );

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <YearStatusNotice year={year} />
        <div>
          <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
            <Link href={"/tax" as Route} className="hover:underline">
              Tax Workspaces
            </Link>
            <span>/</span>
            <span>Fixed assets {year}</span>
          </div>
          <h1 className="text-2xl font-semibold">Fixed-asset register — {year}</h1>
          <p className="text-sm text-muted-foreground">
            Equipment and property you need for Form 4562, Schedule C line 13 and Schedule E line 18. An asset
            counts for {year} if it was placed in service in {year} or earlier.
          </p>
          <p className="mt-2 rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
            Recorded inputs only. This app does not calculate depreciation, choose a MACRS class, or decide Section 179 /
            bonus depreciation — you review each entry for Form 4562 and Schedule E line 18.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {view.years.map((y) => (
              <Link
                key={y}
                href={`/tax/fixed-assets/${y}` as Route}
                className={`rounded-full border px-3 py-1 text-xs ${
                  y === year ? "bg-primary text-primary-foreground" : "hover:bg-accent"
                }`}
              >
                {closedYears.has(y) ? `✓ ${y}` : y}
              </Link>
            ))}
            <Link href={`/tax/forms/${year}` as Route} className="ml-2 text-xs text-primary hover:underline">
              Back to the {year} Tax Forms page →
            </Link>
          </div>
        </div>

        {view.sections.length === 0 && (
          <p className="text-sm text-destructive">No business entity (EK Consulting / Sudden Valley) was found.</p>
        )}

        {view.sections.map((section) => (
          <section key={section.entityId} className="space-y-3">
            <h2 className="text-lg font-semibold">{section.entityName}</h2>
            <NoneConfirmation
              taxYear={year}
              questionKey={section.noneQuestionKey}
              confirmed={section.noneConfirmed}
              hasEntries={section.lineSatisfiedByEntries}
              noneLabel={`No depreciable ${section.entityName} assets`}
              entriesLabel="assets"
              uncountedNote={
                section.rows.length > 0 && !section.lineSatisfiedByEntries
                  ? uncountedEntriesNote(section.slug === "sudden-valley", year)
                  : undefined
              }
            />
            <Card>
              <CardContent className="p-0">
                <FixedAssetTable
                  rows={section.rows}
                  year={year}
                  entityId={section.entityId}
                  entityLabel={section.entityName}
                  defaultRealProperty={section.defaultRealProperty}
                  documents={section.documents}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Add an asset — {section.entityName}</CardTitle>
              </CardHeader>
              <CardContent>
                <FixedAssetForm
                  entityId={section.entityId}
                  entityLabel={section.entityName}
                  year={year}
                  defaultRealProperty={section.defaultRealProperty}
                  documents={section.documents}
                />
              </CardContent>
            </Card>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
