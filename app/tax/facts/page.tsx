import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { AddFactButton } from "@/components/tax/facts/fact-row-actions";
import { FactsBrowser } from "@/components/tax/facts/facts-browser";
import { SeedFactsButton } from "@/components/tax/facts/seed-facts-button";
import { defaultCarryTarget, carryTargetContext } from "@/lib/tax-facts/carry-target";
import { FACTS_CARRY_STATUS, FACTS_PAGE_HONESTY, MIGRATION_MISSING_MESSAGE } from "@/lib/tax-facts/format";
import { groupFacts } from "@/lib/tax-facts/group";
import { TAX_FACTS_SEED_TY2025 } from "@/lib/tax-facts/seed-ty2025";
import { loadTaxFacts } from "@/lib/tax-facts-store";

// Read-only render: the page never writes while loading. Writes happen only through the actions in
// actions/tax-facts.ts (each starts with requireAuth()). This is a static segment on purpose: without it /tax/facts
// would fall into the dynamic app/tax/[workspaceId] route.
export default async function TaxFactsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const load = await loadTaxFacts();

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
            <Link href={"/tax" as Route} className="hover:underline">
              Tax Workspaces
            </Link>
            <span>/</span>
            <span>Facts</span>
          </div>
          <h1 className="text-2xl font-semibold">Owner-confirmed facts</h1>
          <p className="text-sm text-muted-foreground">
            The facts you have told the app about the household return, kept so they can be recalled and, on the carry
            screen, confirmed again for a new year one fact at a time. Each shows where it came from, the tax year you
            confirmed it for, and its full history. Changing a fact adds a new version; nothing is ever deleted.
          </p>
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {FACTS_PAGE_HONESTY} {FACTS_CARRY_STATUS}
          </p>
        </div>

        {load.state === "table_missing" && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {MIGRATION_MISSING_MESSAGE}
          </p>
        )}
        {load.state === "no_entity" && (
          <p className="text-sm text-destructive">The Personal entity was not found, so facts cannot be shown.</p>
        )}
        {load.state === "error" && (
          <p className="text-sm text-destructive">The facts could not be loaded. Nothing was changed. Try again shortly.</p>
        )}

        {load.state === "ok" && (
          <>
            {load.rows.length > 0 &&
              (() => {
                const carryYear = defaultCarryTarget(carryTargetContext(null));
                return (
                  <Link
                    href={`/tax/facts/carry/${carryYear}` as Route}
                    className="block rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 hover:bg-blue-100"
                  >
                    Start the TY{carryYear} carry-forward review: confirm, change or answer each fact for the new year, one at a
                    time.
                  </Link>
                );
              })()}
            {(() => {
              const have = new Set(load.rows.map((r) => r.factKey));
              const missing = TAX_FACTS_SEED_TY2025.filter((s) => !have.has(s.factKey)).length;
              return (
                <div className="flex flex-wrap items-center gap-3">
                  <SeedFactsButton total={TAX_FACTS_SEED_TY2025.length} missing={missing} />
                  <AddFactButton />
                </div>
              );
            })()}
            {load.skipped > 0 && (
              <p className="text-xs text-destructive">
                {load.skipped} stored version{load.skipped === 1 ? "" : "s"} could not be read and {load.skipped === 1 ? "is" : "are"} not shown.
              </p>
            )}
            {load.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No facts are recorded yet. Load the TY2025 facts (taken from the owner-confirmed list in specs/12) or add one.
              </p>
            ) : (
              <FactsBrowser grouped={groupFacts(load.rows)} />
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
