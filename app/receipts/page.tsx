import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { AppShell, BUCKET_ENTITY_NAMES, type BucketSlug } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listReceipts } from "@/actions/receipts";
import { db } from "@/lib/db";
import { formatUSD, decimalToNumber } from "@/lib/utils";
import type { Route } from "next";

interface PageProps {
  searchParams: Promise<{ bucket?: string; tab?: string; page?: string }>;
}

const TABS = [
  { slug: "review", label: "Needs Review" },
  { slug: "confirmed", label: "Confirmed" },
  { slug: "all", label: "All" },
] as const;
type TabSlug = (typeof TABS)[number]["slug"];

export default async function ReceiptsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const bucket = (params.bucket ?? "personal") as BucketSlug;
  const tab = (params.tab ?? "review") as TabSlug;
  const page = Math.max(1, Number(params.page ?? 1));

  const entityName = BUCKET_ENTITY_NAMES[bucket]; // null = all entities (Taxes tab)
  const entity = entityName
    ? await db.entity.findFirst({ where: { name: entityName } })
    : null;

  const { receipts, total, pageSize } = await listReceipts({
    entityId: entity?.id,
    tab: tab === "all" ? "all" : tab === "confirmed" ? "confirmed" : "review",
    page,
  });

  const totalPages = Math.ceil(total / pageSize);

  // Count needs-review for badge
  const reviewCount = await db.receipt.count({
    where: {
      entityId: entity?.id,
      archivedAt: null,
      ocrStatus: "complete",
      confirmedAt: null,
    },
  });

  function buildUrl(overrides: Record<string, string>) {
    const q = new URLSearchParams({ bucket, tab, page: String(page), ...overrides });
    return `/receipts?${q.toString()}` as Route;
  }

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Receipts</h1>
          <Link
            href={`/receipts/upload?bucket=${bucket}` as Route}
            className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 h-9 text-sm font-medium hover:bg-primary/90"
          >
            Upload Receipt
          </Link>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b">
          {TABS.map(({ slug, label }) => (
            <Link
              key={slug}
              href={buildUrl({ tab: slug, page: "1" })}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === slug
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
              {slug === "review" && reviewCount > 0 && (
                <span className="rounded-full bg-primary px-1.5 py-0.5 text-xs font-semibold text-primary-foreground">
                  {reviewCount}
                </span>
              )}
            </Link>
          ))}
        </div>

        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Vendor</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium text-right">Amount</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {receipts.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      No receipts found
                    </td>
                  </tr>
                )}
                {receipts.map((r) => (
                  <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">
                      {r.vendor ?? <span className="italic text-muted-foreground">Unknown</span>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.receiptDate
                        ? new Date(r.receiptDate).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                            timeZone: "UTC",
                          })
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {r.total != null ? formatUSD(decimalToNumber(r.total)) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <OcrStatusBadge status={r.ocrStatus} confirmed={r.confirmedAt != null} />
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/receipts/${r.id}` as Route}
                        className="text-xs text-primary hover:underline"
                      >
                        Review →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {totalPages > 1 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              {page > 1 && (
                <Link
                  href={buildUrl({ page: String(page - 1) })}
                  className="inline-flex items-center justify-center rounded-md border px-3 h-9 text-xs font-medium hover:bg-accent"
                >
                  Previous
                </Link>
              )}
              {page < totalPages && (
                <Link
                  href={buildUrl({ page: String(page + 1) })}
                  className="inline-flex items-center justify-center rounded-md border px-3 h-9 text-xs font-medium hover:bg-accent"
                >
                  Next
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function OcrStatusBadge({ status, confirmed }: { status: string; confirmed: boolean }) {
  if (confirmed) return <Badge variant="secondary" className="bg-green-100 text-green-700">Confirmed</Badge>;
  if (status === "complete") return <Badge variant="secondary" className="bg-yellow-100 text-yellow-700">Needs Review</Badge>;
  if (status === "failed") return <Badge variant="destructive">Extraction Failed</Badge>;
  return <Badge variant="secondary">Extracting…</Badge>;
}
