import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadDonationsPage } from "@/lib/donations-build";
import { NONE_CONFIRMATION_KEYS } from "@/lib/tax-none-confirmation";
import { formatCentsDisplay } from "@/lib/tax-extraction-schema";
import { MAX_LOG_YEAR, MIN_LOG_YEAR } from "@/lib/tax-log-dates";
import { DonationForm } from "@/components/donations/donation-form";
import { DonationTable } from "@/components/donations/donation-table";
import { UnlinkedReceipts } from "@/components/donations/unlinked-receipts";
import { NoneConfirmation } from "@/components/tax/none-confirmation";

interface PageProps {
  params: Promise<{ year: string }>;
}

// Read-only render: the page never writes while loading. Writes happen only
// through the donation actions and the none-confirmation buttons.
export default async function TaxDonationsPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { year: yearStr } = await params;
  const year = Number(yearStr);
  if (!Number.isInteger(year) || year < MIN_LOG_YEAR || year > MAX_LOG_YEAR) notFound();

  const view = await loadDonationsPage(year);
  const hasEntries = view.rows.length > 0;
  // New gifts default to today when the viewed year is the current one, else mid-year.
  const currentYear = new Date().getUTCFullYear();
  const defaultDate = year === currentYear ? new Date().toISOString().slice(0, 10) : `${year}-12-31`;

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
            <Link href={"/tax" as Route} className="hover:underline">
              Tax Workspaces
            </Link>
            <span>/</span>
            <span>Donations {year}</span>
          </div>
          <h1 className="text-2xl font-semibold">Donation log — {year}</h1>
          <p className="text-sm text-muted-foreground">
            Charitable gifts for the household return (Schedule A line 11). This log records what you enter and flags
            missing records; it does not calculate a deduction. Drafts for you to review — not tax advice.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {view.years.map((y) => (
              <Link
                key={y}
                href={`/tax/donations/${y}` as Route}
                className={`rounded-full border px-3 py-1 text-xs ${
                  y === year ? "bg-primary text-primary-foreground" : "hover:bg-accent"
                }`}
              >
                {y}
              </Link>
            ))}
            <Link href={`/tax/forms/${year}` as Route} className="ml-2 text-xs text-primary hover:underline">
              Back to the {year} Tax Forms page →
            </Link>
          </div>
        </div>

        {!view.personalEntityId ? (
          <p className="text-sm text-destructive">The Personal entity was not found, so donations cannot be recorded.</p>
        ) : (
          <>
            <NoneConfirmation
              taxYear={year}
              questionKey={NONE_CONFIRMATION_KEYS.donations}
              confirmed={view.noneConfirmed}
              hasEntries={hasEntries}
              noneLabel={`No charitable gifts in ${year}`}
              entriesLabel="gifts"
            />

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Logged totals</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap items-center gap-8">
                  <div>
                    <p className="text-xs text-muted-foreground">Cash gifts logged</p>
                    <p className="text-xl font-semibold tabular-nums">{formatCentsDisplay(view.totals.cashCents)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Non-cash gifts logged (stated value)</p>
                    <p className="text-xl font-semibold tabular-nums">{formatCentsDisplay(view.totals.noncashCents)}</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  These are the amounts you logged — not deduction amounts. AGI limits and whether to itemize are your
                  decisions.
                </p>
                {view.yearFlags.map((f) => (
                  <p key={f.code} className="rounded bg-purple-100 px-2 py-1 text-xs text-purple-900">
                    {f.message}
                  </p>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Gifts</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <DonationTable
                  rows={view.rows}
                  year={year}
                  personalEntityId={view.personalEntityId}
                  documents={view.documents}
                />
              </CardContent>
            </Card>

            {view.unlinkedReceipts.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    Receipts waiting to be logged ({view.unlinkedReceipts.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <p className="px-4 pb-2 text-xs text-muted-foreground">
                    Donation receipts you filed that have no gift logged yet. Adding one opens the form filled in from
                    the saved reading (your corrections win); nothing is saved until you press save.
                  </p>
                  <UnlinkedReceipts
                    receipts={view.unlinkedReceipts}
                    year={year}
                    personalEntityId={view.personalEntityId}
                  />
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Add a gift</CardTitle>
              </CardHeader>
              <CardContent>
                <DonationForm
                  defaultDate={defaultDate}
                  year={year}
                  personalEntityId={view.personalEntityId}
                  documents={view.documents}
                />
              </CardContent>
            </Card>
          </>
        )}

        <p className="text-xs text-muted-foreground">
          Record-keeping notes (IRS Pub. 526): any cash gift needs a bank record or a written communication from the
          charity; a single gift of $250 or more needs a written acknowledgment from the charity stating the amount and
          any benefits received; non-cash gifts totalling more than $500 for the year involve Form 8283 (items over $5,000
          can need an appraisal). Whether the organization qualifies, and what is deductible, are your
          decisions. Log one entry per gift.
        </p>
      </div>
    </AppShell>
  );
}
