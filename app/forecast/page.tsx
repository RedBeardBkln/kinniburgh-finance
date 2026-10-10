import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  generateTransferOccurrences,
  generateIncomeOccurrences,
  buildAccountForecast,
  findBreachDays,
} from "@/lib/forecast";
import { rollupForecast, type RollupBucket } from "@/lib/forecast-rollup";
import { projectPeriodEndSpend } from "@/lib/spend-forecast";
import { computeBudgetSummary } from "@/lib/budget";
import { PACE_TRAILING_MONTHS } from "@/lib/budget-pace";
import { formatUSD, decimalToNumber } from "@/lib/utils";
import { Prisma } from "@prisma/client";
import { analyzeCardFunding, shortfallIncludesEstimate, type CardDue, type CoverageStatus } from "@/lib/cc-funding";
import { classifyCardDue, formatCalendarDate } from "@/lib/card-due";
import { cardDuesInWindow, cardPaymentEvents } from "@/lib/card-next-statement";
import { loadNetIncomeSources } from "@/lib/net-income-build";
import { generateBillOccurrencesBudgetDated } from "@/lib/bill-dates";
import { loadBudgetScheduleIndex } from "@/lib/bill-dates-build";
import { loadEffectiveBudgetRows } from "@/lib/budget-carry-forward-build";
import { carriedCaption } from "@/lib/budget-carry-forward";
import { planAmountForMonth, planForBill, planForLine, type BillSeasonalPlan } from "@/lib/seasonal-energy";
import { loadSeasonalEnergySafe, loadSeasonalPlansSafe } from "@/lib/seasonal-energy-build";
import { toUiSite } from "@/lib/seasonal-energy-view";
import { SeasonalCard } from "@/components/forecast/seasonal-card";
import { loadCardProjections, type LoadedCardProjections } from "@/lib/card-next-statement-build";
import { setAccountBalance, upsertIncomeSource } from "@/actions/envelope";
import { ForecastAccountCard, type ChartPoint } from "@/components/forecast/forecast-account-card";
import { listRecurringExpenses } from "@/actions/recurring-expenses";
import { listRentalBookings } from "@/actions/rental-bookings";
import { RecurringExpensesSection } from "@/components/forecast/recurring-expenses-section";
import { RentalBookingsSection } from "@/components/forecast/rental-bookings-section";
import { SpendPaceSection, type TagPaceRow } from "@/components/forecast/spend-pace-section";
import { capForecastHorizon, prorateExpensesAcrossHorizon } from "@/lib/business-forecast";
import { resolveBudgetedAmounts, getRootBudgetLineIds } from "@/lib/budget-nesting";
import { loadUpcomingLedger } from "@/lib/upcoming-ledger-build";
import { loadBudgetHints } from "@/lib/recurring-budget-hint-build";
import {
  parseHorizon,
  parseTransfersFlag,
  toTagOptions,
  toUiDetection,
  toUiLedger,
  type Horizon,
  type UiDetection,
  type UiLedger,
  type UiTagOption,
} from "@/lib/upcoming-ledger-view";
import { UpcomingAgenda } from "@/components/upcoming/upcoming-agenda";
import { RecurringSuggestions } from "@/components/upcoming/recurring-suggestions";
import { UpcomingAgendaSkeleton } from "@/components/upcoming/upcoming-skeleton";
import {
  BusinessForecastSection,
  type ForecastAccount as BusinessForecastAccount,
  type ForecastHorizon as BusinessForecastHorizon,
} from "@/components/forecast/business-forecast-section";

interface PageProps {
  searchParams: Promise<{ bucket?: string; horizon?: string; transfers?: string }>;
}

