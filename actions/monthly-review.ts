"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

interface ReviewData {
  period: string;
  generatedAt: string;
  budgetHealth: Array<{
    tagName: string;
    entityName: string;
    budgetedCents: number;
    actualCents: number;
    percentUsed: number;
    status: "ok" | "warning" | "over";
  }>;
  accountSnapshot: Array<{
    nickname: string;
    balanceCents: number;
    minimumCents: number | null;
    marginCents: number | null;
  }>;
  upcomingBills: Array<{
    payee: string;
    amountCents: number | null;
    autopayDay: number | null;
    entityName: string;
  }>;
  accrualStatus: Array<{
    name: string;
    currentCents: number;
    targetCents: number;
    proRataCents: number;
    pct: number;
    status: "on_track" | "watch" | "behind";
  }>;
}

export async function generateMonthlyReview(
  period: string
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return { error: "Invalid period format — expected YYYY-MM" };

  const year = parseInt(match[1]!);
  const month = parseInt(match[2]!);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));

  // ── Budget health ────────────────────────────────────────────────────────────
  const budgets = await db.budget.findMany({
    where: { period },
    include: { tag: true, entity: true },
  });

  // Single cross-entity tag spend query for the period
  const tagSpendRows = await db.$queryRaw<{ entityId: string; tagId: string; total: string }[]>`
    SELECT t."entityId", tt."tagId", SUM(t.amount)::text AS total
    FROM "Transaction" t
    JOIN "TransactionTag" tt ON tt."transactionId" = t.id
    WHERE t."archivedAt" IS NULL
      AND t."transferPairId" IS NULL
      AND t."postedAt" >= ${monthStart}
      AND t."postedAt" < ${monthEnd}
    GROUP BY t."entityId", tt."tagId"
  `;

  const spendMap = new Map<string, number>();
  for (const row of tagSpendRows) {
    const key = `${row.entityId}:${row.tagId}`;
    spendMap.set(key, Math.round(Math.abs(parseFloat(row.total)) * 100));
  }

  const budgetHealth: ReviewData["budgetHealth"] = budgets.map((b) => {
    const budgetedCents = Math.round(new Prisma.Decimal(b.budgeted).toNumber() * 100);
    const actualCents = spendMap.get(`${b.entityId}:${b.tagId}`) ?? 0;
    const percentUsed = budgetedCents > 0 ? Math.round((actualCents / budgetedCents) * 100) : 0;
    const status: "ok" | "warning" | "over" =
      percentUsed > 100 ? "over" : percentUsed > 80 ? "warning" : "ok";
    return {
      tagName: b.tag.shortName,
      entityName: b.entity.name,
      budgetedCents,
      actualCents,
      percentUsed,
      status,
    };
  });

  // ── Account snapshot (personal entity) ──────────────────────────────────────
  const personalEntity = await db.entity.findFirst({ where: { name: "Personal" } });
  const accountSnapshot: ReviewData["accountSnapshot"] = [];

  if (personalEntity) {
    const accounts = await db.account.findMany({
      where: {
        entityId: personalEntity.id,
        archivedAt: null,
        currentBalance: { not: null },
      },
      orderBy: { nickname: "asc" },
    });

    for (const acct of accounts) {
      const balanceCents = Math.round(
        (acct.currentBalance as Prisma.Decimal).toNumber() * 100
      );
      const minimumCents =
        acct.minimumBalance != null
          ? Math.round((acct.minimumBalance as Prisma.Decimal).toNumber() * 100)
          : null;
      accountSnapshot.push({
        nickname: acct.nickname,
        balanceCents,
        minimumCents,
        marginCents: minimumCents != null ? balanceCents - minimumCents : null,
      });
    }
  }

  // ── Upcoming bills (all entities) ────────────────────────────────────────────
  const bills = await db.scheduledBill.findMany({
    where: { active: true },
    include: { entity: true },
    orderBy: { autopayDay: "asc" },
  });

  const upcomingBills: ReviewData["upcomingBills"] = bills.map((b) => ({
    payee: b.payee,
    amountCents:
      b.expectedAmount != null
        ? Math.round((b.expectedAmount as Prisma.Decimal).toNumber() * 100)
        : null,
    autopayDay: b.autopayDay ?? null,
    entityName: b.entity.name,
  }));

  // ── Accrual status ────────────────────────────────────────────────────────────
  const envelopes = await db.accrualEnvelope.findMany({
    orderBy: { name: "asc" },
  });

  const accrualStatus: ReviewData["accrualStatus"] = envelopes.map((env) => {
    const currentCents = Math.round(
      (env.currentBalance as Prisma.Decimal).toNumber() * 100
    );
    const targetCents = Math.round(
      (env.targetAnnualAmount as Prisma.Decimal).toNumber() * 100
    );
    // Pro-rata: what balance should be accumulated by this month of the year
    const proRataCents = Math.round((targetCents * month) / 12);
    const pct = proRataCents > 0 ? Math.round((currentCents / proRataCents) * 100) : 100;
    const status: "on_track" | "watch" | "behind" =
      pct >= 90 ? "on_track" : pct >= 60 ? "watch" : "behind";
    return { name: env.name, currentCents, targetCents, proRataCents, pct, status };
  });

  // ── Upsert MonthlyReview ──────────────────────────────────────────────────────
  const data: ReviewData = {
    period,
    generatedAt: new Date().toISOString(),
    budgetHealth,
    accountSnapshot,
    upcomingBills,
    accrualStatus,
  };

  await db.monthlyReview.upsert({
    where: { period },
    create: { period, data: data as object },
    update: { data: data as object },
  });

  revalidatePath(`/review/${year}/${String(month).padStart(2, "0")}`);
  return { success: true };
}
