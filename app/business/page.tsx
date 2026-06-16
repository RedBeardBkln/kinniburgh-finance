import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import { computePL } from "@/lib/reports";
import type { Route } from "next";

const BUSINESS_SLUGS = [
  { slug: "sudden-valley", entityName: "Sudden Valley Property Management, LLC", label: "Sudden Valley PM" },
  { slug: "ek-consulting", entityName: "Eric Kinniburgh Consulting, LLC", label: "EK Consulting" },
  { slug: "mezzo", entityName: "Mezzo", label: "Mezzo" },
] as const;

export default async function BusinessPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));

  const entities = await db.entity.findMany({
    where: { name: { in: BUSINESS_SLUGS.map((b) => b.entityName) } },
    include: {
      taxWorkspaces: {
        orderBy: { taxYear: "desc" },
        take: 1,
      },
    },
  });

  const entityMap = new Map(entities.map((e) => [e.name, e]));

  const plResults = await Promise.all(
    BUSINESS_SLUGS.map(async (b) => {
      const entity = entityMap.get(b.entityName);
      if (!entity) return null;
      return { slug: b.slug, pl: await computePL(entity.id, monthStart, monthEnd) };
    })
  );
  const plMap = new Map(plResults.filter(Boolean).map((r) => [r!.slug, r!.pl]));

  const currentYear = now.getUTCFullYear();

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Business Overview</h1>
          <p className="text-sm text-muted-foreground">
            {now.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "America/New_York" })} · three entities
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {BUSINESS_SLUGS.map((b) => {
            const entity = entityMap.get(b.entityName);
            const pl = plMap.get(b.slug);
            const workspace = entity?.taxWorkspaces[0];
            const net = pl?.netIncome ?? new Prisma.Decimal(0);
            const isPositive = net.gte(0);

            return (
              <Card key={b.slug}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">{b.label}</CardTitle>
                    {workspace && (
                      <Badge
                        variant={workspace.status === "extended" ? "destructive" : workspace.status === "filed" ? "outline" : "secondary"}
                        className="shrink-0 text-xs"
                      >
                        {workspace.status === "extended"
                          ? `${workspace.taxYear} Extended`
                          : workspace.status === "filed"
                          ? `${workspace.taxYear} Filed`
                          : `${workspace.taxYear} In Progress`}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Month P&L summary */}
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">This month</p>
                    <div className="grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Income</p>
                        <p className="font-medium text-green-600">{formatDecimal(pl?.totalIncome)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Expenses</p>
                        <p className="font-medium text-destructive">{formatDecimal(pl?.totalExpenses)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Net</p>
                        <p className={`font-semibold ${isPositive ? "text-green-600" : "text-destructive"}`}>
                          {isPositive ? "" : "−"}{formatDecimal(net.abs())}
                        </p>
                      </div>
                    </div>
                    {(!pl || (pl.incomeLines.length === 0 && pl.expenseLines.length === 0)) && (
                      <p className="text-xs text-muted-foreground italic">No GL-coded transactions this month</p>
                    )}
                  </div>

                  {/* Action links */}
                  <div className="flex flex-col gap-1.5">
                    <Link
                      href={`/business/${b.slug}/pl?year=${currentYear}` as Route}
                      className="text-sm text-primary hover:underline"
                    >
                      P&amp;L Report →
                    </Link>
                    <Link
                      href={`/business/${b.slug}/balance-sheet` as Route}
                      className="text-sm text-primary hover:underline"
                    >
                      Balance Sheet →
                    </Link>
                    <Link
                      href={`/business/${b.slug}/mileage` as Route}
                      className="text-sm text-primary hover:underline"
                    >
                      Mileage Log →
                    </Link>
                    <Link
                      href={`/business/${b.slug}/revenue` as Route}
                      className="text-sm text-primary hover:underline"
                    >
                      Revenue →
                    </Link>
                    <Link
                      href={`/business/${b.slug}/vendors` as Route}
                      className="text-sm text-primary hover:underline"
                    >
                      Vendors →
                    </Link>
                    <Link
                      href={`/business/${b.slug}/cash-flow` as Route}
                      className="text-sm text-primary hover:underline"
                    >
                      Cash Flow →
                    </Link>
                    <Link
                      href={`/business/${b.slug}/gl` as Route}
                      className="text-sm text-primary hover:underline"
                    >
                      GL Codes &amp; Coding Queue →
                    </Link>
                    {workspace && (
                      <Link
                        href={`/tax/${workspace.id}` as Route}
                        className="text-sm text-primary hover:underline"
                      >
                        Tax Workspace →
                      </Link>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <p className="text-xs text-muted-foreground">
          P&amp;L figures include only GL-coded transactions. Assign GL codes via the coding queue to improve accuracy.
          Confirm all filing deadlines with your CPA — this is not tax advice.
        </p>
      </div>
    </AppShell>
  );
}

function formatDecimal(d?: Prisma.Decimal): string {
  const val = d ?? new Prisma.Decimal(0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val.toNumber());
}
