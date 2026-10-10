import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Wallet, TrendingDown, AlertTriangle, CheckCircle2 } from "lucide-react";
import { formatUSD, decimalToNumber } from "@/lib/utils";
import { Prisma } from "@prisma/client";
import Link from "next/link";
import type { Route } from "next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DashboardClient } from "@/components/dashboard/dashboard-client";
import { DrillButton } from "@/components/dashboard/drill-button";
import { BudgetLinesTable } from "@/components/dashboard/budget-lines-table";
import { resolveEffectiveBudgets } from "@/lib/budget-effective";
import { buildMonthSpend, currentPeriodNY, isValidPeriod } from "@/lib/month-spend";
import { loadMonthTransactions } from "@/lib/month-spend-build";
import { loadOwnAccountByMask } from "@/lib/own-account-masks-build";
import { buildDrillData } from "@/lib/dashboard-drill-build";
import { budgetedSubline, cadenceText, centsText, type DrillData } from "@/lib/dashboard-drill";
import { loadUpcomingLedger } from "@/lib/upcoming-ledger-build";
import { toUiDetection, toUiLedger, type UiDetection, type UiLedger } from "@/lib/upcoming-ledger-view";
import { UpcomingWidget } from "@/components/upcoming/upcoming-widget";
import { UpcomingWidgetSkeleton } from "@/components/upcoming/upcoming-skeleton";

interface PageProps {
  searchParams: Promise<{ bucket?: string; period?: string }>;
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const bucket = params.bucket ?? "personal";
  const entity = await getEntityBySlug(bucket);
  const bucketLabel = entity?.navLabel ?? entity?.name ?? "All Entities";

  const now = new Date();
  // The month people mean is the New York one: just after 8 PM on the last evening it is already the 1st in UTC.
  const currentPeriod = currentPeriodNY(now);
  // ?period=YYYY-MM selects a prior month; invalid or future values fall back to the current month.
  const requested = params.period;
  const period = requested && isValidPeriod(requested) && requested <= currentPeriod ? requested : currentPeriod;
  const isCurrentPeriod = period === currentPeriod;
  const periodYear = Number(period.slice(0, 4));
  const periodMonth = Number(period.slice(5, 7));
  const prevPeriod = shiftPeriod(periodYear, periodMonth, -1);
  const nextPeriod = shiftPeriod(periodYear, periodMonth, 1);
  const periodHref = (p: string) =>
    (p === currentPeriod ? `/?bucket=${bucket}` : `/?bucket=${bucket}&period=${p}`) as Route;

  // Every widget loads on its own: a failed read blanks that widget only (null = unavailable), never the page.
  const [budgetRows, tagRows, accounts, scheduledTransfers, recurringRows, monthTxs, ownAccountByMask] = await Promise.all([
    settle(
      "budget lines",
      db.budget.findMany({
        where: { ...(entity && { entityId: entity.id }), period },
        select: {
          id: true,
          tagId: true,
          accountId: true,
          budgeted: true,
          additionalAmountCents: true,
          rolloverAmount: true,
          account: { select: { nickname: true, entity: { select: { name: true } } } },
        },
        orderBy: [{ account: { nickname: "asc" } }, { tag: { name: "asc" } }],
      })
    ),
    settle("tags", db.tag.findMany({ select: { id: true, name: true, shortName: true, parentId: true }, orderBy: { name: "asc" } })),
    settle(
      "accounts",
      db.account.findMany({
        where: { ...(entity && { entityId: entity.id }), archivedAt: null },
        select: {
          id: true,
          nickname: true,
          mask: true,
          accountType: true,
          currentBalance: true,
          currentBalanceAt: true,
          institution: { select: { name: true } },
          entity: { select: { name: true } },
        },
        orderBy: { nickname: "asc" },
      })
    ),
    settle(
      "scheduled transfers",
      db.scheduledTransfer.findMany({
        // Only transfers that leave this bucket's accounts (all of them in the All Entities view).
        where: { active: true, ...(entity && { fromAccount: { entityId: entity.id } }) },
        select: {
          id: true,
          amount: true,
          cadence: true,
          dayRules: true,
          purpose: true,
          fromAccount: { select: { nickname: true } },
          toAccount: { select: { nickname: true } },
        },
        orderBy: [{ fromAccount: { nickname: "asc" } }, { id: "asc" }],
      })
    ),
    settle(
      "recurring expenses",
      db.recurringExpense.findMany({
        where: entity ? { entityId: entity.id } : {},
        select: { tagId: true, amountCents: true, frequency: true },
      })
    ),
    settle("month transactions", loadMonthTransactions({ entityId: entity?.id ?? null, period })),
    // Which statement masks are exactly one active account of the household (used only to recognise own-account transfers).
    settle("own account masks", loadOwnAccountByMask()),
  ]);