export default async function ForecastPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const bucket = params.bucket ?? "personal";
  const entity = await getEntityBySlug(bucket);

  // Sudden Valley / EK Consulting: balance projection is computed from real
  // revenue/budget data (lib/business-forecast.ts) instead of the
  // personal-payroll-shaped ScheduledTransfer/ScheduledBill/IncomeSource engine
  // below. Personal (entity.type === "personal", or entity === null for the
  // "taxes" aggregate view) is entirely unchanged.
  const isBusinessBucket = entity?.type === "business";

  const now = new Date();
  const forecastStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const forecastEnd90 = new Date(forecastStart.getTime() + 90 * 86400000);
  const forecastEnd14 = new Date(forecastStart.getTime() + 14 * 86400000);

  // Load checking accounts with a minimum balance rule, filtered to the active bucket's entity.
  // This TD-Bank-only rule (spec 07 item 10) never matches either business entity's
  // checking account (neither has a minimumBalance set) — skip the query entirely for
  // business buckets rather than running it to always get [] back.
  const tdAccounts = isBusinessBucket
    ? []
    : await db.account.findMany({
        where: {
          archivedAt: null,
          accountType: "checking",
          minimumBalance: { not: null },
          ...(entity && { entityId: entity.id }),
        },
        include: { institution: true },
        orderBy: { nickname: "asc" },
      });

  // Load all active scheduled transfers, income sources, and bills (Personal's
  // day-by-day engine only — business buckets don't use any of these).
  // Paychecks are TAKE-HOME pay (loadNetIncomeSources replaces the stored gross amount with the figure resolved from
  // recent deposits / a confirmed paystub, with its basis), and bills are dated by their Budget row month by month
  // (loadBudgetScheduleIndex; fail-soft: on an error the bill records' own dates are used, as before).
  const noBudgetDates: Awaited<ReturnType<typeof loadBudgetScheduleIndex>> = { index: new Map(), failed: false };
  // Seasonal estimates (lib/seasonal-energy.ts) for the Electric / Oil bills whose model gate has passed; a gated model
  // has no plan, so those bills keep the flat figure. Read-only and fail-soft (failed = the flat figures are used).
  const noSeasonal: { plans: BillSeasonalPlan[]; failed: boolean } = { plans: [], failed: false };
  const [transfers, incomeSources, scheduledBills, budgetDates, seasonalLoad] = isBusinessBucket
    ? [[], [], [], noBudgetDates, noSeasonal]
    : await Promise.all([
        db.scheduledTransfer.findMany({
          where: { active: true },
          include: { fromAccount: true, toAccount: true },
        }),
        loadNetIncomeSources({ withAccount: true, withEntity: true }),
        db.scheduledBill.findMany({
          where: { active: true, budgetTagId: { not: null } },
          include: { accrualEnvelope: { include: { draws: true } } },
        }),
        loadBudgetScheduleIndex({ from: forecastStart, to: forecastEnd90 }),
        loadSeasonalPlansSafe({ now }),
      ]);

  // Maps a scheduled bill's linked AccrualEnvelope draws (if any) into the
  // plain shape generateBillOccurrences expects. Non-accrued bills / bills
  // with no linked envelope simply have an empty accrualEnvelope, so this
  // always returns [] for them — generateBillOccurrences ignores draws for
  // non-accrued bills anyway, but this keeps the call sites simple.
  function billDraws(b: (typeof scheduledBills)[number]) {
    return (b.accrualEnvelope?.draws ?? []).map((d) => ({
      estimatedDate: d.estimatedDate,
      estimatedAmount: d.estimatedAmount,
    }));
  }

  // Load entities for the income source form
  const entities = await db.entity.findMany({
    where: { archivedAt: null },
    orderBy: { name: "asc" },
  });

  // Load recurring expenses and rental bookings (filtered to entity if selected)
  const [recurringExpenses, allTags, rentalBookings] = await Promise.all([
    listRecurringExpenses(entity?.id),
    db.tag.findMany({ orderBy: { name: "asc" } }),
    entity ? listRentalBookings(entity.id) : Promise.resolve([]),
  ]);

  // ── Business-bucket forecast (Sudden Valley / EK Consulting only) ────────
  // currentBalance + projected revenue (RentalBooking payouts + ProjectedRevenue)
  // − scheduled transfers out − projected expenses (prorated from Budget rows).
  // See lib/business-forecast.ts for the horizon-capping/proration math.
  const businessAccounts: BusinessForecastAccount[] = [];
  // Quiet caption when the expense figures use budgets carried forward from an earlier month (incl. the flat seasonal lines).
  let businessCarriedCaption: string | null = null;
  if (isBusinessBucket && entity) {
    const businessCheckingAccounts = await db.account.findMany({
      where: { entityId: entity.id, archivedAt: null, accountType: "checking" },
      orderBy: { nickname: "asc" },
    });

    const projectedRevenueRows = await db.projectedRevenue.findMany({
      where: { entityId: entity.id, archivedAt: null, realizedAt: null },
      orderBy: { expectedDate: "asc" },
    });

    const businessTransfers = await db.scheduledTransfer.findMany({
      where: { active: true, fromAccount: { entityId: entity.id } },
      include: { fromAccount: true, toAccount: true },
    });

    // Periods touched by the largest (uncapped) 90-day horizon — capping only
    // ever shrinks the window, so this over-fetches slightly rather than
    // under-fetching; harmless (Budget.groupBy-equivalent for an unused period
    // just contributes nothing).
    const maxHorizonEnd = new Date(forecastStart.getTime() + 90 * 86400000);
    const touchedPeriods: string[] = [];
    {
      let y = forecastStart.getUTCFullYear();
      let m = forecastStart.getUTCMonth();
      while (new Date(Date.UTC(y, m, 1)).getTime() < maxHorizonEnd.getTime()) {
        touchedPeriods.push(`${y}-${String(m + 1).padStart(2, "0")}`);
        m++;
        if (m > 11) { m = 0; y++; }
      }
    }

    // EFFECTIVE Budget rows for the touched periods, WITH tag — feeds both the entity-wide
    // prorated total (aggregatePeriodTotals) and the per-tag itemized breakdown
    // (periodTotalsByTag) from a single query, rather than a groupBy() for the
    // total plus a second findMany() for the itemization. A period with no row for a
    // line carries the latest earlier row of that line (lib/budget-carry-forward.ts,
    // read-time, nothing written). Nesting/auto-sum below runs AFTER the carry so
    // carried rows nest exactly like real ones.
    const budgetRows = await loadEffectiveBudgetRows({ periods: touchedPeriods, entityId: entity.id });
    businessCarriedCaption = carriedCaption(budgetRows);

    // Nesting/auto-sum resolution — same-account AND same-period only (two
    // different periods' "Groceries" lines are unrelated).
    const businessTagParentById = new Map(allTags.map((t) => [t.id, t.parentId]));
    const budgetRowsByGroup = new Map<string, typeof budgetRows>();
    for (const b of budgetRows) {
      const key = `${b.period}::${b.accountId}`;
      if (!budgetRowsByGroup.has(key)) budgetRowsByGroup.set(key, []);
      budgetRowsByGroup.get(key)!.push(b);
    }
    const resolvedBudgetRowById = new Map<string, Prisma.Decimal>();
    const rootBudgetRowIds = new Set<string>();
    for (const group of budgetRowsByGroup.values()) {
      const resolverInput = group.map((b) => ({ id: b.id, tagId: b.tagId, budgeted: b.budgeted }));
      for (const [id, amt] of resolveBudgetedAmounts(resolverInput, (tagId) => businessTagParentById.get(tagId), new Prisma.Decimal(0))) {
        resolvedBudgetRowById.set(id, amt);
      }
      for (const id of getRootBudgetLineIds(group, (tagId) => businessTagParentById.get(tagId))) {
        rootBudgetRowIds.add(id);
      }
    }

    const aggregatePeriodTotals = new Map<string, Prisma.Decimal>();
    const periodTotalsByTag = new Map<string, { tagName: string; periods: Map<string, Prisma.Decimal> }>();
    for (const b of budgetRows) {
      if (!rootBudgetRowIds.has(b.id)) continue; // skip non-root lines entirely for the total
      const amt = resolvedBudgetRowById.get(b.id) ?? new Prisma.Decimal(0);
      aggregatePeriodTotals.set(
        b.period,
        (aggregatePeriodTotals.get(b.period) ?? new Prisma.Decimal(0)).plus(amt)
      );
      const tagEntry = periodTotalsByTag.get(b.tagId) ?? { tagName: b.tag.shortName, periods: new Map() };
      tagEntry.periods.set(b.period, amt);
      periodTotalsByTag.set(b.tagId, tagEntry);
    }

    // Revenue: RentalBooking payouts (forward-looking only — a past payoutDate
    // is already reflected in currentBalance once the Airbnb deposit posts) and
    // unrealized ProjectedRevenue (overdue-but-unrealized rows still count as
    // expected inflows for every horizon; only forward-looking dates push the cap).
    const forwardRentalBookings = rentalBookings.filter(
      (b) => new Date(b.payoutDate).getTime() >= forecastStart.getTime()
    );
    const overdueProjectedRevenue = projectedRevenueRows.filter(
      (r) => new Date(r.expectedDate).getTime() < forecastStart.getTime()
    );
    const forwardProjectedRevenue = projectedRevenueRows.filter(
      (r) => new Date(r.expectedDate).getTime() >= forecastStart.getTime()
    );

    const forwardRevenueDates = [
      ...forwardRentalBookings.map((b) => new Date(b.payoutDate)),
      ...forwardProjectedRevenue.map((r) => new Date(r.expectedDate)),
    ];
    const latestConfirmedRevenueDate =
      forwardRevenueDates.length === 0
        ? null
        : forwardRevenueDates.reduce((max, d) => (d.getTime() > max.getTime() ? d : max));

    const HORIZON_DAYS = [30, 60, 90] as const;

    for (const acct of businessCheckingAccounts) {
      const startingBalance =
        acct.currentBalance !== null ? new Prisma.Decimal(acct.currentBalance) : new Prisma.Decimal(0);

      const horizons: BusinessForecastHorizon[] = HORIZON_DAYS.map((requestedDays) => {
        const { days, wasCapped } = capForecastHorizon(requestedDays, latestConfirmedRevenueDate, forecastStart);
        const horizonEnd = new Date(forecastStart.getTime() + days * 86400000);

        const rentalItems = forwardRentalBookings
          .filter((b) => new Date(b.payoutDate).getTime() <= horizonEnd.getTime())
          .map((b) => ({
            date: new Date(b.payoutDate),
            description: `Airbnb payout — ${b.guest}`,
            amountDecimal: new Prisma.Decimal(b.grossEarnings),
          }));
        const overdueItems = overdueProjectedRevenue.map((r) => ({
          date: new Date(r.expectedDate),
          description: `${r.description} (overdue)`,
          amountDecimal: new Prisma.Decimal(r.amountCents).div(100),
        }));
        const forwardProjectedItems = forwardProjectedRevenue
          .filter((r) => new Date(r.expectedDate).getTime() <= horizonEnd.getTime())
          .map((r) => ({
            date: new Date(r.expectedDate),
            description: r.description,
            amountDecimal: new Prisma.Decimal(r.amountCents).div(100),
          }));

        const revenueDecimalItems = [...rentalItems, ...overdueItems, ...forwardProjectedItems].sort(
          (a, b) => a.date.getTime() - b.date.getTime()
        );
        const revenueTotal = revenueDecimalItems.reduce(
          (acc, i) => acc.plus(i.amountDecimal),
          new Prisma.Decimal(0)
        );

        const transferEvents = businessTransfers
          .flatMap((t) => generateTransferOccurrences(t, forecastStart, horizonEnd))
          .filter((e) => e.accountId === acct.id && e.type === "transfer_out");
        const transfersOutTotal = transferEvents.reduce(
          (acc, e) => acc.plus(e.amount.abs()),
          new Prisma.Decimal(0)
        );

        const expensesTotal = prorateExpensesAcrossHorizon(aggregatePeriodTotals, forecastStart, horizonEnd);
        const expenseItems = [...periodTotalsByTag.values()]
          .map((tagEntry) => ({
            tagName: tagEntry.tagName,
            amountDecimal: prorateExpensesAcrossHorizon(tagEntry.periods, forecastStart, horizonEnd),
          }))
          .filter((item) => item.amountDecimal.greaterThan(0))
          .sort((a, b) => a.tagName.localeCompare(b.tagName));

        const endingBalance = startingBalance.plus(revenueTotal).minus(transfersOutTotal).minus(expensesTotal);

        return {
          requestedDays,
          days,
          wasCapped,
          latestConfirmedRevenueDate,
          startingBalance: decimalToNumber(startingBalance),
          revenue: decimalToNumber(revenueTotal),
          transfersOut: decimalToNumber(transfersOutTotal),
          expenses: decimalToNumber(expensesTotal),
          endingBalance: decimalToNumber(endingBalance),
          revenueItems: revenueDecimalItems.map((i) => ({
            date: i.date,
            description: i.description,
            amount: decimalToNumber(i.amountDecimal),
          })),
          expenseItems: expenseItems.map((i) => ({ tagName: i.tagName, amount: decimalToNumber(i.amountDecimal) })),
        };
      });

      businessAccounts.push({
        id: acct.id,
        name: acct.nickname,
        mask: acct.mask,
        currentBalance: acct.currentBalance !== null ? decimalToNumber(acct.currentBalance) : null,
        currentBalanceAt: acct.currentBalanceAt,
        horizons,
      });
    }
  }

  // Credit card statements: every card is paid in full each month, so a card's payment is its WHOLE statement
  // balance. lib/card-next-statement.ts reads past payments to (a) see whether the statement on file was already
  // paid, (b) infer which account really pays each card (never assumed; "not determined" = the card is not
  // assigned to any account) and (c) estimate the NEXT statements, shown as estimates with their basis. Read-only
  // and fail-soft: on an error the card payments are left out and a notice says so.
  const cardLoad: LoadedCardProjections = isBusinessBucket
    ? { today: forecastStart, projections: [], error: false }
    : await loadCardProjections({ now });
  const cardProjections = cardLoad.projections;
  const entityNameById = new Map(entities.map((e) => [e.id, e.name]));

  // The account's scheduled movements other than card payments (same generators and bill filter as the chart).
  function nonCardEvents(accountId: string, from: Date, to: Date) {
    return [
      ...transfers.flatMap((t) => generateTransferOccurrences(t, from, to)),
      ...incomeSources.flatMap((s) => generateIncomeOccurrences(s, from, to)),
      ...scheduledBills.flatMap((b) => generateBillOccurrencesBudgetDated(b, budgetDates.index, from, to, billDraws(b), planForBill(seasonalLoad.plans, b))),
    ].filter((e) => e.accountId === accountId);
  }

  // Credit card funding analysis, one per account that pays cards: the whole statements (and estimates) due in
  // 30 days against that account's balance, its scheduled transfers / paychecks / bills, and its minimum.
  interface FundingView {
    account: (typeof tdAccounts)[number];
    status: CoverageStatus;
    totalDue: Prisma.Decimal;
    estimatedTotalDue: Prisma.Decimal;
    shortfall: Prisma.Decimal | null;
    firstShortfallDate: Date | null;
    /** What it takes to keep the minimum through the lowest point of the 30 days (>= shortfall). */
    peakShortfall: Prisma.Decimal | null;
    peakShortfallDate: Date | null;
    cards: CardDue[];
    minimumBalance: Prisma.Decimal | null;
    /** Statements on file that were found paid (muted lines). */
    paidLines: { nickname: string; amount: Prisma.Decimal; paidOn: Date }[];
  }
  const ccFundingAnalyses: FundingView[] = [];
  {
    const horizonStart = forecastStart;
    const horizonEnd = new Date(horizonStart.getTime() + 30 * 86400000);
    for (const acct of tdAccounts) {
      if (!acct.currentBalance) continue;
      const mine = cardProjections.filter((p) => p.funding?.accountId === acct.id);
      const dues = mine.flatMap((p) => cardDuesInWindow(p, horizonStart, horizonEnd));
      if (dues.length === 0) continue;
      const result = analyzeCardFunding({
        currentBalance: new Prisma.Decimal(acct.currentBalance.toString()),
        minimumBalance: acct.minimumBalance ? new Prisma.Decimal(acct.minimumBalance.toString()) : null,
        cards: dues,
        from: horizonStart,
        to: horizonEnd,
        otherFlows: nonCardEvents(acct.id, horizonStart, horizonEnd).map((e) => ({ date: e.date, amount: e.amount })),
      });
      ccFundingAnalyses.push({
        account: acct,
        status: result.status,
        totalDue: new Prisma.Decimal(result.totalDue.toString()),
        estimatedTotalDue: new Prisma.Decimal(result.estimatedTotalDue.toString()),
        shortfall: result.shortfall ? new Prisma.Decimal(result.shortfall.toString()) : null,
        firstShortfallDate: result.firstShortfallDate,
        peakShortfall: result.peakShortfall ? new Prisma.Decimal(result.peakShortfall.toString()) : null,
        peakShortfallDate: result.peakShortfallDate,
        cards: result.cards,
        minimumBalance: acct.minimumBalance ? new Prisma.Decimal(acct.minimumBalance.toString()) : null,
        // Only a payment from the last 30 days (older ones are history, not news).
        paidLines: mine.flatMap((p) =>
          p.onFile?.paid && p.onFile.paid.date.getTime() >= horizonStart.getTime() - 30 * 86400000
            ? [{ nickname: p.nickname, amount: p.onFile.amount, paidOn: p.onFile.paid.date }]
            : []
        ),
      });
    }
  }
  // Notes shown once, muted, under the funding cards.
  const cardNotes: string[] = [];
  if (cardLoad.error) {
    cardNotes.push("Credit card payments could not be loaded just now, so they are missing from the projections on this page.");
  }
  const undeterminedCards = cardProjections.filter(
    (p) => !p.funding && (p.onFile?.paid === null || p.estimates.length > 0)
  );
  if (undeterminedCards.length > 0) {
    cardNotes.push(
      `Funding account not determined for ${undeterminedCards.map((p) => p.nickname).join(", ")} (past payments do not clearly match one account), so ${undeterminedCards.length === 1 ? "that card is" : "those cards are"} not in the account projections.`
    );
  }
  for (const p of cardProjections) {
    if (p.estimates.length === 0 && p.skipReasons.length > 0 && (p.funding || p.onFile)) {
      cardNotes.push(`No next-statement estimate for ${p.nickname}: ${p.skipReasons.join("; ")}.`);
    }
  }

  // Build 90-day forecast for each TD checking account
  const accountForecasts = tdAccounts.map((acct) => {
    const startBal = acct.currentBalance
      ? new Prisma.Decimal(acct.currentBalance)
      : new Prisma.Decimal(0);
    const minBal = acct.minimumBalance
      ? new Prisma.Decimal(acct.minimumBalance)
      : null;

    // Gather events for this account over 90 days
    const transferEvents = transfers.flatMap((t) =>
      generateTransferOccurrences(t, forecastStart, forecastEnd90)
    ).filter((e) => e.accountId === acct.id);

    const incomeEvents = incomeSources.flatMap((s) =>
      generateIncomeOccurrences(s, forecastStart, forecastEnd90)
    ).filter((e) => e.accountId === acct.id);

    const billEvents = scheduledBills.flatMap((b) =>
      generateBillOccurrencesBudgetDated(b, budgetDates.index, forecastStart, forecastEnd90, billDraws(b), planForBill(seasonalLoad.plans, b))
    ).filter((e) => e.accountId === acct.id);

    // Credit card statement payments this account really pays (inferred from past payments, any entity's card):
    // the unpaid statement on file plus the estimated next statements (descriptions say "(estimate)").
    const cardEvents = cardProjections
      .filter((p) => p.funding?.accountId === acct.id)
      .flatMap((p) => cardPaymentEvents(p, forecastStart, forecastEnd90));

    const allEvents = [...transferEvents, ...incomeEvents, ...billEvents, ...cardEvents];
    const forecast = buildAccountForecast(startBal, allEvents, minBal, forecastStart, forecastEnd90);
    const breaches = findBreachDays(forecast);

    // Full 90-day chart data (client component slices to 30/60/90)
    const chartData90: ChartPoint[] = forecast.map((day) => ({
      label: day.date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
      balance: day.balanceAfter.toNumber(),
      isBreachDay: day.isBreachDay,
    }));

    // Weekly/monthly/quarterly rollups (server-computed — money/date math
    // stays in Decimal/Date land, never crosses into the client component).
    const fmtShort = (dt: Date) =>
      dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

    function toChartPoints(
      buckets: RollupBucket[],
      labelFor: (b: RollupBucket) => string
    ): ChartPoint[] {
      return buckets.map((b) => ({
        label: labelFor(b),
        balance: b.endingBalance.toNumber(),
        isBreachDay: b.hasBreach,
      }));
    }

    const chartDataWeekly = toChartPoints(
      rollupForecast(forecast, "weekly"),
      (b) => `Week ${b.index + 1} (${fmtShort(b.periodStart)}–${fmtShort(b.periodEnd)})`
    );
    const chartDataMonthly = toChartPoints(rollupForecast(forecast, "monthly"), (b) => {
      const label = b.periodStart.toLocaleDateString("en-US", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
      return `${label}${b.isPartial ? " (partial)" : ""}`;
    });
    const chartDataQuarterly = toChartPoints(rollupForecast(forecast, "quarterly"), (b) => {
      const q = Math.floor(b.periodStart.getUTCMonth() / 3) + 1;
      return `Q${q} ${b.periodStart.getUTCFullYear()}${b.isPartial ? " (partial)" : ""}`;
    });

    return {
      acct,
      forecast,
      breaches,
      chartData90,
      chartDataWeekly,
      chartDataMonthly,
      chartDataQuarterly,
      startBal,
      minBal,
    };
  });

  // 14-day schedule for Primary Checking (or the "Credit Cards" account when Primary Checking isn't present).
  // This is only which account the schedule is shown for; no card is assigned to an account by its nickname.
  const primaryAcct =
    tdAccounts.find((a) => a.nickname === "Primary Checking") ?? tdAccounts.find((a) => a.nickname === "Credit Cards");
  const schedule14: { date: string; description: string; amount: number; type: string }[] = [];

  if (primaryAcct) {
    const xferEvents = transfers.flatMap((t) =>
      generateTransferOccurrences(t, forecastStart, forecastEnd14)
    ).filter((e) => e.accountId === primaryAcct.id);

    const incEvents = incomeSources.flatMap((s) =>
      generateIncomeOccurrences(s, forecastStart, forecastEnd14)
    ).filter((e) => e.accountId === primaryAcct.id);

    const billEventsForSchedule = scheduledBills.flatMap((b) =>
      generateBillOccurrencesBudgetDated(b, budgetDates.index, forecastStart, forecastEnd14, billDraws(b), planForBill(seasonalLoad.plans, b))
    ).filter((e) => e.accountId === primaryAcct.id);

    // Card payments this account really pays (e.g. jetBlue from Primary Checking), estimates marked in the text.
    const cardEventsForSchedule = cardProjections
      .filter((p) => p.funding?.accountId === primaryAcct.id)
      .flatMap((p) => cardPaymentEvents(p, forecastStart, forecastEnd14));

    for (const ev of [...xferEvents, ...incEvents, ...billEventsForSchedule, ...cardEventsForSchedule].sort((a, b) => a.date.getTime() - b.date.getTime())) {
      schedule14.push({
        date: ev.date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }),
        description: ev.description,
        amount: ev.amount.toNumber(),
        type: ev.type,
      });
    }
  }

  // ── Category spend pace (Personal bucket only) ────────────────────────────
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const [pYear, pMonth] = period.split("-").map(Number) as [number, number];
  const monthStart = new Date(Date.UTC(pYear, pMonth - 1, 1));
  const monthEnd = new Date(Date.UTC(pYear, pMonth, 1));
  const historyStart = new Date(Date.UTC(pYear, pMonth - 1 - PACE_TRAILING_MONTHS, 1));

  const paceRows: TagPaceRow[] = [];
  if (entity?.slug === "personal") {
    // The current month's EFFECTIVE rows: from the first month with no Budget rows (2027-01) this is the carried
    // forward set; rollover is not carried (computeBudgetSummary then sees none).
    const paceBudgets = await loadEffectiveBudgetRows({ periods: [period], entityId: entity.id });

    const tagSpendRows = await db.$queryRaw<{ tagId: string; total: string }[]>`
      SELECT tt."tagId", SUM(t.amount)::text AS total
      FROM "Transaction" t
      JOIN "TransactionTag" tt ON tt."transactionId" = t.id
      WHERE t."entityId" = ${entity.id}
        AND t."archivedAt" IS NULL
        AND t."transferPairId" IS NULL
        AND t."postedAt" >= ${monthStart}
        AND t."postedAt" < ${monthEnd}
      GROUP BY tt."tagId"
    `;
    const spendByTagId = new Map(tagSpendRows.map((r) => [r.tagId, new Prisma.Decimal(r.total)]));

    const historyRows = await db.$queryRaw<{ tagId: string; period: string; total: string }[]>`
      SELECT tt."tagId" AS "tagId", to_char(t."postedAt", 'YYYY-MM') AS period, SUM(t.amount)::text AS total
      FROM "Transaction" t
      JOIN "TransactionTag" tt ON tt."transactionId" = t.id
      WHERE t."entityId" = ${entity.id}
        AND t."archivedAt" IS NULL
        AND t."transferPairId" IS NULL
        AND t."postedAt" >= ${historyStart}
        AND t."postedAt" < ${monthStart}
      GROUP BY tt."tagId", period
    `;
    const historyByTagId = new Map<string, { period: string; total: Prisma.Decimal }[]>();
    for (const row of historyRows) {
      const pts = historyByTagId.get(row.tagId) ?? [];
      pts.push({ period: row.period, total: new Prisma.Decimal(row.total) });
      historyByTagId.set(row.tagId, pts);
    }

    // Nesting/auto-sum resolution — same-account only. This is a per-tag
    // pace display, not a total, so no root-filtering is needed.
    const paceTagParentById = new Map(allTags.map((t) => [t.id, t.parentId]));
    const paceBudgetsByAccountId = new Map<string, typeof paceBudgets>();
    for (const b of paceBudgets) {
      if (!paceBudgetsByAccountId.has(b.accountId)) paceBudgetsByAccountId.set(b.accountId, []);
      paceBudgetsByAccountId.get(b.accountId)!.push(b);
    }
    const resolvedPaceBudgetById = new Map<string, Prisma.Decimal>();
    for (const group of paceBudgetsByAccountId.values()) {
      const resolverInput = group.map((b) => ({ id: b.id, tagId: b.tagId, budgeted: b.budgeted }));
      for (const [id, amt] of resolveBudgetedAmounts(resolverInput, (tagId) => paceTagParentById.get(tagId), new Prisma.Decimal(0))) {
        resolvedPaceBudgetById.set(id, amt);
      }
    }

    for (const b of paceBudgets) {
      const actualSpend = spendByTagId.get(b.tagId) ?? new Prisma.Decimal(0);
      // A seasonal line whose model gate has passed is measured against the model's estimate for this calendar month
      // (labelled on the row); a gated line keeps its budget figure.
      const seasonalPlan = planForLine(seasonalLoad.plans, b.entityId, b.tagId);
      const seasonalTarget = seasonalPlan ? planAmountForMonth(seasonalPlan, pMonth) : null;
      const flatBudget = resolvedPaceBudgetById.get(b.id) ?? new Prisma.Decimal(0);
      const summary = computeBudgetSummary({
        budgeted: seasonalTarget ?? flatBudget,
        rolloverAmount: b.rolloverAmount ?? new Prisma.Decimal(0),
        actualSpend,
      });
      if (summary.effectiveBudget.lessThanOrEqualTo(0)) continue;

      const spendForecast = projectPeriodEndSpend({
        period,
        spendToDate: actualSpend,
        asOfDate: forecastStart,
        history: historyByTagId.get(b.tagId) ?? [],
        trailingMonths: PACE_TRAILING_MONTHS,
      });

      const projectedPercentOfBudget = summary.effectiveBudget.isZero()
        ? 0
        : Math.min(
            spendForecast.projectedTotal.abs().div(summary.effectiveBudget.abs()).times(100).toNumber(),
            999
          );

      paceRows.push({
        tagId: b.tagId,
        tagName: b.tag.shortName,
        budgeted: summary.effectiveBudget.toNumber(),
        actualSpend: actualSpend.abs().toNumber(),
        projectedTotal: spendForecast.projectedTotal.abs().toNumber(),
        percentUsed: Math.round(summary.percentUsed),
        projectedPercentOfBudget: Math.round(projectedPercentOfBudget),
        confidence: spendForecast.confidence,
        method: spendForecast.method,
        trailingMonthsUsed: spendForecast.trailingMonthsUsed,
        ...(seasonalPlan && seasonalTarget
          ? {
              estimate: {
                confidence: seasonalPlan.confidence,
                basis: seasonalPlan.shortBasis,
                flatBudget: flatBudget.toNumber(),
                // Oil arrives in lumps, so a mid-month "over / under pace" flag would mislead: no flag for it.
                lumpy: seasonalPlan.kind === "oil",
              },
            }
          : {}),
      });
    }
    paceRows.sort((a, b) => b.projectedPercentOfBudget - a.projectedPercentOfBudget);
  }

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // ── Upcoming agenda (30 / 60 / 90 days) + "Looks recurring". Not loaded here: <UpcomingSections> loads them
  // behind a <Suspense> boundary (below) so they never hold up the rest of the page. Read-only and fail-soft: a
  // loader error shows a small notice in the agenda card and leaves every other section untouched. ──
  const upcomingHorizon = parseHorizon(params.horizon);
  const showTransfers = parseTransfersFlag(params.transfers);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Cash Flow Forecast</h1>
          <p className="text-sm text-muted-foreground">
            30-day projection based on scheduled transfers, bills, and income
          </p>
          {!isBusinessBucket && (
            <div className="space-y-0.5">
              <p className="text-xs text-muted-foreground">
                Paychecks are take-home pay (the Income Sources table below shows the basis for each). Bills are dated
                by their budget line when it has a date, because the money has to be in the account then; the bank may
                clear a bill a few days later.
              </p>
              {incomeSources.some((s) => s.netInfo.assumption) && (
                <p className="text-xs text-amber-700">
                  At least one paycheck uses its gross amount because its take-home is unknown (flagged in the Income
                  Sources table).
                </p>
              )}
              {budgetDates.failed && (
                <p className="text-xs text-muted-foreground">
                  Budget dates could not be read just now, so bills use the dates on their own records.
                </p>
              )}
              {seasonalLoad.plans.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {seasonalLoad.plans.length === 1 ? "One bill uses" : `${seasonalLoad.plans.length} bills use`} a seasonal estimate
                  instead of a flat amount (marked &quot;(estimate)&quot;); the basis is under Seasonal bills below.
                </p>
              )}
              {seasonalLoad.failed && (
                <p className="text-xs text-muted-foreground">
                  Seasonal estimates could not be read just now, so electric and oil bills use their flat amounts.
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── Balance panel ────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Current Balances</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {tdAccounts.map((acct) => {
                const isPlaid = acct.integrationMode === "plaid";
                const balanceNum = acct.currentBalance
                  ? decimalToNumber(new Prisma.Decimal(acct.currentBalance))
                  : null;
                const asOf = acct.currentBalanceAt
                  ? new Date(acct.currentBalanceAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                  : null;

                return isPlaid ? (
                  <div key={acct.id} className="space-y-1">
                    <p className="text-xs font-medium">
                      {acct.nickname}{acct.mask ? ` ···${acct.mask}` : ""}
                    </p>
                    <p className="text-base font-semibold tabular-nums">
                      {balanceNum !== null ? formatUSD(balanceNum) : <span className="text-muted-foreground">—</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {asOf ? `Synced ${asOf}` : "Not yet synced"}
                      {" · "}
                      <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">Auto</span>
                    </p>
                  </div>
                ) : (
                  <form
                    key={acct.id}
                    action={async (formData: FormData) => {
                      "use server";
                      await setAccountBalance(acct.id, formData.get("balance") as string);
                    }}
                    className="space-y-1"
                  >
                    <label className="text-xs font-medium">
                      {acct.nickname}{acct.mask ? ` ···${acct.mask}` : ""}
                    </label>
                    <div className="flex gap-1">
                      <input
                        name="balance"
                        type="number"
                        step="0.01"
                        defaultValue={balanceNum !== null ? balanceNum.toFixed(2) : ""}
                        placeholder="0.00"
                        className="w-28 rounded border px-2 py-1 text-sm"
                      />
                      <button type="submit" className="text-xs text-primary hover:underline">
                        Set
                      </button>
                    </div>
                    {asOf && <p className="text-xs text-muted-foreground">As of {asOf}</p>}
                  </form>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* ── Business-bucket financial forecast (Sudden Valley / EK Consulting) ── */}
        {isBusinessBucket && entity && businessAccounts.length > 0 && (
          <BusinessForecastSection entityName={entity.name} accounts={businessAccounts} />
        )}
        {isBusinessBucket && businessCarriedCaption && (
          <p className="text-xs text-muted-foreground" data-testid="carried-caption">
            {businessCarriedCaption}
          </p>
        )}

        {/* ── Breach warnings ──────────────────────────────────────────── */}
        {accountForecasts.some((af) => af.breaches.length > 0) && (
          <div className="space-y-2">
            <h2 className="text-base font-semibold text-destructive">⚠ Projected Minimum Balance Breaches</h2>
            <p className="text-xs text-muted-foreground">
              TD Bank accounts must stay ≥ $250 at all times. A dip below triggers a $15 service fee.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {accountForecasts
                .filter((af) => af.breaches.length > 0)
                .map(({ acct, breaches, minBal }) => (
                  <Card key={acct.id} className="border-destructive/50 bg-destructive/5">
                    <CardContent className="pt-4">
                      <p className="font-medium text-destructive">
                        {acct.nickname} ···{acct.mask}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {breaches.length} day{breaches.length !== 1 ? "s" : ""} projected below ${minBal?.toNumber() ?? 250}
                      </p>
                      <p className="text-sm">
                        First breach:{" "}
                        <span className="font-medium text-destructive">
                          {breaches[0]!.date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                        </span>
                        {" "}— projected balance{" "}
                        <span className="font-medium text-destructive">
                          {formatUSD(breaches[0]!.balanceAfter.toNumber())}
                        </span>
                      </p>
                    </CardContent>
                  </Card>
                ))}
            </div>
          </div>
        )}

        {/* ── Per-account balance charts (30/60/90 day selectable) ───── */}
        <div className="grid gap-6 lg:grid-cols-2">
          {accountForecasts.map(
            ({ acct, chartData90, chartDataWeekly, chartDataMonthly, chartDataQuarterly, minBal }) => (
              <ForecastAccountCard
                key={acct.id}
                accountName={acct.nickname}
                mask={acct.mask}
                minimumBalance={minBal?.toNumber() ?? null}
                currentBalance={acct.currentBalance ? Number(acct.currentBalance) : null}
                chartData90={chartData90}
                chartDataWeekly={chartDataWeekly}
                chartDataMonthly={chartDataMonthly}
                chartDataQuarterly={chartDataQuarterly}
              />
            )
          )}
        </div>

        {/* ── Credit card funding analysis: one card per account that really pays cards (inferred from past payments) ── */}
        {ccFundingAnalyses
          .filter((fa) => fa.cards.length > 0)
          .map((fa) => (
            <Card
              key={fa.account.id}
              className={
                fa.status === "shortfall"
                  ? "border-destructive/50"
                  : fa.status === "at_risk"
                  ? "border-amber-300"
                  : ""
              }
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Credit Card Funding — {fa.account.nickname}</CardTitle>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${
                      fa.status === "shortfall"
                        ? "border-red-200 bg-red-50 text-red-700"
                        : fa.status === "at_risk"
                        ? "border-amber-200 bg-amber-50 text-amber-700"
                        : "border-green-200 bg-green-50 text-green-700"
                    }`}
                  >
                    {fa.status === "shortfall"
                      ? "Shortfall — transfer needed"
                      : fa.status === "at_risk"
                      ? "Tight cushion"
                      : "Covered"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Statement payments draw from {fa.account.nickname} (x{fa.account.mask}), as seen in your past
                  payments. Every card is paid in full, so each line is the whole statement balance. The account
                  must also hold its ${fa.minimumBalance?.toNumber() ?? 250} minimum. The projection includes this
                  account&apos;s scheduled transfers, paychecks and bills, but not other deposits or spending.
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-2 font-medium whitespace-nowrap">Card</th>
                        <th className="py-2 px-3 font-medium text-right whitespace-nowrap">Statement due</th>
                        <th className="py-2 px-3 font-medium whitespace-nowrap">Due date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fa.cards.map((card) => {
                        const info = classifyCardDue(card.dueDate);
                        const otherEntity =
                          card.entityId && card.entityId !== fa.account.entityId
                            ? (entityNameById.get(card.entityId) ?? "another entity")
                            : null;
                        return (
                          <tr key={`${card.accountNickname}-${card.dueDate.toISOString()}`} className="border-b last:border-0 align-top">
                            <td className="py-2 font-medium">
                              {card.accountNickname}
                              {otherEntity && (
                                <span className="ml-2 text-xs font-normal text-muted-foreground">
                                  ({otherEntity} card)
                                </span>
                              )}
                            </td>
                            <td className="py-2 px-3 text-right tabular-nums text-amber-700 dark:text-amber-300 font-medium">
                              {card.estimate ? "~" : ""}
                              {formatUSD(card.statementBalance.toNumber())}
                              {card.estimate && (
                                <>
                                  {" "}
                                  <span
                                    className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium whitespace-nowrap text-amber-700"
                                    title={card.estimate.why}
                                  >
                                    estimate
                                  </span>
                                  <span className="block text-xs font-normal text-muted-foreground">
                                    Estimate {card.estimate.why}
                                  </span>
                                </>
                              )}
                            </td>
                            <td className="py-2 px-3">
                              <span
                                className={
                                  info.urgency === "overdue"
                                    ? "font-medium text-destructive"
                                    : info.urgency === "imminent"
                                    ? "font-medium text-amber-600"
                                    : "text-muted-foreground"
                                }
                              >
                                {formatCalendarDate(card.dueDate, "long")}
                                {info.urgency === "overdue" && " (overdue)"}
                                {info.urgency === "imminent" && " (tomorrow/today)"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t bg-muted/30">
                        <td className="py-2 font-semibold">Total due (30 days)</td>
                        <td className="py-2 px-3 text-right font-semibold tabular-nums">
                          {formatUSD(fa.totalDue.toNumber())}
                          {fa.estimatedTotalDue.greaterThan(0) && (
                            <span className="block text-xs font-normal text-muted-foreground">
                              includes ~{formatUSD(fa.estimatedTotalDue.toNumber())} of estimates
                            </span>
                          )}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {fa.status === "shortfall" && fa.shortfall && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm">
                    <p>
                      Current balance{" "}
                      <span className="font-medium">
                        {formatUSD(Number(fa.account.currentBalance ?? 0))}
                      </span>{" "}
                      — after all payments the account dips below the minimum on{" "}
                      <span className="font-medium text-destructive">
                        {fa.firstShortfallDate ? formatCalendarDate(fa.firstShortfallDate, "long") : null}
                      </span>
                      . Transfer{" "}
                      <span className="font-bold text-destructive">
                        {formatUSD(fa.shortfall.toNumber())}
                      </span>{" "}
                      to cover the payments and the minimum balance requirement and avoid the $15
                      monthly low balance fee
                      {shortfallIncludesEstimate(fa.cards, fa.firstShortfallDate) ? " (the amount includes estimated statements)" : ""}.
                      {fa.peakShortfall && fa.peakShortfallDate && fa.peakShortfall.greaterThan(fa.shortfall) && (
                        <>
                          {" "}
                          The balance keeps falling after that: covering every payment through{" "}
                          {formatCalendarDate(fa.peakShortfallDate, "long")} takes about{" "}
                          <span className="font-medium">{formatUSD(fa.peakShortfall.toNumber())}</span> in total
                          {fa.estimatedTotalDue.greaterThan(0) ? ", which includes estimated statements" : ""}.
                        </>
                      )}
                    </p>
                  </div>
                )}
                {fa.status === "at_risk" && (
                  <p className="text-xs text-amber-600">
                    Covered, but less than $50 of cushion remains after all payments — a small
                    surprise could trigger the low balance fee.
                  </p>
                )}
                {fa.status === "covered" && (
                  <p className="text-xs text-green-600">
                    All statement payments are covered while holding the minimum balance.
                  </p>
                )}
                {fa.paidLines.map((line) => (
                  <p key={line.nickname} className="text-xs text-muted-foreground">
                    {line.nickname}: the {formatUSD(line.amount.toNumber())} statement on file was paid{" "}
                    {formatCalendarDate(line.paidOn)}, so it is not counted above.
                  </p>
                ))}
              </CardContent>
            </Card>
          ))}
        {cardNotes.length > 0 && (
          <div className="space-y-1" data-testid="card-notes">
            {cardNotes.map((note) => (
              <p key={note} className="text-xs text-muted-foreground">
                {note}
              </p>
            ))}
          </div>
        )}

        {/* ── 14-day schedule for Primary Checking ────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Next 14 Days — Primary Checking</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {schedule14.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                No scheduled events in the next 14 days
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Description</th>
                    <th className="px-4 py-2 font-medium text-right">Amount</th>
                    <th className="px-4 py-2 font-medium">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule14.map((ev, i) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-4 py-2 text-muted-foreground">{ev.date}</td>
                      <td className="px-4 py-2">{ev.description}</td>
                      <td className={`px-4 py-2 text-right font-mono font-medium ${ev.amount < 0 ? "text-destructive" : "text-green-600"}`}>
                        {ev.amount < 0 ? "-" : "+"}
                        {formatUSD(Math.abs(ev.amount))}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant="outline" className="text-xs">
                          {ev.type.replace("_", " ")}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* ── Upcoming agenda: every dated bill / paycheck / deadline, de-duplicated (lib/upcoming-ledger.ts) ── */}
        {/* ── and Looks recurring: patterns learned from past transactions, outside every total (lib/recurring-detect.ts).
            Both load behind one Suspense boundary; the key makes a horizon / bucket / transfers change show the skeleton again. ── */}
        <Suspense
          key={`${bucket}|${upcomingHorizon}|${showTransfers ? 1 : 0}`}
          fallback={<UpcomingAgendaSkeleton horizon={upcomingHorizon} />}
        >
          <UpcomingSections
            entityId={entity?.id ?? null}
            isAggregate={entity === null}
            bucket={bucket}
            horizon={upcomingHorizon}
            showTransfers={showTransfers}
            now={now}
            tagOptions={toTagOptions(allTags)}
          />
        </Suspense>

        {/* ── Category spend pace (Personal bucket only) ──────────────── */}
        {entity?.slug === "personal" && paceRows.length > 0 && (
          <SpendPaceSection
            period={period}
            periodLabel={monthStart.toLocaleDateString("en-US", {
              month: "long",
              year: "numeric",
              timeZone: "UTC",
            })}
            rows={paceRows}
          />
        )}

        {/* ── Seasonal bills: Electric (Eversource) / Oil / Firewood estimates from existing payments + the oil price input ── */}
        <Suspense key={`seasonal|${bucket}`} fallback={null}>
          <SeasonalSections entityId={entity?.id ?? null} now={now} />
        </Suspense>

        {/* ── Recurring expenses ───────────────────────────────────────── */}
        <RecurringExpensesSection
          expenses={recurringExpenses.map((e) => ({
            ...e,
            nextDueDate: e.nextDueDate ? new Date(e.nextDueDate) : null,
            tag: e.tag ?? null,
          }))}
          entities={entities.map((e) => ({ id: e.id, name: e.name }))}
          tags={allTags.map((t) => ({ id: t.id, name: t.name, shortName: t.shortName }))}
          defaultEntityId={entity?.id ?? entities[0]?.id ?? ""}
        />

        {/* ── Rental bookings (Sudden Valley only — the only entity with Airbnb
             revenue; EK Consulting's revenue is manually entered via ProjectedRevenue) ── */}
        {entity?.slug === "sudden-valley" && (
          <div id="rental-bookings" className="scroll-mt-20">
            <RentalBookingsSection
              entityId={entity.id}
              entityName={entity.name}
              bookings={rentalBookings.map((b) => ({
                ...b,
                startDate: new Date(b.startDate),
                endDate: new Date(b.endDate),
                payoutDate: new Date(b.payoutDate),
              }))}
            />
          </div>
        )}

        {/* ── Income sources (Personal only — business buckets get revenue from
             their Revenue page, wired into the Business Forecast section above) ── */}
        {!isBusinessBucket && (
        <Card>
          <CardHeader>
            <CardTitle>Income Sources</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {incomeSources.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="px-0 py-2 font-medium">Description</th>
                    <th className="px-4 py-2 font-medium">Cadence</th>
                    <th className="px-4 py-2 font-medium text-right">Take-home used</th>
                    <th className="px-4 py-2 font-medium text-right">Gross</th>
                    <th className="px-4 py-2 font-medium">Account</th>
                  </tr>
                </thead>
                <tbody>
                  {incomeSources.map((s) => {
                    const rules = s.dayRules as Record<string, unknown>;
                    let cadenceLabel = s.cadence;
                    if (s.cadence === "semi_monthly") {
                      const days = rules["daysOfMonth"] as number[] | undefined;
                      cadenceLabel = `Semi-monthly (${days?.join(" & ")})`;
                    } else if (s.cadence === "biweekly") {
                      cadenceLabel = "Biweekly";
                    }
                    return (
                      <tr key={s.id} className="border-b last:border-0">
                        <td className="px-0 py-2 font-medium">
                          {s.description}
                          <p
                            className={`text-xs font-normal ${s.netInfo.assumption ? "text-amber-700" : "text-muted-foreground"}`}
                          >
                            {s.netInfo.label}
                          </p>
                          {s.netInfo.timing && (
                            <p className="text-xs font-normal text-muted-foreground">{s.netInfo.timing.text}</p>
                          )}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">{cadenceLabel}</td>
                        <td
                          className={`px-4 py-2 text-right font-medium ${s.netInfo.assumption ? "text-amber-700" : "text-green-600"}`}
                        >
                          {s.netInfo.variable ? "~" : ""}+{formatUSD(decimalToNumber(new Prisma.Decimal(s.amount)))}
                          {s.netInfo.assumption && <span className="block text-xs font-normal">gross, take-home unknown</span>}
                        </td>
                        <td className="px-4 py-2 text-right text-muted-foreground">
                          {formatUSD(decimalToNumber(new Prisma.Decimal(s.grossAmount)))}
                        </td>
                        <td className="px-4 py-2 text-xs text-muted-foreground">
                          {s.account ? `${s.account.nickname} ···${s.account.mask ?? ""}` : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {/* Add income source form */}
            <div className="border-t pt-4">
              <p className="mb-3 text-sm font-medium">Add income source</p>
              <form
                action={async (formData: FormData) => {
                  "use server";
                  const cadence = formData.get("cadence") as string;
                  let dayRules: Record<string, unknown>;
                  if (cadence === "semi_monthly") {
                    dayRules = { daysOfMonth: [15, 30] };
                  } else if (cadence === "biweekly") {
                    const anchor = formData.get("anchorDate") as string;
                    dayRules = { intervalDays: 14, anchorDate: anchor };
                  } else {
                    dayRules = { daysOfMonth: [1] };
                  }
                  await upsertIncomeSource({
                    entityId: formData.get("entityId") as string,
                    accountId: formData.get("accountId") as string,
                    description: formData.get("description") as string,
                    cadence: cadence as "semi_monthly" | "biweekly" | "monthly" | "weekly",
                    dayRules,
                    amount: formData.get("amount") as string,
                    active: true,
                  });
                }}
                className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              >
                <div className="space-y-1">
                  <label className="text-xs font-medium">Description</label>
                  <input
                    name="description"
                    placeholder="e.g. Eric payroll"
                    className="w-full rounded border px-2 py-1.5 text-sm"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Cadence</label>
                  <select name="cadence" className="w-full rounded border px-2 py-1.5 text-sm" required>
                    <option value="semi_monthly">Semi-monthly (15th & 30th)</option>
                    <option value="biweekly">Biweekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="weekly">Weekly</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Gross amount per paycheck</label>
                  <input
                    name="amount"
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    className="w-full rounded border px-2 py-1.5 text-sm"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">First paycheck date (biweekly only)</label>
                  <input
                    name="anchorDate"
                    type="date"
                    className="w-full rounded border px-2 py-1.5 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Entity</label>
                  <select name="entityId" className="w-full rounded border px-2 py-1.5 text-sm" required>
                    {entities.map((e) => (
                      <option key={e.id} value={e.id}>{e.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">Deposits into</label>
                  <select name="accountId" className="w-full rounded border px-2 py-1.5 text-sm" required>
                    {tdAccounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.nickname} ···{a.mask}</option>
                    ))}
                  </select>
                </div>
                <div className="lg:col-span-3">
                  <button
                    type="submit"
                    className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Add Income Source
                  </button>
                </div>
              </form>
            </div>
          </CardContent>
        </Card>
        )}
      </div>
    </AppShell>
  );
}

/**
 * The Seasonal bills card(s), loaded behind <Suspense>. Read-only and fail-soft: on an error one muted line says the
 * budget figures are in use. The page has already run auth() before this component is rendered. Shows the entity in
 * view only; the all-entities view shows every entity that has seasonal lines.
 */
async function SeasonalSections({ entityId, now }: { entityId: string | null; now: Date }) {
  const loaded = await loadSeasonalEnergySafe({ now });
  if (loaded.failed) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="seasonal-unavailable">
        Seasonal estimates could not be read just now, so the budget and bill figures are in use.
      </p>
    );
  }
  const sites = loaded.sites
    .filter((s) => entityId === null || s.entityId === entityId)
    .map((s) => toUiSite(s, now, { pricesCorrupt: loaded.pricesCorrupt.includes(s.entityId) }));
  return <SeasonalCard sites={sites} />;
}

/**
 * The Upcoming agenda and the "Looks recurring" review list, loaded behind <Suspense>. Fail-soft exactly as before
 * the move: a ledger error shows the agenda's small notice (ledger = null) and no recurring card; a failure of only
 * the pattern checks shows the muted "unavailable" line. Read-only; the page has already run auth() before this
 * component is ever rendered.
 */
async function UpcomingSections({
  entityId,
  isAggregate,
  bucket,
  horizon,
  showTransfers,
  now,
  tagOptions,
}: {
  entityId: string | null;
  isAggregate: boolean;
  bucket: string;
  horizon: Horizon;
  showTransfers: boolean;
  now: Date;
  /** All budget tags (full path), for the inline Add step; the page already loaded them. */
  tagOptions: UiTagOption[];
}) {
  // Read-only numbers for the Add step's pre-confirm Budgets notice; never rejects (null = the read failed), runs beside the ledger.
  const budgetFactsPromise = loadBudgetHints({ entityId, now });
  let upcoming: UiLedger | null = null;
  // undefined = the ledger itself failed (nothing extra to say); null = only the pattern checks failed.
  let upcomingDetection: UiDetection | null | undefined;
  try {
    const loaded = await loadUpcomingLedger({ entityId, days: horizon, now });
    upcoming = toUiLedger(loaded.ledger, {
      days: horizon,
      bucketSlug: bucket,
      isAggregate,
      entityNameById: loaded.entityNameById,
      entitySlugById: loaded.entitySlugById,
      accountNameById: loaded.accountNameById,
      includeTransfers: showTransfers,
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
  return (
    <>
      <UpcomingAgenda ledger={upcoming} bucketSlug={bucket} horizon={horizon} showTransfers={showTransfers} />
      <RecurringSuggestions detection={upcomingDetection} isAggregate={isAggregate} tagOptions={tagOptions} budgetFacts={await budgetFactsPromise} />
    </>
  );
}
