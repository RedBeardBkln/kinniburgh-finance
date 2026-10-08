import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { CarryForwardReview } from "@/components/tax/facts/carry-forward-review";
import { buildCarryScreen } from "@/lib/tax-facts/carry-screen";
import { carryTargetContext, carryTargetYears, checkCarryTarget } from "@/lib/tax-facts/carry-target";
import { MIGRATION_MISSING_MESSAGE } from "@/lib/tax-facts/format";
import { loadTaxFacts } from "@/lib/tax-facts-store";

interface PageProps {
  params: Promise<{ year: string }>;
}

// Read-only render: the page never writes while loading. Writes happen only through reconfirmTaxFact and
// changeTaxFactForCarry (each starts with requireAuth() and refuses TY2025 and earlier). Static segments on purpose:
// /tax/facts/carry/<year> never falls into the dynamic app/tax/[workspaceId] route. Nothing here feeds the TY2025 return.
export default async function TaxFactsCarryPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { year: yearStr } = await params;
  if (!/^\d{4}$/.test(yearStr)) notFound();
  const year = Number(yearStr);

  const ctx = carryTargetContext(null);
  const target = checkCarryTarget(year, ctx);
  const years = carryTargetYears(ctx);

  const header = (
    <div>
      <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
        <Link href={"/tax" as Route} className="hover:underline">
          Tax Workspaces
        </Link>
        <span>/</span>
        <Link href={"/tax/facts" as Route} className="hover:underline">
          Facts
        </Link>
        <span>/</span>
        <span>Carry forward</span>
      </div>
      <h1 className="text-2xl font-semibold">Carry facts into TY{year}</h1>
      <p className="text-sm text-muted-foreground">
        Go through the facts you have told the app and carry each one into the new tax year, one fact at a time. Nothing is
        confirmed for you, and nothing is ever deleted: each confirmation or change adds a new version.
      </p>
    </div>
  );

  if (!target.ok) {
    return (
      <AppShell userName={session.user.name ?? undefined}>
        <div className="space-y-6">
          {header}
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{target.message}</p>
          <Link href={"/tax/facts" as Route} className="text-sm text-blue-700 hover:underline">
            Back to the Owner-confirmed facts page
          </Link>
        </div>
      </AppShell>
    );
  }

  const load = await loadTaxFacts();

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        {header}
        {load.state === "table_missing" && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">{MIGRATION_MISSING_MESSAGE}</p>
        )}
        {load.state === "no_entity" && (
          <p className="text-sm text-destructive">The Personal entity was not found, so facts cannot be shown.</p>
        )}
        {load.state === "error" && (
          <p className="text-sm text-destructive">The facts could not be loaded. Nothing was changed. Try again shortly.</p>
        )}
        {load.state === "ok" && (
          <>
            {load.skipped > 0 && (
              <p className="text-xs text-destructive">
                {load.skipped} stored version{load.skipped === 1 ? "" : "s"} could not be read and {load.skipped === 1 ? "is" : "are"} not shown.
              </p>
            )}
            {load.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No facts are recorded yet, so there is nothing to carry.{" "}
                <Link href={"/tax/facts" as Route} className="text-blue-700 hover:underline">
                  Go to the Owner-confirmed facts page
                </Link>{" "}
                to load or add facts.
              </p>
            ) : (
              <CarryForwardReview screen={buildCarryScreen(load.rows, year)} years={years} />
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
