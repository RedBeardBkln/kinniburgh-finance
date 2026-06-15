import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell, BUCKET_ENTITY_NAMES, type BucketSlug } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import { deleteTransaction } from "@/actions/transactions";
import { exportTransactionsCsv } from "@/actions/reports";
import { ExportCsvButton } from "@/components/export-csv-button";
import type { Route } from "next";

interface PageProps {
  searchParams: Promise<{
    bucket?: string;
    tab?: string;
    page?: string;
    search?: string;
    accountId?: string;
    tagId?: string;
    dateFrom?: string;
    dateTo?: string;
  }>;
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const bucket = (params.bucket ?? "personal") as BucketSlug;
  const tab = params.tab ?? "all";
  const entityName = BUCKET_ENTITY_NAMES[bucket] ?? "Personal";
  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = 50;

  const entity = await db.entity.findFirst({ where: { name: entityName } });

  const baseWhere: Prisma.TransactionWhereInput = {
    archivedAt: null,
    ...(entity && { entityId: entity.id }),
    ...(params.accountId && { accountId: params.accountId }),
    ...(params.tagId && { tags: { some: { tagId: params.tagId } } }),
    ...(params.dateFrom && { postedAt: { gte: new Date(params.dateFrom) } }),
    ...(params.dateTo && { postedAt: { lte: new Date(params.dateTo) } }),
    ...(params.search && {
      OR: [
        { payeeRaw: { contains: params.search, mode: "insensitive" } },
        { description: { contains: params.search, mode: "insensitive" } },
      ],
    }),
  };

  const needsReviewFilter: Prisma.TransactionWhereInput = {
    tags: { none: {} },
    transferPairId: null,
    pending: false,
  };

  const where: Prisma.TransactionWhereInput = {
    ...baseWhere,
    ...(tab === "review" && needsReviewFilter),
  };

  // Count for badge
  const reviewCount = await db.transaction.count({
    where: { ...baseWhere, ...needsReviewFilter },
  });

  const [transactions, total] = await Promise.all([
    db.transaction.findMany({
      where,
      include: {
        account: { include: { institution: true } },
        entity: true,
        tags: { include: { tag: true } },
      },
      orderBy: { postedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.transaction.count({ where }),
  ]);

  const totalPages = Math.ceil(total / pageSize);

  function buildPageUrl(p: number) {
    const q = new URLSearchParams(params as Record<string, string>);
    q.set("page", String(p));
    return `/transactions?${q.toString()}` as Route;
  }

  function buildTabUrl(t: string) {
    const q = new URLSearchParams({ bucket, tab: t, page: "1" });
    return `/transactions?${q.toString()}` as Route;
  }

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Transactions</h1>
            <p className="text-sm text-muted-foreground">
              {total} transactions · {entityName}
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <ExportCsvButton
              filename={`transactions-${bucket}-${new Date().toISOString().slice(0, 10)}.csv`}
              action={exportTransactionsCsv.bind(null, {
                entityId: entity?.id,
                accountId: params.accountId,
                startDate: params.dateFrom,
                endDate: params.dateTo,
                tagId: params.tagId,
              })}
            />
            <Link
              href={`/transactions/import?bucket=${bucket}`}
              className="inline-flex items-center justify-center rounded-md border border-input bg-background px-3 text-xs h-9 font-medium hover:bg-accent hover:text-accent-foreground"
            >
              Import CSV
            </Link>
            <Link
              href={`/transactions/new?bucket=${bucket}`}
              className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-3 text-xs h-9 font-medium hover:bg-primary/90"
            >
              + Add
            </Link>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b">
          {[
            { slug: "all", label: "All" },
            { slug: "review", label: "Needs Review" },
          ].map(({ slug, label }) => (
            <Link
              key={slug}
              href={buildTabUrl(slug)}
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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">Payee</th>
                    <th className="px-4 py-3 font-medium">Account</th>
                    <th className="px-4 py-3 font-medium">Tags</th>
                    <th className="px-4 py-3 font-medium text-right">Amount</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {transactions.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                        No transactions found
                      </td>
                    </tr>
                  )}
                  {transactions.map((tx) => {
                    const amount = new Prisma.Decimal(tx.amount);
                    const isOutflow = amount.isNegative();
                    const isTransfer = tx.transferPairId !== null;
                    return (
                      <tr
                        key={tx.id}
                        className={`border-b last:border-0 hover:bg-muted/30 ${isTransfer ? "opacity-70" : ""}`}
                      >
                        <td className="px-4 py-2 text-muted-foreground">
                          {formatDate(tx.postedAt)}
                        </td>
                        <td className="px-4 py-2">
                          <span className="font-medium">{tx.payeeRaw ?? tx.payeeNormalized ?? "—"}</span>
                          {tx.description && (
                            <p className="text-xs text-muted-foreground truncate max-w-xs">
                              {tx.description}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground text-xs">
                          {tx.account.nickname}
                          <span className="ml-1">···{tx.account.mask}</span>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex flex-wrap gap-1">
                            {tx.tags.map(({ tag }) => (
                              <Badge key={tag.id} variant="secondary" className="text-xs">
                                {tag.shortName}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className={`px-4 py-2 text-right font-mono font-medium ${isOutflow ? "text-destructive" : "text-green-600"}`}>
                          {isOutflow ? "-" : "+"}
                          {formatCents(amount.abs())}
                        </td>
                        <td className="px-4 py-2">
                          <form
                            action={async () => {
                              "use server";
                              await deleteTransaction(tx.id);
                            }}
                          >
                            <button
                              type="submit"
                              className="text-xs text-muted-foreground hover:text-destructive"
                            >
                              Delete
                            </button>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              {page > 1 && (
                <Link
                  href={buildPageUrl(page - 1) as Route}
                  className="inline-flex items-center justify-center rounded-md border border-input bg-background px-3 text-xs h-9 font-medium hover:bg-accent"
                >
                  Previous
                </Link>
              )}
              {page < totalPages && (
                <Link
                  href={buildPageUrl(page + 1) as Route}
                  className="inline-flex items-center justify-center rounded-md border border-input bg-background px-3 text-xs h-9 font-medium hover:bg-accent"
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

function formatDate(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  }).format(d);
}

function formatCents(d: Prisma.Decimal): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(d.toNumber());
}
