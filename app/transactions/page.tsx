import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import { exportTransactionsCsv } from "@/actions/reports";
import { ExportCsvButton } from "@/components/export-csv-button";
import { ApplyRulesButton } from "@/components/transactions/apply-rules-button";
import { DryRunButton } from "@/components/transactions/dry-run-button";
import { TransactionsFilterBar } from "@/components/transactions/transactions-filter-bar";
import { SyncNowButton } from "@/components/transactions/sync-now-button";
import { TransactionsTable } from "@/components/transactions/transactions-table";
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

  const [transactions, total, allTags, accounts, allProjects, plaidAccountCount] = await Promise.all([
    db.transaction.findMany({
      where,
      select: {
        id: true,
        postedAt: true,
        payeeRaw: true,
        payeeNormalized: true,
        description: true,
        amount: true,
        accountId: true,
        entityId: true,
        transferPairId: true,
        projectId: true,
        account: { select: { nickname: true, mask: true } },
        tags: { select: { tagId: true } },
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
    db.account.count({
      where: {
        plaidItemId: { not: null },
        archivedAt: null,
        ...(entity && { entityId: entity.id }),
      },
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
            {plaidAccountCount > 0 && (
              <SyncNowButton entityId={entity?.id} />
            )}
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

        <TransactionsTable
          transactions={transactions.map((tx) => ({
            id: tx.id,
            postedAt: tx.postedAt.toISOString(),
            payeeRaw: tx.payeeRaw,
            payeeNormalized: tx.payeeNormalized,
            description: tx.description,
            amount: new Prisma.Decimal(tx.amount).toString(),
            accountId: tx.accountId,
            accountNickname: tx.account.nickname,
            accountMask: tx.account.mask,
            tagIds: tx.tags.map((t) => t.tagId),
            projectId: tx.projectId ?? null,
            transferPairId: tx.transferPairId,
          }))}
          allTags={allTags}
          allProjects={allProjects}
        />

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

