"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
}

export async function updateInvestmentBalance(accountId: string, balanceDollars: number) {
  await requireAuth();
  if (balanceDollars < 0) throw new Error("Balance must be non-negative");
  await db.account.update({
    where: { id: accountId },
    data: {
      currentBalance: balanceDollars,
      currentBalanceAt: new Date(),
    },
  });
  revalidatePath("/personal/retirement");
  revalidatePath("/personal/net-worth");
}
