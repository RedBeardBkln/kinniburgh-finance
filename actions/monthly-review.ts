"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { buildMonthlyReviewData } from "@/lib/monthly-review-build";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

export async function generateMonthlyReview(
  period: string
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return { error: "Invalid period format — expected YYYY-MM" };

  const year = parseInt(match[1]!);
  const month = parseInt(match[2]!);

  const data = await buildMonthlyReviewData(period);

  await db.monthlyReview.upsert({
    where: { period },
    create: { period, data: data as object },
    update: { data: data as object },
  });

  revalidatePath(`/review/${year}/${String(month).padStart(2, "0")}`);
  return { success: true };
}
