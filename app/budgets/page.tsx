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
import { monthlyEquivalentCents } from "@/actions/recurring-expenses";

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

  const [budgets, accounts, tags, recurringExpenses] = await Promise.all([
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

  // Serialize budget lines with computed summaries
  const serializedBudgets: SerializedBudgetLine[] = budgets.map((b) => {
    const actual = spendByTagId.get(b.tagId) ?? new Prisma.Decimal(0);
    const tagExpenses = recurringByTagId.get(b.tagId) ?? [];
    const recurringMonthlySumCents = tagExpenses.reduce((s, e) => s + e.monthlyEquivCents, 0);
    const additionalAmountCents = decimalToNumber(new Prisma.Decimal((b as { additionalAmountCents?: unknown }).additionalAmountCents ?? 0));

    // Effective budgeted = recurring monthly sum + additional (in dollars, for budget calcs)
    const effectiveBudgetedDollars = tagExpenses.length > 0
      ? (recurringMonthlySumCents + additionalAmountCents) / 100
      : decimalToNumber(new Prisma.Decimal(b.budgeted));

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
      payDay: b.payDay,
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

  // Totals
  const totalBudgeted = serializedBudgets.reduce((s, b) => s + b.budgeted, 0);
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
          tags={tags.map((t) => ({ id: t.id, name: t.name, shortName: t.shortName }))}
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