  // "Next 30 days" widget: about today, so only on the current month. It is NOT loaded here: it renders through
  // <UpcomingWidgetSection> inside a <Suspense> boundary below, so the ledger and the recurring-pattern checks never
  // hold up the rest of the dashboard. The page has already run auth() above (the section loads read-only data
  // only after that).

  // One model behind every number on the page and in the dialogs: the summary cards, the table, the chart, the
  // cards and the drill-down all read this same payload (lib/month-spend.ts defines what counts as spending).
  let drill: DrillData | null = null;
  if (budgetRows && tagRows && recurringRows && monthTxs && ownAccountByMask) {
    try {
      const tagParent = new Map(tagRows.map((t) => [t.id, t.parentId]));
      const effective = resolveEffectiveBudgets(
        budgetRows.map((b) => ({ id: b.id, tagId: b.tagId, accountId: b.accountId, budgeted: b.budgeted, additionalAmountCents: b.additionalAmountCents })),
        recurringRows,
        (tagId) => tagParent.get(tagId)
      );
      const zero = new Prisma.Decimal(0);
      const model = buildMonthSpend(
        monthTxs,
        tagRows,
        budgetRows.map((b) => ({
          id: b.id,
          tagId: b.tagId,
          accountId: b.accountId,
          resolved: effective.resolvedById.get(b.id) ?? zero,
          explicit: effective.explicitById.get(b.id) ?? null,
          rollover: new Prisma.Decimal(b.rolloverAmount ?? 0),
        })),
        { ownAccountByMask }
      );
      drill = buildDrillData({
        model,
        txs: monthTxs,
        tags: tagRows,
        budgets: budgetRows.map((b) => ({
          id: b.id,
          tagId: b.tagId,
          accountId: b.accountId,
          accountName: b.account.nickname,
          entityName: b.account.entity.name,
          rawBudgeted: b.budgeted,
          rollover: new Prisma.Decimal(b.rolloverAmount ?? 0),
        })),
        effective,
        accounts: (accounts ?? []).map((a) => ({
          id: a.id,
          nickname: a.nickname,
          institutionName: a.institution.name,
          entityName: a.entity.name,
          accountType: a.accountType,
          currentBalance: a.currentBalance,
          currentBalanceAt: a.currentBalanceAt,
        })),
        transfers: (scheduledTransfers ?? []).map((t) => ({
          id: t.id,
          fromNickname: t.fromAccount.nickname,
          toNickname: t.toAccount.nickname,
          amount: t.amount,
          cadence: t.cadence,
          dayRules: t.dayRules,
          purpose: t.purpose,
        })),
        period,
        periodLabel: formatPeriod(period),
        isCurrentPeriod,
        bucket,
        isAllEntities: entity === null,
        periodQuery: isCurrentPeriod ? "" : `&period=${period}`,
        ownAccountByMask,
      });
    } catch (err) {
      drill = null;
      console.error("Dashboard month numbers unavailable", err instanceof Error ? err.name : "UnknownError");
    }
  }

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <DashboardClient
        data={drill}
        allTags={tagRows ?? []}
        header={
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold">
                {bucketLabel} — {formatPeriod(period)}
              </h1>
              <p className="text-sm text-muted-foreground">
                Monthly budget overview{!isCurrentPeriod && " · past month"}
              </p>
            </div>
            <nav aria-label="Month navigation" className="flex items-center gap-2">
              <Link
                href={periodHref(prevPeriod)}
                className="inline-flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-muted"
              >
                <ChevronLeft className="h-4 w-4" />
                {formatPeriod(prevPeriod)}
              </Link>
              {!isCurrentPeriod && (
                <>
                  <Link
                    href={periodHref(nextPeriod)}
                    className="inline-flex items-center gap-1 rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    {formatPeriod(nextPeriod)}
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href={periodHref(currentPeriod)}
                    className="rounded-md px-3 py-1.5 text-sm text-primary hover:underline"
                  >
                    Current month
                  </Link>
                </>
              )}
            </nav>
          </div>
        }
      >
      <div className="space-y-6">
        {/* Summary cards: each opens the rows behind its number */}
        <div className="grid gap-4 sm:grid-cols-3">
          <DrillButton target={{ kind: "budgeted" }} label="Show what makes up Total Budgeted" className="block w-full rounded-xl">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Wallet className="h-4 w-4 text-primary" />
                  Total Budgeted
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{drill ? centsText(drill.totalBudgetedCents) : "Unavailable"}</p>
                {drill && <p className="mt-1 text-xs text-muted-foreground">{budgetedSubline(drill.isAllEntities)}</p>}
              </CardContent>
            </Card>
          </DrillButton>

