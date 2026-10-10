import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { computeBudgetSummary } from "@/lib/budget";
import { decimalToNumber } from "@/lib/utils";
import { Prisma } from "@prisma/client";
import { PeriodPicker } from "@/components/period-picker";
import { assessAnnualFunding, assessAccountReserve, cycleMonthsFor, isLumpSumFrequency } from "@/lib/annual-bill";
import { exportBudgetCsv } from "@/actions/reports";
import { ExportCsvButton } from "@/components/export-csv-button";
import {
  BudgetPageClient,
  type SerializedBudgetLine,
} from "@/components/budgets/budget-page-client";
import { monthlyEquivalentCents } from "@/lib/recurring-expenses";
import { resolveEffectiveBudgets } from "@/lib/budget-effective";
import { buildMonthSpend, currentPeriodNY, isValidPeriod } from "@/lib/month-spend";
import { loadMonthTransactions } from "@/lib/month-spend-build";
import { loadOwnAccountByMask } from "@/lib/own-account-masks-build";
import { centsText } from "@/lib/dashboard-drill";
import { toCents as decimalToCents } from "@/lib/dashboard-drill-build";

interface PageProps {
  searchParams: Promise<{ bucket?: string; period?: string }>;
}

export default async function BudgetsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const bucket = params.bucket ?? "personal";

  const now = new Date();
  // The New York month (not the UTC one), the same as the dashboard.
  const defaultPeriod = currentPeriodNY(now);
  const period = params.period && isValidPeriod(params.period) ? params.period : defaultPeriod;

  const entity = await getEntityBySlug(bucket);
  const bucketLabel = entity?.navLabel ?? entity?.name ?? "All Entities";

  const [budgets, accounts, tags, recurringExpenses, budgetedTagIdsAllEntities] = await Promise.all([
    db.budget.findMany({
      where: { ...(entity && { entityId: entity.id }), period },
      include: { tag: true, account: { include: { institution: true } } },
      orderBy: [{ account: { nickname: "asc" } }, { tag: { name: "asc" } }],
    }),
    db.account.findMany({
      where: { archivedAt: null, accountType: { in: ["checking", "savings"] } },
      orderBy: { nickname: "asc" },
    }),
    db.tag.findMany({ orderBy: { name: "asc" } }),
    db.recurringExpense.findMany({
      where: entity ? { entityId: entity.id } : {},
      orderBy: { name: "asc" },
    }),
    // A tag can only have one budget line per period across the whole
    // household — once any entity has budgeted it, it's off the table for
    // every other entity too. Scoped by period only (not entityId).
    db.budget.findMany({ where: { period }, select: { tagId: true } }),
  ]);

  // Build monthly sum per tagId for recurring expenses
  const recurringByTagId = new Map<string, Array<{ id: string; name: string; amountCents: number; frequency: string; monthlyEquivCents: number }>>();
  for (const exp of recurringExpenses) {
    if (!exp.tagId) continue;
    const monthly = monthlyEquivalentCents(exp.amountCents, exp.frequency);
    if (!recurringByTagId.has(exp.tagId)) recurringByTagId.set(exp.tagId, []);
    recurringByTagId.get(exp.tagId)!.push({ id: exp.id, name: exp.name, amountCents: exp.amountCents, frequency: exp.frequency, monthlyEquivCents: monthly });
  }

  // Amounts per line: recurring-linked amount, then the stored amount, then the auto-sum of nested lines (one shared
  // resolver with the dashboard, so the two screens agree on Total Budgeted).
  const tagParentById = new Map(tags.map((t) => [t.id, t.parentId]));
  const effective = resolveEffectiveBudgets(
    budgets.map((b) => ({ id: b.id, tagId: b.tagId, accountId: b.accountId, budgeted: b.budgeted, additionalAmountCents: b.additionalAmountCents })),
    recurringExpenses.map((e) => ({ tagId: e.tagId, amountCents: e.amountCents, frequency: e.frequency })),
    (tagId) => tagParentById.get(tagId)
  );
  const resolvedByBudgetId = effective.resolvedById;
  const rootBudgetIds = effective.rootIds;

  // Spend per line: the same model as the dashboard (lib/month-spend.ts). A line owns its tag's spending and that of
  // its un-budgeted sub-tags; a parent shows its nested lines too.
  const monthTxs = await loadMonthTransactions({ entityId: entity?.id ?? null, period });
  const spendModel = buildMonthSpend(
    monthTxs,
    tags,
    budgets.map((b) => ({
      id: b.id,
      tagId: b.tagId,
      accountId: b.accountId,
      resolved: resolvedByBudgetId.get(b.id) ?? new Prisma.Decimal(0),
      explicit: effective.explicitById.get(b.id) ?? null,
      rollover: new Prisma.Decimal(b.rolloverAmount ?? 0),
    })),
    { ownAccountByMask: await loadOwnAccountByMask() }
  );
  const rolledSpendByBudgetId = new Map(spendModel.lines.map((l) => [l.id, l.rolledSpend]));

  // Serialize budget lines with computed summaries
  const annualByAccountId = new Map<string, number[]>();
  const serializedBudgets: SerializedBudgetLine[] = budgets.map((b) => {
    // Signed like a ledger amount (negative = money out), as the Budgets screen has always shown it.
    const actual = (rolledSpendByBudgetId.get(b.id) ?? new Prisma.Decimal(0)).negated();
    const tagExpenses = recurringByTagId.get(b.tagId) ?? [];
    const recurringMonthlySumCents = tagExpenses.reduce((s, e) => s + e.monthlyEquivCents, 0);
    const additionalAmountCents = decimalToNumber(new Prisma.Decimal(b.additionalAmountCents ?? 0));

    // Annual lines: does the monthly set-aside add up to the total due by the due date?
    const annual =
      isLumpSumFrequency(b.frequency) &&
      b.payMonth !== null &&
      b.payDay !== null &&
      b.annualAmountDue !== null &&
      b.budgeted !== null
        ? assessAnnualFunding({
            monthlyCents: toCents(new Prisma.Decimal(b.budgeted)),
            totalDueCents: toCents(new Prisma.Decimal(b.annualAmountDue)),
            dueMonth: b.payMonth,
            dueDay: b.payDay,
            cycleMonths: cycleMonthsFor(b.frequency),
            today: now,
          })
        : null;
    if (annual) annualByAccountId.set(b.accountId, [...(annualByAccountId.get(b.accountId) ?? []), annual.accruedToDateCents]);

    // Effective budgeted = resolved (recurring / explicit / auto-summed) amount
    const effectiveBudgetedDollars = decimalToNumber(resolvedByBudgetId.get(b.id) ?? new Prisma.Decimal(0));

    const summary = computeBudgetSummary({
      budgeted: new Prisma.Decimal(effectiveBudgetedDollars),
      rolloverAmount: new Prisma.Decimal(b.rolloverAmount ?? 0),
      actualSpend: actual,
    });
    return {
      id: b.id,
      tagId: b.tagId,
      tagName: b.tag.shortName,
      accountId: b.accountId,
      accountName: b.account.nickname,
      budgeted: decimalToNumber(summary.budgeted),
      budgetedRaw: b.budgeted !== null ? decimalToNumber(new Prisma.Decimal(b.budgeted)) : null,
      payDay: b.payDay,
      frequency: b.frequency,
      payDayOfWeek: b.payDayOfWeek,
      biweeklyAnchorDate: b.biweeklyAnchorDate?.toISOString() ?? null,
      payMonth: b.payMonth,
      annualAmountDue: b.annualAmountDue !== null ? decimalToNumber(new Prisma.Decimal(b.annualAmountDue)) : null,
      annualStatus: annual
        ? {
            nextDueDate: annual.nextDueDate.toISOString().slice(0, 10),
            accruedToDate: annual.accruedToDateCents / 100,
            projectedAtDue: annual.projectedAtDueCents / 100,
            shortfall: annual.shortfallCents / 100,
            requiredMonthly: annual.requiredMonthlyCents / 100,
            isUnderfunded: annual.isUnderfunded,
          }
        : null,
      rolloverAmount: decimalToNumber(summary.rolloverAmount),
      effectiveBudget: decimalToNumber(summary.effectiveBudget),
      actualSpend: decimalToNumber(summary.actualSpend),
      remaining: decimalToNumber(summary.remaining),
      percentUsed: summary.percentUsed,
      isOverspent: summary.isOverspent,
      recurringExpenses: tagExpenses,
      recurringMonthlySumCents,
      additionalAmountCents,
    };
  });

  // Account-level check: an account holding annual bills' accruing funds should
  // actually hold at least what those bills have accrued by now.
  const annualReserveAlerts = budgets
    .filter((b, i, arr) => arr.findIndex((x) => x.accountId === b.accountId) === i)
    .flatMap((b) => {
      const accrued = annualByAccountId.get(b.accountId);
      if (!accrued) return [];
      const balance = b.account.currentBalance;
      const reserve = assessAccountReserve(
        balance !== null ? toCents(new Prisma.Decimal(balance)) : null,
        accrued
      );
      if (!reserve?.isShort) return [];
      return [
        {
          accountName: b.account.nickname,
          balance: decimalToNumber(new Prisma.Decimal(balance ?? 0)),
          balanceAsOf: b.account.currentBalanceAt?.toISOString().slice(0, 10) ?? null,
          reserved: reserve.reservedCents / 100,
          shortfall: reserve.shortfallCents / 100,
        },
      ];
    });

  // Totals — root-only sum so a parent and its children are never both counted.
  const totalBudgeted = serializedBudgets
    .filter((b) => rootBudgetIds.has(b.id))
    .reduce((s, b) => s + b.budgeted, 0);
  // Total Spent is the dashboard's Spent for the same month: every line's spending plus what no line claims.
  const totalActual = -decimalToNumber(spendModel.spent);
  const totalRemaining = totalBudgeted + totalActual; // totalActual is negative
  const outsideLines = spendModel.notInAnyLine.reduce((sum, b) => sum.plus(b.spend), new Prisma.Decimal(0)).plus(spendModel.untagged.spend);
  const spentNote = outsideLines.isZero()
    ? null
    : `Includes ${centsText(decimalToCents(outsideLines))} not in any budget line` +
      (spendModel.untagged.txIds.length > 0 ? ` (${centsText(decimalToCents(spendModel.untagged.spend))} untagged)` : "");

  // Build period options (Jan–Dec of current year)
  const periodOptions = Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, "0");
    const p = `${now.getUTCFullYear()}-${m}`;
    return { value: p, label: formatPeriod(p) };
  });

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-4">
        <div className="flex items-center justify-end gap-2">
          <ExportCsvButton
            filename={`budget-${period}-${bucket}.csv`}
            action={exportBudgetCsv.bind(null, period)}
          />
          <PeriodPicker period={period} bucket={bucket} options={periodOptions} />
        </div>

        <BudgetPageClient
          budgets={serializedBudgets}
          accounts={accounts.map((a) => ({ id: a.id, nickname: a.nickname, mask: a.mask }))}
          tags={tags.map((t) => ({ id: t.id, name: t.name, shortName: t.shortName, parentId: t.parentId }))}
          budgetedTagIdsAllEntities={budgetedTagIdsAllEntities.map((b) => b.tagId)}
          entityId={entity?.id ?? ""}
          period={period}
          totalBudgeted={totalBudgeted}
          totalActual={totalActual}
          spentNote={spentNote}
          totalRemaining={totalRemaining}
          periodLabel={formatPeriod(period)}
          entityName={bucketLabel}
          annualReserveAlerts={annualReserveAlerts}
        />
      </div>
    </AppShell>
  );
}

function toCents(d: Prisma.Decimal): number {
  return d.times(100).toDecimalPlaces(0).toNumber();
}

function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}
