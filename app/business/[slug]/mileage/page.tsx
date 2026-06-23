import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { listMileageEntries, exportMileageCsv } from "@/actions/mileage";
import { ExportCsvButton } from "@/components/export-csv-button";
import { AddMileageEntryForm } from "@/components/mileage/add-mileage-entry-form";
import type { Route } from "next";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ year?: string }>;
}


export default async function MileagePage({ params, searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { slug } = await params;
  const sp = await searchParams;
  const entity = await getEntityBySlug(slug);
  const entityLabel = entity?.navLabel ?? entity?.name ?? slug;

  if (!entity) redirect("/business" as Route);

  const now = new Date();
  const currentYear = sp.year ? Number(sp.year) : now.getUTCFullYear();
  const entries = await listMileageEntries(entity.id, currentYear);

  const totalMiles = entries.reduce((s, e) => s + e.miles, 0);
  const totalDeductionCents = entries.reduce(
    (s, e) => s + Math.round(e.miles * Number(e.ratePerMile) * 100),
    0
  );

  const years = [currentYear - 1, currentYear, currentYear + 1];

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
            <h1 className="text-2xl font-semibold">Mileage Log</h1>
            <p className="text-sm text-muted-foreground">{currentYear}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              {years.map((y) => (
                <Link
                  key={y}
                  href={`/business/${slug}/mileage?year=${y}` as Route}
                  className={`rounded-md px-3 py-1.5 text-sm border ${
                    y === currentYear
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-input bg-background hover:bg-accent"
                  }`}
                >
                  {y}
                </Link>
              ))}
            </div>
            <ExportCsvButton
              filename={`mileage-${slug}-${currentYear}.csv`}
              action={exportMileageCsv.bind(null, entity.id, currentYear)}
            />
          </div>
        </div>

        {/* YTD deduction callout */}
        {totalMiles > 0 && (
          <Card className="border-blue-200 bg-blue-50/50">
            <CardContent className="flex flex-wrap items-center gap-6 py-4 px-4">
              <div>
                <p className="text-xs text-muted-foreground">Total Miles ({currentYear})</p>
                <p className="text-2xl font-bold">{totalMiles.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Estimated Deduction</p>
                <p className="text-2xl font-bold text-blue-700">
                  {new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: "USD",
                  }).format(totalDeductionCents / 100)}
                </p>
              </div>
              <p className="text-xs text-muted-foreground self-end pb-0.5">
                Confirm IRS mileage rate with your CPA — this is not tax advice.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Log table */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Entries</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Purpose</th>
                  <th className="px-4 py-2 font-medium text-right">Miles</th>
                  <th className="px-4 py-2 font-medium text-right">Rate</th>
                  <th className="px-4 py-2 font-medium text-right">Deduction</th>
                  <th className="px-4 py-2 font-medium">Billable</th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      No mileage entries for {currentYear}
                    </td>
                  </tr>
                ) : (
                  entries.map((e) => {
                    const rate = Number(e.ratePerMile);
                    const deduction = e.miles * rate;
                    return (
                      <tr key={e.id} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-4 py-2 tabular-nums">{e.date.toISOString().slice(0, 10)}</td>
                        <td className="px-4 py-2">
                          {e.purpose}
                          {e.notes && <span className="ml-1.5 text-xs text-muted-foreground">{e.notes}</span>}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{e.miles}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">
                          ${rate.toFixed(3)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums font-medium">
                          {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(deduction)}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {e.billable ? (
                            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-700">Billable</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
                {entries.length > 0 && (
                  <tr className="border-t bg-muted/30 font-semibold">
                    <td colSpan={2} className="px-4 py-2">Total</td>
                    <td className="px-4 py-2 text-right tabular-nums">{totalMiles.toLocaleString()}</td>
                    <td className="px-4 py-2" />
                    <td className="px-4 py-2 text-right tabular-nums">
                      {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
                        totalDeductionCents / 100
                      )}
                    </td>
                    <td className="px-4 py-2" />
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Add entry */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Add Entry</CardTitle>
          </CardHeader>
          <CardContent>
            <AddMileageEntryForm entityId={entity.id} />
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
