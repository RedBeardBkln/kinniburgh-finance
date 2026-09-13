import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { buildMonthlyReviewData } from "@/lib/monthly-review-build";

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

  const data = await buildMonthlyReviewData(period);

  // Upsert the monthly review record
  await db.monthlyReview.upsert({
    where: { period },
    create: { period, data: data as unknown as Prisma.InputJsonValue },
    update: { data: data as unknown as Prisma.InputJsonValue },
  });

  // Fire in-app notification
  const users = await db.user.findMany({ select: { id: true } });
  const overBudget = data.budgetHealth.filter((b) => b.status === "over").length;
  const body = `${period} review ready. ${overBudget > 0 ? `${overBudget} budget(s) overspent. ` : ""}${data.accrualStatus.filter((a) => a.status === "behind").length > 0 ? "Some accruals behind pace." : "All accruals on track."}`;

  const notif = await db.notification.create({
    data: {
      type: "monthly_review",
      payload: { title: `Monthly Review — ${period}`, body, url: `/review/${period.slice(0, 4)}/${period.slice(5, 7)}`, period } as unknown as Prisma.InputJsonValue,
      channel: "in_app",
      sentAt: new Date(),
      users: { create: users.map((u) => ({ userId: u.id })) },
    },
  });

  return NextResponse.json({ period, notificationId: notif.id, budgets: data.budgetHealth.length, accounts: data.accountSnapshot.length });
}
