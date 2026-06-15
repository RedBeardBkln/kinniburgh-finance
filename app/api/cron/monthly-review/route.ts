import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeBudgetSummary } from "@/lib/budget";
import { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

function prevPeriod(): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const period = prevPeriod();

  // ── Spending vs. budget ───────────────────────────────────────────────────
  const budgets = await db.budget.findMany({
    where: { period },
    include: { tag: true, entity: true },
  });

  const tagSpendRows = await db.$queryRaw<Array<{ tagId: string; entityId: string; total: string }>>`
    SELECT tt."tagId", t."entityId", SUM(t."amount") as total
    FROM "Transaction" t
    JOIN "TransactionTag" tt ON tt."transactionId" = t.id
    WHERE t."postedAt" >= ${new Date(period + "-01T00:00:00Z")}
      AND t."postedAt" < ${new Date(
        new Date(period + "-01T00:00:00Z").setUTCMonth(
          new Date(period + "-01T00:00:00Z").getUTCMonth() + 1
        )
      )}
      AND t."archivedAt" IS NULL
    GROUP BY tt."tagId", t."entityId"
  `;

  const spendMap = new Map(tagSpendRows.map((r) => [`${r.tagId}:${r.entityId}`, parseFloat(r.total)]));

  const budgetHealth = budgets.map((b) => {
    const actual = spendMap.get(`${b.tagId}:${b.entityId}`) ?? 0;
    const summary = computeBudgetSummary({
      budgeted: b.budgeted,
      rolloverAmount: b.rolloverAmount ?? new Decimal(0),
      actualSpend: new Decimal(actual),
    });
    return {
      tagName: b.tag.shortName,
      entityName: b.entity.name.split(",")[0],
      budgetedCents: Math.round(b.budgeted.toNumber() * 100),
      actualCents: Math.round(Math.abs(actual) * 100),
      percentUsed: summary.percentUsed,
      status: summary.percentUsed >= 100 ? "over" : summary.percentUsed >= 80 ? "warning" : "ok",
    };
  });

  // ── Account snapshot ──────────────────────────────────────────────────────
  const accounts = await db.account.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      nickname: true,
      currentBalance: true,
      minimumBalance: true,
    },
  });

  const accountSnapshot = accounts
    .filter((a) => a.currentBalance !== null)
    .map((a) => ({
      nickname: a.nickname,
      balanceCents: Math.round((a.currentBalance?.toNumber() ?? 0) * 100),
      minimumCents: a.minimumBalance ? Math.round(a.minimumBalance.toNumber() * 100) : null,
      marginCents: a.minimumBalance
        ? Math.round(((a.currentBalance?.toNumber() ?? 0) - a.minimumBalance.toNumber()) * 100)
        : null,
    }));

  // ── Upcoming 30 days ──────────────────────────────────────────────────────
  const upcomingBills = await db.scheduledBill.findMany({
    where: { active: true },
    select: { payee: true, expectedAmount: true, autopayDay: true, entity: { select: { name: true } } },
    orderBy: { autopayDay: "asc" },
  });

  // ── Accrual pacing ────────────────────────────────────────────────────────
  const envelopes = await db.accrualEnvelope.findMany({
    include: { account: { select: { entityId: true } } },
  });
  const now = new Date();
  const monthsElapsed = now.getUTCMonth() + 1;
  const accrualStatus = envelopes.map((e) => {
    const target = e.targetAnnualAmount.toNumber();
    const proRata = (target / 12) * monthsElapsed;
    const current = e.currentBalance.toNumber();
    const pct = proRata > 0 ? Math.round((current / proRata) * 100) : 100;
    return {
      name: e.name,
      currentCents: Math.round(current * 100),
      targetCents: Math.round(target * 100),
      proRataCents: Math.round(proRata * 100),
      pct,
      status: pct < 70 ? "behind" : pct < 90 ? "watch" : "on_track",
    };
  });

  const reviewData = {
    period,
    generatedAt: new Date().toISOString(),
    budgetHealth,
    accountSnapshot,
    upcomingBills: upcomingBills.map((b) => ({
      payee: b.payee,
      amountCents: b.expectedAmount ? Math.round(b.expectedAmount.toNumber() * 100) : null,
      autopayDay: b.autopayDay,
      entityName: b.entity.name.split(",")[0],
    })),
    accrualStatus,
  };

  // Upsert the monthly review record
  await db.monthlyReview.upsert({
    where: { period },
    create: { period, data: reviewData as unknown as Prisma.InputJsonValue },
    update: { data: reviewData as unknown as Prisma.InputJsonValue },
  });

  // Fire in-app notification
  const users = await db.user.findMany({ select: { id: true } });
  const overBudget = budgetHealth.filter((b) => b.status === "over").length;
  const body = `${period} review ready. ${overBudget > 0 ? `${overBudget} budget(s) overspent. ` : ""}${accrualStatus.filter((a) => a.status === "behind").length > 0 ? "Some accruals behind pace." : "All accruals on track."}`;

  const notif = await db.notification.create({
    data: {
      type: "monthly_review",
      payload: { title: `Monthly Review — ${period}`, body, url: `/review/${period.slice(0, 4)}/${period.slice(5, 7)}`, period } as unknown as Prisma.InputJsonValue,
      channel: "in_app",
      sentAt: new Date(),
      users: { create: users.map((u) => ({ userId: u.id })) },
    },
  });

  return NextResponse.json({ period, notificationId: notif.id, budgets: budgetHealth.length, accounts: accountSnapshot.length });
}
