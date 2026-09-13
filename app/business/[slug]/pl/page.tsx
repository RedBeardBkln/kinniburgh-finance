import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import { computePL } from "@/lib/reports";
import { exportCpaBundle } from "@/actions/reports";
import { ExportCsvButton } from "@/components/export-csv-button";
import { TaxReservePctForm } from "@/components/business/tax-reserve-pct-form";
import { getEntityTaxReservePct } from "@/lib/settings";
import {
  getQuarterForDate,
  getQuarterBounds,
  getPriorQuarters,
  projectQuarterEndPL,
  computeTaxReserveEstimate,
  type QuarterlyPLPoint,
  type QuarterForecastConfidence,
} from "@/lib/business-quarter-forecast";
import type { Route } from "next";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ year?: string; from?: string; to?: string }>;
}

export default async function PLPage({ params, searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { slug } = await params;
  const sp = await searchParams;
  const entity = await getEntityBySlug(slug);
  const entityLabel = entity?.navLabel ?? entity?.name ?? slug;

  if (!entity) redirect("/business" as Route);

  const now = new Date();
  const currentYear = sp.year ? Number(sp.year) : now.getUTCFullYear();

  let fromDate: Date;
  let toDate: Date;
  let periodLabel: string;

  if (sp.from && sp.to) {
    fromDate = new Date(sp.from);
    toDate = new Date(sp.to);
    periodLabel = `${sp.from} – ${sp.to}`;
  } else {
    fromDate = new Date(Date.UTC(currentYear, 0, 1));
    toDate = new Date(Date.UTC(currentYear, 11, 31, 23, 59, 59));
    periodLabel = `Full Year ${currentYear}`;
  }

  const pl = await computePL(entity.id, fromDate, toDate);

  // ── Quarter-End Forecast (gated to entities with real revenue GL activity) ──
  // GlCode.type is "revenue" for business income — "income" is reserved for
  // personal-finance concepts (see lib/forecast.ts, lib/tax-guidance.ts).
  // Confirmed against the live database and fixed in lib/reports.ts's
  // computePL and prisma/seed.ts (see the gl-code-tag-mapping task).
  const hasIncomeGl = (await db.glCode.count({ where: { entityId: entity.id, type: "revenue" } })) > 0;

  let forecast: ReturnType<typeof projectQuarterEndPL> | null = null;
  let reserve: ReturnType<typeof computeTaxReserveEstimate> | null = null;
  let reservePctNumber = 0;
  let reservePctIsDefault = false;
  let forecastQuarter = "";

  if (hasIncomeGl) {
    const asOfDate = new Date();
    const quarter = getQuarterForDate(asOfDate);
    const currentBounds = getQuarterBounds(quarter);
    const priorQuarters = getPriorQuarters(quarter, 4);

    const [currentPl, priorPls] = await Promise.all([
      computePL(entity.id, currentBounds.start, asOfDate),
      Promise.all(
        priorQuarters.map(async (q) => {
          const b = getQuarterBounds(q);
          const qPl = await computePL(entity.id, b.start, b.end);
          return { quarter: q, pl: qPl };
        })
      ),
    ]);

    const history: QuarterlyPLPoint[] = priorPls
      .filter(({ pl: p }) => p.incomeLines.length > 0 || p.expenseLines.length > 0)
      .map(({ quarter: q, pl: p }) => ({
        quarter: q,
        totalIncome: p.totalIncome,
        totalExpenses: p.totalExpenses,
      }));

    forecast = projectQuarterEndPL({
      quarter,
      actualToDate: { totalIncome: currentPl.totalIncome, totalExpenses: currentPl.totalExpenses },
      asOfDate,
      history,
    });

    const { pct, isDefault } = await getEntityTaxReservePct(entity.id);
    reserve = computeTaxReserveEstimate(forecast.projectedNetIncome, new Prisma.Decimal(pct));
    reservePctNumber = pct;
    reservePctIsDefault = isDefault;
    forecastQuarter = quarter;
  }

  const years = [currentYear - 1, currentYear, currentYear + 1];

  function yearUrl(y: number) {
    return `/business/${slug}/pl?year=${y}` as Route;
  }

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <Link href={"/business" as Route} className="hover:underline">Business</Link>
              <span>/</span>
              <span>{entityLabel}</span>
            </div>
            <h1 className="text-2xl font-semibold">Profit &amp; Loss</h1>
            <p className="text-sm text-muted-foreground">{periodLabel}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Year picker */}
            <div className="flex gap-1">
              {years.map((y) => (
                <Link
                  key={y}
                  href={yearUrl(y)}
                  className={`rounded-md px-3 py-1.5 text-sm border ${
                    y === currentYear && !sp.from
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-input bg-background hover:bg-accent"
                  }`}
                >
                  {y}
                </Link>
              ))}
            </div>
            <Link
              href={`/api/export/${entity.id}?year=${currentYear}` as Route}
              className="inline-flex items-center justify-center rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent"
            >
              Download CSV
            </Link>
            <ExportCsvButton
              filename={`cpa-bundle-${slug}-${currentYear}.csv`}
              action={exportCpaBundle.bind(null, entity.id, currentYear)}
              label="Export CPA bundle"
            />
          </div>
        </div>

        {/* Income */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-green-700">Income</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Code</th>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {pl.incomeLines.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                      No income transactions coded for this period
                    </td>
                  </tr>
                ) : (
                  pl.incomeLines.map((line) => (
                    <tr key={line.glCodeId} className="border-b last:border-0">
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{line.code}</td>
                      <td className="px-4 py-2">{line.name}</td>
                      <td className="px-4 py-2 text-right font-medium text-green-600">
                        {fmtCurrency(line.total)}
                      </td>
                    </tr>
                  ))
                )}
                <tr className="border-t bg-muted/30 font-semibold">
                  <td colSpan={2} className="px-4 py-2">Total Income</td>
                  <td className="px-4 py-2 text-right text-green-600">{fmtCurrency(pl.totalIncome)}</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Expenses */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-destructive">Expenses</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Code</th>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {pl.expenseLines.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                      No expense transactions coded for this period
                    </td>
                  </tr>
                ) : (
                  pl.expenseLines.map((line) => (
                    <tr key={line.glCodeId} className="border-b last:border-0">
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{line.code}</td>
                      <td className="px-4 py-2">{line.name}</td>
                      <td className="px-4 py-2 text-right font-medium text-destructive">
                        {fmtCurrency(line.total)}
                      </td>
                    </tr>
                  ))
                )}
                <tr className="border-t bg-muted/30 font-semibold">
                  <td colSpan={2} className="px-4 py-2">Total Expenses</td>
                  <td className="px-4 py-2 text-right text-destructive">{fmtCurrency(pl.totalExpenses)}</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Net */}
        <Card className={pl.netIncome.gte(0) ? "border-green-200 bg-green-50/50" : "border-destructive/30 bg-destructive/5"}>
          <CardContent className="flex items-center justify-between py-4 px-4">
            <p className="font-semibold text-base">Net Income</p>
            <p className={`text-xl font-bold ${pl.netIncome.gte(0) ? "text-green-600" : "text-destructive"}`}>
              {pl.netIncome.gte(0) ? "" : "−"}{fmtCurrency(pl.netIncome.abs())}
            </p>
          </CardContent>
        </Card>

        {/* Quarter-End Forecast */}
        {hasIncomeGl && forecast && reserve && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                Quarter-End Forecast — {quarterLabel(forecastQuarter)}
                <ConfidenceBadge confidence={forecast.confidence} />
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {forecast.daysElapsed} of {forecast.daysInQuarter} days elapsed. Projections blend
                this quarter&rsquo;s pace against recent trailing quarters — estimates, not a
                guarantee, and not tax or financial advice.
              </p>
            </CardHeader>
            <CardContent className="space-y-4 p-4 pt-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2 font-medium">Line</th>
                      <th className="py-2 font-medium text-right">Actual to date</th>
                      <th className="py-2 font-medium text-right">Projected (quarter end)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="py-2">Income</td>
                      <td className="py-2 text-right tabular-nums">{fmtCurrency(forecast.income.actualToDate)}</td>
                      <td className="py-2 text-right tabular-nums font-medium text-green-600">
                        {forecast.confidence === "low" ? "~" : ""}
                        {fmtCurrency(forecast.income.projectedTotal)}
                      </td>
                    </tr>
                    <tr className="border-b">
                      <td className="py-2">Expenses</td>
                      <td className="py-2 text-right tabular-nums">{fmtCurrency(forecast.expenses.actualToDate)}</td>
                      <td className="py-2 text-right tabular-nums font-medium text-destructive">
                        {forecast.confidence === "low" ? "~" : ""}
                        {fmtCurrency(forecast.expenses.projectedTotal)}
                      </td>
                    </tr>
                    <tr className="font-semibold">
                      <td className="py-2">Net Income</td>
                      <td className="py-2 text-right tabular-nums">
                        {forecast.actualNetIncomeToDate.gte(0) ? "" : "−"}
                        {fmtCurrency(forecast.actualNetIncomeToDate.abs())}
                      </td>
                      <td
                        className={`py-2 text-right tabular-nums ${
                          forecast.projectedNetIncome.gte(0) ? "text-green-600" : "text-destructive"
                        }`}
                      >
                        {forecast.confidence === "low" ? "~" : ""}
                        {forecast.projectedNetIncome.gte(0) ? "" : "−"}
                        {fmtCurrency(forecast.projectedNetIncome.abs())}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    Suggested cash reserve{forecast.confidence === "low" ? " (~)" : ""}: {fmtCurrency(reserve.reserveAmount)}
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Reserve rate:</span>
                    <TaxReservePctForm entityId={entity.id} pct={reservePctNumber} isDefault={reservePctIsDefault} />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Rough cash-reserve estimate based on a flat percentage of projected net income —
                  not a computed tax liability. Doesn&rsquo;t account for tax brackets,
                  self-employment tax, deductions, or your household&rsquo;s full return. Confirm
                  the right rate and any required estimated payments with your CPA.
                </p>
                {slug === "sudden-valley" && (
                  <p className="text-xs text-muted-foreground">
                    Sudden Valley&rsquo;s chart of accounts is still a placeholder, not yet
                    reconciled against a CPA/QuickBooks export — treat these figures as rough.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <p className="text-xs text-muted-foreground">
          Only GL-coded transactions are included. Confirm all figures with your CPA — this is not tax advice.
        </p>
      </div>
    </AppShell>
  );
}

function quarterLabel(quarter: string): string {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) return quarter;
  return `Q${m[2]} ${m[1]}`;
}

function ConfidenceBadge({ confidence }: { confidence: QuarterForecastConfidence }) {
  if (confidence === "low") {
    return (
      <span className="rounded-full border border-muted-foreground/30 bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground whitespace-nowrap">
        Not enough history yet
      </span>
    );
  }
  if (confidence === "medium") {
    return (
      <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 whitespace-nowrap">
        Partial history
      </span>
    );
  }
  return (
    <span className="rounded-full border border-green-200 bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700 whitespace-nowrap">
      Full history
    </span>
  );
}

function fmtCurrency(d: Prisma.Decimal): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(d.toNumber());
}
