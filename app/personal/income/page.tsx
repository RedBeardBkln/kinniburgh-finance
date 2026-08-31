import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PaystubUploadCard } from "@/components/income/paystub-upload-card";
import { IncomeSourcesCard } from "@/components/income/income-sources-card";
import type { LabeledAmount } from "@/lib/paystub-extract";
import Link from "next/link";
import type { Route } from "next";

interface PageProps {
  searchParams: Promise<{ bucket?: string }>;
}

function fmtUSD(cents: number | null): string {
  if (cents === null) return "—";
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const FREQUENCY_LABELS: Record<string, string> = {
  semi_monthly: "Semi-monthly",
  biweekly: "Bi-weekly",
  weekly: "Weekly",
  monthly: "Monthly",
};

export default async function IncomePage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const bucket = params.bucket ?? "personal";
  if (bucket !== "personal") {
    redirect(`/business/${bucket}/revenue` as Route);
  }

  const entity = await db.entity.findFirst({
    where: { slug: "personal" },
    select: { id: true },
  });

  const currentYear = new Date().getUTCFullYear();
  const yearStart = new Date(Date.UTC(currentYear, 0, 1));
  const yearEnd = new Date(Date.UTC(currentYear + 1, 0, 1));

  const [paystubs, incomeSources, personalAccounts] = await Promise.all([
    entity
      ? db.paystub.findMany({
          where: { entityId: entity.id, archivedAt: null },
          orderBy: [{ payDate: "desc" }, { createdAt: "desc" }],
        })
      : Promise.resolve([]),
    db.incomeSource.findMany({
      where: { active: true },
      include: { account: true, entity: true },
      orderBy: { description: "asc" },
    }),
    entity
      ? db.account.findMany({
          where: { entityId: entity.id, archivedAt: null },
          select: { id: true, nickname: true, mask: true, accountType: true },
          orderBy: { nickname: "asc" },
        })
      : Promise.resolve([]),
  ]);

  // YTD rollups from confirmed + extracted stubs
  const yearStubs = paystubs.filter(
    (p) => p.payDate && p.payDate >= yearStart && p.payDate < yearEnd
  );
  const ytdGross = yearStubs.reduce((s, p) => s + (p.grossPayCents ?? 0), 0);
  const ytdPretax = yearStubs.reduce(
    (s, p) =>
      s +
      ((p.pretaxDeductions as unknown as LabeledAmount[] | null)?.reduce(
        (a, d) => a + d.amountCents,
        0
      ) ?? 0),
    0
  );
  const ytdTaxes = yearStubs.reduce((s, p) => s + (p.taxesCents ?? 0), 0);
  const ytdNet = yearStubs.reduce((s, p) => s + (p.netPayCents ?? 0), 0);
  const ytdExtraWithholding = yearStubs.reduce(
    (s, p) =>
      s +
      ((p.additionalWithholding as unknown as LabeledAmount[] | null)?.reduce(
        (a, d) => a + d.amountCents,
        0
      ) ?? 0),
    0
  );
  const totalWithheldForTaxes = ytdTaxes + ytdExtraWithholding;
  const unconfirmed = paystubs.filter((p) => !p.confirmedAt).length;
  const unbalanced = paystubs.filter(
    (p) => p.balanceDiffCents !== null && p.balanceDiffCents !== 0
  ).length;

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Income</h1>
          <p className="text-sm text-muted-foreground">
            Upload paystubs to verify pre-tax deductions, taxes, and net pay. Pay frequency
            feeds the cash-flow forecast.
          </p>
        </div>

        {/* YTD summary */}
        <div className="grid gap-4 sm:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Gross pay (YTD)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-green-600">{fmtUSD(ytdGross)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Pre-tax deductions (YTD)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{fmtUSD(ytdPretax)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Taxes withheld (YTD)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{fmtUSD(ytdTaxes)}</p>
              {ytdExtraWithholding > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  + {fmtUSD(ytdExtraWithholding)} extra withholding ={" "}
                  <span className="font-medium">{fmtUSD(totalWithheldForTaxes)}</span> total paid
                  toward taxes
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Net take-home (YTD)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-green-600">{fmtUSD(ytdNet)}</p>
            </CardContent>
          </Card>
        </div>

        {/* Verification warnings */}
        {(unconfirmed > 0 || unbalanced > 0) && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {unconfirmed > 0 && (
              <p>
                {unconfirmed} paystub{unconfirmed !== 1 ? "s" : ""} awaiting review —{" "}
                review to verify the math before relying on the numbers.
              </p>
            )}
            {unbalanced > 0 && (
              <p>
                {unbalanced} paystub{unbalanced !== 1 ? "s" : ""} don&apos;t balance
                (gross − pre-tax − taxes ≠ net). Open the stub to see the discrepancy.
              </p>
            )}
          </div>
        )}

        {/* Upload + sources */}
        <div className="grid gap-6 lg:grid-cols-2">
          <PaystubUploadCard
            entityId={entity?.id ?? null}
            accounts={personalAccounts.map((a) => ({
              id: a.id,
              nickname: a.nickname,
              mask: a.mask,
              accountType: a.accountType,
            }))}
          />

          <IncomeSourcesCard
            sources={incomeSources.map((s) => ({
              id: s.id,
              description: s.description,
              cadence: s.cadence,
              amount: Number(s.amount),
              accountNickname: s.account.nickname,
              accountMask: s.account.mask,
            }))}
          />
        </div>

        {/* Paystub history */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Paystub history</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {paystubs.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                No paystubs uploaded yet. Upload one above — Claude extracts the fields,
                you verify the math before it counts.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Pay date</th>
                      <th className="px-4 py-2 font-medium">Employee</th>
                      <th className="px-4 py-2 font-medium">Frequency</th>
                      <th className="px-4 py-2 font-medium text-right">Gross</th>
                      <th className="px-4 py-2 font-medium text-right">Pre-tax</th>
                      <th className="px-4 py-2 font-medium text-right">Taxes</th>
                      <th className="px-4 py-2 font-medium text-right">Extra W/H</th>
                      <th className="px-4 py-2 font-medium text-right">Net</th>
                      <th className="px-4 py-2 font-medium">Math</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paystubs.map((p) => {
                      const pretax =
                        (p.pretaxDeductions as unknown as LabeledAmount[] | null)?.reduce(
                          (a, d) => a + d.amountCents,
                          0
                        ) ?? 0;
                      const extraWithholding =
                        (p.additionalWithholding as unknown as LabeledAmount[] | null)?.reduce(
                          (a, d) => a + d.amountCents,
                          0
                        ) ?? 0;
                      const balanced =
                        p.balanceDiffCents === null ? null : p.balanceDiffCents === 0;
                      return (
                        <tr key={p.id} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="px-4 py-2 font-medium">
                            <Link
                              href={`/personal/income/${p.id}` as Route}
                              className="hover:underline"
                            >
                              {p.payDate
                                ? p.payDate.toLocaleDateString("en-US", {
                                    month: "short",
                                    day: "numeric",
                                    year: "numeric",
                                    timeZone: "UTC",
                                  })
                                : "—"}
                            </Link>
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">
                            {p.employeeName ?? "—"}
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">
                            {p.payFrequency
                              ? FREQUENCY_LABELS[p.payFrequency] ?? p.payFrequency
                              : "—"}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {fmtUSD(p.grossPayCents)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {fmtUSD(pretax || null)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {fmtUSD(p.taxesCents)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">
                            {extraWithholding > 0 ? (
                              <span className="text-amber-600">{fmtUSD(extraWithholding)}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums font-medium">
                            {fmtUSD(p.netPayCents)}
                          </td>
                          <td className="px-4 py-2">
                            {balanced === null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : balanced ? (
                              <span className="text-green-600">✓ Balanced</span>
                            ) : (
                              <span className="text-destructive">
                                Off by {fmtUSD(Math.abs(p.balanceDiffCents!))}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2">
                            <Badge
                              variant={p.confirmedAt ? "outline" : "secondary"}
                              className="text-xs"
                            >
                              {p.confirmedAt ? "Confirmed" : "Needs review"}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-xs text-muted-foreground">
          Paystub amounts are extracted from the uploaded document and verified by you —
          nothing is auto-booked. Sync a confirmed stub to the income sources list to feed
          the forecast.
        </p>
      </div>
    </AppShell>
  );
}