import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { getEntityBySlug } from "@/lib/entity";
import { computeBudgetSummary } from "@/lib/budget";
import { decimalToNumber } from "@/lib/utils";
import { Prisma } from "@prisma/client";
import { PeriodPicker } from "@/components/period-picker";
import { exportBudgetCsv } from "@/actions/reports";
import { ExportCsvButton } from "@/components/export-csv-button";
import {
  BudgetPageClient,
  type SerializedBudgetLine,
} from "@/components/budgets/budget-page-client";
import { monthlyEquivalentCents } from "@/lib/recurring-expenses";
import { resolveBudgetedAmounts, getRootBudgetLineIds } from "@/lib/budget-nesting";

interface PageProps {
  searchParams: Promise<{ bucket?: string; period?: string }>;
}

export default async function BudgetsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const bucket = params.bucket ?? "personal";

  const now = new Date();
  const defaultPeriod = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const period = params.period ?? defaultPeriod;

  const [year, mon] = period.split("-").map(Number);
  const monthStart = new Date(Date.UTC(year!, mon! - 1, 1));
  const monthEnd = new Date(Date.UTC(year!, mon!, 1));

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

  // Per-tag actual spend this month
  const tagSpend = entity
    ? await db.$queryRaw<{ tagId: string; total: string }[]>`
        SELECT tt."tagId", SUM(t.amount)::text AS total
        FROM "Transaction" t
        JOIN "TransactionTag" tt ON tt."transactionId" = t.id
        WHERE t."entityId" = ${entity.id}
          AND t."archivedAt" IS NULL
          AND t."transferPairId" IS NULL
          AND t."postedAt" >= ${monthStart}
          AND t."postedAt" < ${monthEnd}
        GROUP BY tt."tagId"
      `
    : await db.$queryRaw<{ tagId: string; total: string }[]>`
        SELECT tt."tagId", SUM(t.amount)::text AS total
        FROM "Transaction" t
        JOIN "TransactionTag" tt ON tt."transactionId" = t.id
        WHERE t."archivedAt" IS NULL
          AND t."transferPairId" IS NULL
          AND t."postedAt" >= ${monthStart}
          AND t."postedAt" < ${monthEnd}
        GROUP BY tt."tagId"
      `;

  const spendByTagId = new Map<string, Prisma.Decimal>(
    tagSpend.map((r) => [r.tagId, new Prisma.Decimal(r.total)])
  );

  // Nesting/auto-sum resolution — same-account only (matches nestBudgetLines).
  // Precedence per line: recurring-linked effective amount (real linked-bill
  // data) wins over auto-sum from children; explicit non-null `budgeted` wins
  // next; auto-sum from children is the fallback when neither applies.
  const tagParentById = new Map(tags.map((t) => [t.id, t.parentId]));
  const explicitAmountByBudgetId = new Map<string, Prisma.Decimal | null>();
  for (const b of budgets) {
    const tagExpenses = recurringByTagId.get(b.tagId) ?? [];
    if (tagExpenses.length > 0) {
      const recurringMonthlySumCents = tagExpenses.reduce((s, e) => s + e.monthlyEquivCents, 0);
      const additionalAmountCents = decimalToNumber(new Prisma.Decimal(b.additionalAmountCents ?? 0));
      explicitAmountByBudgetId.set(b.id, new Prisma.Decimal((recurringMonthlySumCents + additionalAmountCents) / 100));
    } else {
      explicitAmountByBudgetId.set(b.id, b.budgeted);
    }
  }

  const byAccountId = new Map<string, typeof budgets>();
  for (const b of budgets) {
    if (!byAccountId.has(b.accountId)) byAccountId.set(b.accountId, []);
    byAccountId.get(b.accountId)!.push(b);
  }
  const resolvedByBudgetId = new Map<string, Prisma.Decimal>();
  const rootBudgetIds = new Set<string>();
  for (const group of byAccountId.values()) {
    const resolverInput = group.map((b) => ({
      id: b.id,
      tagId: b.tagId,
      budgeted: explicitAmountByBudgetId.get(b.id) ?? null,
    }));
    for (const [id, amt] of resolveBudgetedAmounts(resolverInput, (tagId) => tagParentById.get(tagId), new Prisma.Decimal(0))) {
      resolvedByBudgetId.set(id, amt);
    }
    for (const id of getRootBudgetLineIds(group, (tagId) => tagParentById.get(tagId))) {
      rootBudgetIds.add(id);
    }
  }

  // Serialize budget lines with computed summaries
  const serializedBudgets: SerializedBudgetLine[] = budgets.map((b) => {
    const actual = spendByTagId.get(b.tagId) ?? new Prisma.Decimal(0);
    const tagExpenses = recurringByTagId.get(b.tagId) ?? [];
    const recurringMonthlySumCents = tagExpenses.reduce((s, e) => s + e.monthlyEquivCents, 0);
    const additionalAmountCents = decimalToNumber(new Prisma.Decimal(b.additionalAmountCents ?? 0));

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

  // Totals — root-only sum so a parent and its children are never both counted.
  const totalBudgeted = serializedBudgets
    .filter((b) => rootBudgetIds.has(b.id))
    .reduce((s, b) => s + b.budgeted, 0);
  const totalActual = serializedBudgets.reduce((s, b) => s + b.actualSpend, 0);
  const totalRemaining = totalBudgeted + totalActual; // actualSpend is negative

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
          totalRemaining={totalRemaining}
          periodLabel={formatPeriod(period)}
          entityName={bucketLabel}
        />
      </div>
    </AppShell>
  );
}

function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}
