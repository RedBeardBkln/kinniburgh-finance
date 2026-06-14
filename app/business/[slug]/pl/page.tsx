import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell, BUCKET_ENTITY_NAMES, type BucketSlug } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import { computePL } from "@/lib/reports";
import type { Route } from "next";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ year?: string; from?: string; to?: string }>;
}

const LABEL_MAP: Partial<Record<BucketSlug, string>> = {
  "sudden-valley": "Sudden Valley PM",
  "ek-consulting": "EK Consulting",
  mezzo: "Mezzo",
};

export default async function PLPage({ params, searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { slug } = await params;
  const sp = await searchParams;
  const entityLabel = LABEL_MAP[slug as BucketSlug] ?? slug;
  const entityName = BUCKET_ENTITY_NAMES[slug as BucketSlug];

  if (!entityName) redirect("/business" as Route);

  const entity = await db.entity.findFirst({ where: { name: entityName } });
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

        <p className="text-xs text-muted-foreground">
          Only GL-coded transactions are included. Confirm all figures with your CPA — this is not tax advice.
        </p>
      </div>
    </AppShell>
  );
}

function fmtCurrency(d: Prisma.Decimal): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(d.toNumber());
}
