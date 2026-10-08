import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { YearStatusNotice } from "@/components/tax/year-status-notice";
import { PrintButton } from "@/components/tax/forms/print-button";
import { ReturnCsvButton } from "@/components/tax/forms/return-csv-button";
import { ReturnSheet } from "@/components/tax/forms/return-sheet";
import { buildTy2025ReturnWithOverrides } from "@/lib/tax2025-overrides-build";
import { SHEET_DRAFT_LABEL, SHEET_SUPPORTED_YEAR } from "@/lib/tax2025-sheet";
import { loadSheet } from "@/lib/tax2025-sheet-load";
import { linkContextForSheet } from "@/lib/tax-review-server";

interface PageProps {
  params: Promise<{ year: string }>;
}

// The TY2025 RETURN REVIEW SHEET: a printable, read-only computed DRAFT (the owner is the
// preparer of record). Auth is checked HERE, before anything is loaded (lib/tax2025-build.ts
// has no auth of its own), and only the plain-JSON sheet model is handed to the components:
// never the engine's facts, the resolved inputs or any raw document extraction.
// Stays inside AppShell (that is where the "2FA not verified" redirect lives); the print
// stylesheet in app/globals.css hides the chrome for #return-sheet only.
export default async function TaxReturnSheetPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { year: yearStr } = await params;
  const year = Number(yearStr);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) notFound();

  // The ONE loader that applies the recorded owner overrides (fail-closed: unreadable overrides show an error, never the un-overridden return).
  const loaded = year === SHEET_SUPPORTED_YEAR ? await loadSheet(year, { build: buildTy2025ReturnWithOverrides }) : null;

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div id="return-sheet" className="space-y-4">
        <YearStatusNotice year={year} />
        <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Link href="/tax" className="hover:underline">
              Tax Workspaces
            </Link>
            <span>/</span>
            <Link href={`/tax/forms/${year}` as Route} className="hover:underline">
              Tax Forms {year}
            </Link>
            <span>/</span>
            <span>Return review sheet</span>
          </div>
          {loaded?.kind === "ok" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/tax/forms/${year}/final-review` as Route}
                className="inline-flex min-h-11 items-center rounded-md border border-primary/40 px-4 text-sm font-medium text-primary hover:bg-primary/10"
                data-testid="sheet-final-review-link"
              >
                Final review and approval
              </Link>
              <ReturnCsvButton year={year} />
              <PrintButton />
            </div>
          ) : null}
        </div>

        {loaded === null || loaded.kind === "unsupported_year" ? (
          <div className="space-y-2 rounded-lg border p-4">
            <h1 className="text-lg font-semibold">Return review sheet - {year}</h1>
            <p className="text-sm">
              The return engine is TY{SHEET_SUPPORTED_YEAR} only, so there is no review sheet for {year}.
            </p>
            <Link href={`/tax/forms/${SHEET_SUPPORTED_YEAR}/return` as Route} className="text-sm text-primary hover:underline">
              Open the {SHEET_SUPPORTED_YEAR} review sheet
            </Link>
          </div>
        ) : loaded.kind === "error" ? (
          <div className="space-y-2 rounded-lg border border-red-300 bg-red-50 p-4" role="alert">
            <p className="text-sm font-semibold">{SHEET_DRAFT_LABEL}</p>
            <p className="text-sm">{loaded.message}</p>
          </div>
        ) : (
          <ReturnSheet model={loaded.model} links={linkContextForSheet(loaded.model)} />
        )}
      </div>
    </AppShell>
  );
}
