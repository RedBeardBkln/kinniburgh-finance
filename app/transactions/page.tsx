import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { Card, CardContent } from "@/components/ui/card";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import { deleteTransaction } from "@/actions/transactions";
import { exportTransactionsCsv } from "@/actions/reports";
import { ExportCsvButton } from "@/components/export-csv-button";
import { ApplyRulesButton } from "@/components/transactions/apply-rules-button";
import { DryRunButton } from "@/components/transactions/dry-run-button";
import { InlineTagCell } from "@/components/transactions/inline-tag-cell";
import { InlineProjectCell } from "@/components/transactions/inline-project-cell";
import { TransactionsFilterBar } from "@/components/transactions/transactions-filter-bar";
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
    sort?: string;
    sortDir?: string;
  }>;
}

export default async function TransactionsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const bucket = params.bucket ?? "personal";
  const tab = params.tab ?? "all";
  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = 50;
  const sort = params.sort ?? "date";
  const sortDir = (params.sortDir ?? "desc") as "asc" | "desc";

  const entity = await getEntityBySlug(bucket);
  const bucketLabel = entity?.navLabel ?? entity?.name ?? "All Entities";

  const orderBy: Prisma.TransactionOrderByWithRelationInput =
    sort === "payee" ? { payeeRaw: sortDir } :
    sort === "amount" ? { amount: sortDir } :
    { postedAt: sortDir };

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

  const reviewCount = await db.transaction.count({
    where: { ...baseWhere, ...needsReviewFilter },
  });

  const [transactions, total, allTags, accounts, allProjects] = await Promise.all([
    db.transaction.findMany({
      where,
      include: {
        account: { include: { institution: true } },
        entity: true,
        tags: { include: { tag: true } },
      },
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.transaction.count({ where }),
    db.tag.findMany({ orderBy: { name: "asc" } }),
    db.account.findMany({
      where: { ...(entity && { entityId: entity.id }), archivedAt: null },
      orderBy: { nickname: "asc" },
      select: { id: true, nickname: true, mask: true },
    }),
    db.project.findMany({
      where: { archivedAt: null, status: { not: "completed" } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
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
              {total} transactions · {bucketLabel}
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
        <div className="flex items-center justify-between border-b">
          <div className="flex gap-1">
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
          {tab === "review" && (
            <div className="pb-1 flex items-start gap-2">
              <DryRunButton entityId={entity?.id} />
              <ApplyRulesButton entityId={entity?.id} />
            </div>
          )}
        </div>

        {/* Filter + sort bar */}
        <TransactionsFilterBar
          bucket={bucket}
          tab={tab}
          accounts={accounts}
          tags={allTags}
          currentSearch={params.search ?? ""}
          currentAccountId={params.accountId ?? ""}
          currentTagId={params.tagId ?? ""}
          currentDateFrom={params.dateFrom ?? ""}
          currentDateTo={params.dateTo ?? ""}
          currentSort={sort}
          currentSortDir={sortDir}
        />

        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col className="w-[72px]" />
                <col />
                <col className="w-[130px]" />
                <col className="w-[110px]" />
                {allProjects.length > 0 && <col className="w-[110px]" />}
                <col className="w-[96px]" />
                <col className="w-[52px]" />
              </colgroup>
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-2 py-3 font-medium">Date</th>
                  <th className="px-2 py-3 font-medium">Payee</th>
                  <th className="px-2 py-3 font-medium">Account</th>
                  <th className="px-2 py-3 font-medium">Tags</th>
                  {allProjects.length > 0 && <th className="px-2 py-3 font-medium">Project</th>}
                  <th className="px-2 py-3 font-medium text-right">Amount</th>
                  <th className="px-2 py-3" />
                </tr>
              </thead>
              <tbody>
                {transactions.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-2 py-8 text-center text-muted-foreground">
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
                      <td className="px-2 py-2 text-muted-foreground whitespace-nowrap text-xs">
                        {formatDate(tx.postedAt)}
                      </td>
                      <td className="px-2 py-2 min-w-0">
                        <Link
                          href={`/transactions/${tx.id}` as Route}
                          className="font-medium hover:underline block truncate"
                        >
                          {tx.payeeRaw ?? tx.payeeNormalized ?? "—"}
                        </Link>
                        {tx.description && (
                          <p className="text-xs text-muted-foreground truncate">
                            {tx.description}
                          </p>
                        )}
                      </td>
                      <td className="px-2 py-2 text-muted-foreground text-xs min-w-0">
                        <span className="block truncate">{tx.account.nickname}</span>
                        <span className="text-muted-foreground/70">···{tx.account.mask}</span>
                      </td>
                      <td className="px-2 py-2">
                        <InlineTagCell
                          transactionId={tx.id}
                          allTags={allTags}
                          initialTagIds={tx.tags.map((t) => t.tagId)}
                          payeeNormalized={tx.payeeNormalized ?? tx.payeeRaw ?? undefined}
                          defaultAmount={Math.abs(Number(tx.amount)).toFixed(2)}
                          accountId={tx.accountId}
                          accountNickname={tx.account.nickname}
                          accountMask={tx.account.mask}
                        />
                      </td>
                      {allProjects.length > 0 && (
                        <td className="px-2 py-2">
                          <InlineProjectCell
                            transactionId={tx.id}
                            projects={allProjects}
                            initialProjectId={(tx as typeof tx & { projectId?: string | null }).projectId ?? null}
                          />
                        </td>
                      )}
                      <td className={`px-2 py-2 text-right font-mono font-medium whitespace-nowrap text-xs ${isOutflow ? "text-destructive" : "text-green-600"}`}>
                        {isOutflow ? "-" : "+"}
                        {formatCents(amount.abs())}
                      </td>
                      <td className="px-2 py-2">
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
