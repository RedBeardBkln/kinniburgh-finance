import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { auth } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { currentPeriodNY, isValidPeriod } from "@/lib/month-spend";
import { loadMonthReport } from "@/lib/month-report-build";
import { buildMonthlyReport, periodLabel, shiftPeriod } from "@/lib/personal-reports";
import { PrintReportButton } from "@/components/reports/print-report-button";
import { MonthlySheet } from "@/components/reports/monthly-sheet";

export const metadata = { title: "Month-end summary" };

interface PageProps {
  searchParams: Promise<{ period?: string }>;
}

export default async function MonthlyReportPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const now = new Date();
  const currentPeriod = currentPeriodNY(now);
  const params = await searchParams;
  // Default: the last complete month. ?period=YYYY-MM picks another (the current month is allowed and marked partial).
  const requested = params.period;
  const period = requested && isValidPeriod(requested) && requested <= currentPeriod ? requested : shiftPeriod(currentPeriod, -1);
  const isCurrentPeriod = period === currentPeriod;
  const label = periodLabel(period);
  const prev = shiftPeriod(period, -1);
  const next = shiftPeriod(period, 1);
  const href = (p: string) => `/personal/reports/monthly?period=${p}` as Route;

  const entity = await getEntityBySlug("personal");
  const loaded = entity
    ? await loadMonthReport({ entityId: entity.id, bucket: "personal", period, periodLabel: label, isCurrentPeriod, now, withOverview: false })
    : { drill: null, overview: null };
  const report = loaded.drill ? buildMonthlyReport(loaded.drill) : null;
  const printedOn = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" }).format(now);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
          <div>
            <Link href={"/personal/reports" as Route} className="text-sm text-primary hover:underline">
              ← Reports
            </Link>
            <h1 className="text-2xl font-semibold">Month-end summary</h1>
            <p className="text-sm text-muted-foreground">Personal, {label}. Prints on two Letter pages: Primary Checking first, then the other accounts.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href={href(prev)} className="inline-flex min-h-11 items-center gap-1 rounded-md border px-3 text-sm hover:bg-muted">
              <ChevronLeft className="h-4 w-4" />
              {periodLabel(prev)}
            </Link>
            {next <= currentPeriod && (
              <Link href={href(next)} className="inline-flex min-h-11 items-center gap-1 rounded-md border px-3 text-sm hover:bg-muted">
                {periodLabel(next)}
                <ChevronRight className="h-4 w-4" />
              </Link>
            )}
            <PrintReportButton />
          </div>
        </div>

        {report ? (
          <MonthlySheet report={report} printedOn={printedOn} />
        ) : (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            The month&apos;s numbers are unavailable right now, so the report cannot be built. Try again in a moment.
          </p>
        )}
      </div>
    </AppShell>
  );
}
