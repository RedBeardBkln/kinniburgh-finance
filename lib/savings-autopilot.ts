import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";

export interface SavingsRecommendation {
  monthsOfData: number;
  hasEnoughData: boolean;
  avgMonthlyIncomeCents: number;
  avgMonthlyExpensesCents: number;
  avgMonthlySurplusCents: number;
  recommendedMonthlyCents: number;
}

export async function computeSavingsRecommendation(
  entityId: string
): Promise<SavingsRecommendation> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const transactions = await db.transaction.findMany({
    where: {
      entityId,
      archivedAt: null,
      transferPairId: null,
      postedAt: { gte: ninetyDaysAgo },
    },
    select: { postedAt: true, amount: true },
  });

  // Group by YYYY-MM
  const monthMap = new Map<string, { incomeCents: number; expenseCents: number }>();
  for (const tx of transactions) {
    const key = `${tx.postedAt.getUTCFullYear()}-${String(tx.postedAt.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!monthMap.has(key)) monthMap.set(key, { incomeCents: 0, expenseCents: 0 });
    const bucket = monthMap.get(key)!;
    const amountCents = Math.round((tx.amount as Prisma.Decimal).toNumber() * 100);
    if (amountCents > 0) {
      bucket.incomeCents += amountCents;
    } else {
      bucket.expenseCents += Math.abs(amountCents);
    }
  }

  const monthsOfData = monthMap.size;
  if (monthsOfData === 0) {
    return {
      monthsOfData: 0,
      hasEnoughData: false,
      avgMonthlyIncomeCents: 0,
      avgMonthlyExpensesCents: 0,
      avgMonthlySurplusCents: 0,
      recommendedMonthlyCents: 0,
    };
  }

  const months = Array.from(monthMap.values());
  const totalIncome = months.reduce((s, m) => s + m.incomeCents, 0);
  const totalExpenses = months.reduce((s, m) => s + m.expenseCents, 0);
  const avgMonthlyIncomeCents = Math.round(totalIncome / monthsOfData);
  const avgMonthlyExpensesCents = Math.round(totalExpenses / monthsOfData);
  const avgMonthlySurplusCents = avgMonthlyIncomeCents - avgMonthlyExpensesCents;
  const recommendedMonthlyCents = Math.max(0, Math.floor(avgMonthlySurplusCents * 0.2));

  return {
    monthsOfData,
    hasEnoughData: monthsOfData >= 2,
    avgMonthlyIncomeCents,
    avgMonthlyExpensesCents,
    avgMonthlySurplusCents,
    recommendedMonthlyCents,
  };
}
