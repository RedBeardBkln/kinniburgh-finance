import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { currentPeriodNY } from "@/lib/month-spend";
import { loadMonthReport } from "@/lib/month-report-build";
import { loadUpcomingLedger } from "@/lib/upcoming-ledger-build";
import { toCents } from "@/lib/dashboard-drill-build";
import { buildWeeklyReport, nyCalendarDay, periodLabel } from "@/lib/personal-reports";
import { PrintReportButton } from "@/components/reports/print-report-button";
import { WeeklySheet, type ComingUp } from "@/components/reports/weekly-sheet";

export const metadata = { title: "Weekly check-in" };


const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default async function WeeklyReportPage() {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const now = new Date();
  const entity = await getEntityBySlug("personal");
  const period = currentPeriodNY(now);
  const today = nyCalendarDay(now);
  const label = periodLabel(period);

  const loaded = entity
    ? await loadMonthReport({ entityId: entity.id, bucket: "personal", period, periodLabel: label, isCurrentPeriod: true, now, withOverview: true })
    : { drill: null, overview: null };
  const report = loaded.drill ? buildWeeklyReport(loaded.drill, loaded.overview, today) : null;

  // Coming up: the Upcoming ledger's counted outflows for the next 7 days (fail-soft: a failed read hides the box).
  let comingUp: { rows: ComingUp[]; totalCents: number; more: number } | null = null;
  if (entity) {
    try {
      const { ledger } = await loadUpcomingLedger({ entityId: entity.id, days: 7, now });
      const outflows = ledger.items.filter((i) => (i.kind === "bill" || i.kind === "card") && i.date !== null);
      const rows = outflows.slice(0, 6).map((i) => ({
        key: i.id,
        day: i.date ? `${MONTHS[i.date.getUTCMonth()]} ${i.date.getUTCDate()}` : "",
        label: i.label,
        cents: i.amount && i.amountStatus === "known" ? -toCents(i.amount) : null,
        estimate: i.tier === "estimated",
      }));
      comingUp = { rows, totalCents: toCents(ledger.totals.outflow), more: Math.max(0, outflows.length - rows.length) };
    } catch (err) {
      console.error("Report upcoming unavailable", err instanceof Error ? err.name : "UnknownError");
    }
  }

  const printedOn = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(now);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
          <div>
            <Link href={"/personal/reports" as Route} className="text-sm text-primary hover:underline">
              ← Reports
            </Link>
            <h1 className="text-2xl font-semibold">Weekly check-in</h1>
            <p className="text-sm text-muted-foreground">Personal, {label}, as of today. Prints on one Letter page.</p>
          </div>
          <PrintReportButton />
        </div>

        {report ? (
          <WeeklySheet report={report} printedOn={printedOn} period={period} comingUp={comingUp} />
        ) : (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            The month&apos;s numbers are unavailable right now, so the report cannot be built. Try again in a moment.
          </p>
        )}
      </div>
    </AppShell>
  );
}