          <DrillButton target={{ kind: "spent" }} label="Show what makes up Spent" className="block w-full rounded-xl">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <TrendingDown className="h-4 w-4 text-destructive" />
                  {isCurrentPeriod ? "Spent This Month" : `Spent in ${formatPeriod(period)}`}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-destructive">{drill ? centsText(drill.spentCents) : "Unavailable"}</p>
                {drill && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {drill.refundCount > 0 ? `Net of ${centsText(drill.refundsCents)} refunds` : "Money out, no refunds"}
                    {drill.pendingCount > 0 ? ` · ${drill.pendingCount} pending` : ""}
                    {drill.isAllEntities ? " · all entities combined" : ""}
                  </p>
                )}
              </CardContent>
            </Card>
          </DrillButton>

          <DrillButton target={{ kind: "overspent" }} label="Show which lines are overspent" className="block w-full rounded-xl">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  {drill && drill.overspentCount > 0
                    ? <AlertTriangle className="h-4 w-4 text-destructive" />
                    : <CheckCircle2 className="h-4 w-4 text-green-600" />}
                  Overspent Lines
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className={`text-2xl font-bold ${drill && drill.overspentCount > 0 ? "text-destructive" : "text-green-600"}`}>
                  {drill ? drill.overspentCount : "Unavailable"}
                </p>
              </CardContent>
            </Card>
          </DrillButton>
        </div>

        {/* Next 30 days (current month only) */}
        {isCurrentPeriod && (
          <Suspense key={bucket} fallback={<UpcomingWidgetSkeleton days={30} />}>
            <UpcomingWidgetSection entityId={entity?.id ?? null} isAggregate={entity === null} bucket={bucket} now={now} />
          </Suspense>
        )}

        {/* Budget lines table: parents with their nested lines, grouped by account */}
        <BudgetLinesTable budgetsHref={`/budgets?bucket=${bucket}${isCurrentPeriod ? "" : `&period=${period}`}`} />

        {/* Accounts + Scheduled Transfers */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Accounts</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {accounts === null && <p className="px-4 py-3 text-sm text-muted-foreground">Accounts are unavailable right now.</p>}
              {accounts !== null && accounts.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">No accounts.</p>}
              <ul>
                {(accounts ?? []).map((acct) => {
                  const debt = acct.accountType === "credit_card" || acct.accountType === "mortgage" || acct.accountType === "loan";
                  return (
                    <li key={acct.id} className="border-b last:border-0">
                      <DrillButton
                        target={{ kind: "account", accountId: acct.id }}
                        label={`Show the activity on ${acct.nickname} this month`}
                        className="flex w-full items-center justify-between gap-3 px-4 py-2 text-sm"
                      >
                        <span className="min-w-0">
                          <span className="font-medium">{acct.nickname}</span>
                          <span className="ml-1 font-mono text-xs text-muted-foreground">···{acct.mask}</span>
                          <span className="block text-xs text-muted-foreground">{acct.institution.name}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          {acct.currentBalance !== null ? (
                            <>
                              <span className="block font-medium tabular-nums">{formatUSD(decimalToNumber(acct.currentBalance))}</span>
                              <span className="block text-xs text-muted-foreground">
                                {debt ? "owed" : "balance"}
                                {acct.currentBalanceAt ? ` · as of ${formatBalanceDate(acct.currentBalanceAt)}` : ""}
                              </span>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">balance not set</span>
                          )}
                        </span>
                      </DrillButton>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Scheduled Transfers</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {scheduledTransfers === null && <p className="px-4 py-3 text-sm text-muted-foreground">Scheduled transfers are unavailable right now.</p>}
              {scheduledTransfers !== null && scheduledTransfers.length === 0 && (
                <p className="px-4 py-3 text-sm text-muted-foreground">None configured</p>
              )}
              <ul>
                {(scheduledTransfers ?? []).slice(0, 10).map((st) => (
                  <li key={st.id} className="border-b last:border-0">
                    <DrillButton
                      target={{ kind: "transfer", transferId: st.id }}
                      label={`Show details of the transfer from ${st.fromAccount.nickname} to ${st.toAccount.nickname}`}
                      className="flex w-full items-center justify-between gap-3 px-4 py-2 text-xs"
                    >
                      <span>
                        {st.fromAccount.nickname} → {st.toAccount.nickname}
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <span className="text-sm font-medium">{formatUSD(decimalToNumber(new Prisma.Decimal(st.amount)))}</span>
                        <Badge variant="outline" className="text-xs">
                          {cadenceText(st.cadence)}
                        </Badge>
                      </span>
                    </DrillButton>
                  </li>
                ))}
              </ul>
              {scheduledTransfers !== null && scheduledTransfers.length > 10 && (
                <DrillButton
                  target={{ kind: "transfers" }}
                  label="Show all scheduled transfers"
                  className="block w-full px-4 py-2 text-xs text-primary"
                >
                  and {scheduledTransfers.length - 10} more · show all
                </DrillButton>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
      </DashboardClient>
    </AppShell>
  );
}

/** Run one read; on failure log the error NAME only and return null so the widget shows "unavailable". */
async function settle<T>(label: string, read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (err) {
    console.error(`Dashboard ${label} unavailable`, err instanceof Error ? err.name : "UnknownError");
    return null;
  }
}

/**
 * The "Next 30 days" widget, loaded behind <Suspense>. Fail-soft exactly as before the move: a ledger error shows the
 * widget's small notice (ledger = null) and nothing else on the page changes. Read-only; the page has already run
 * auth() before this component is ever rendered.
 */
async function UpcomingWidgetSection({
  entityId,
  isAggregate,
  bucket,
  now,
}: {
  entityId: string | null;
  isAggregate: boolean;
  bucket: string;
  now: Date;
}) {
  // undefined = the ledger itself failed (nothing extra to say); null = only the pattern checks failed.
  let upcoming: UiLedger | null = null;
  let upcomingDetection: UiDetection | null | undefined;
  try {
    const loaded = await loadUpcomingLedger({ entityId, days: 30, now });
    upcoming = toUiLedger(loaded.ledger, {
      days: 30,
      bucketSlug: bucket,
      isAggregate,
      entityNameById: loaded.entityNameById,
      entitySlugById: loaded.entitySlugById,
      accountNameById: loaded.accountNameById,
      includeTransfers: false,
    });
    // Own try/catch, after the ledger exists: a throw here must never blank the agenda (null = pattern checks failed).
    try {
      upcomingDetection = loaded.detection ? toUiDetection(loaded.detection, loaded.entityNameById, upcoming.fromIso) : null;
    } catch (err) {
      upcomingDetection = null;
      console.error("Recurring pattern view unavailable", err instanceof Error ? err.name : "UnknownError");
    }
  } catch (err) {
    console.error("Upcoming ledger unavailable", err instanceof Error ? err.name : "UnknownError");
  }
  return <UpcomingWidget ledger={upcoming} bucketSlug={bucket} detection={upcomingDetection} />;
}

function shiftPeriod(year: number, month: number, delta: number): string {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

/** A balance is stamped with the moment it was fetched, so it is shown in New York time (unlike date-only values). */
function formatBalanceDate(at: Date): string {
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}
