"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { computeSavingsRecommendation } from "@/lib/savings-autopilot";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

export async function getSavingsAutopilot() {
  await requireAuth();

  const entity = await db.entity.findFirst({ where: { name: "Personal" } });
  if (!entity) throw new Error("Personal entity not found");

  const [recommendation, savingsAccount, existingTransfer] = await Promise.all([
    computeSavingsRecommendation(entity.id),
    db.account.findFirst({
      where: { entityId: entity.id, mask: "3950", archivedAt: null },
    }),
    db.scheduledTransfer.findFirst({
      where: {
        active: true,
        toAccount: { mask: "3950", entityId: entity.id },
      },
      include: { fromAccount: true, toAccount: true },
    }),
  ]);

  return {
    recommendation,
    savingsAccountFound: savingsAccount != null,
    existingTransfer: existingTransfer
      ? {
          id: existingTransfer.id,
          amountCents: Math.round(
            Number(existingTransfer.amount) * 100
          ),
          fromNickname: existingTransfer.fromAccount.nickname,
        }
      : null,
  };
}

const AmountSchema = z.object({
  amountCents: z.number().int().positive("Amount must be positive"),
});

export async function createOrUpdateSavingsTransfer(
  amountCents: number
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const parsed = AmountSchema.safeParse({ amountCents });
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid amount" };
  }

  const entity = await db.entity.findFirst({ where: { name: "Personal" } });
  if (!entity) return { error: "Personal entity not found" };

  const [primaryChecking, savingsAccount] = await Promise.all([
    db.account.findFirst({
      where: { entityId: entity.id, mask: "2566", archivedAt: null },
    }),
    db.account.findFirst({
      where: { entityId: entity.id, mask: "3950", archivedAt: null },
    }),
  ]);

  if (!primaryChecking) return { error: "Primary checking account (x2566) not found" };
  if (!savingsAccount) return { error: "Savings account (x3950) not found" };

  const amountDecimal = (parsed.data.amountCents / 100).toFixed(2);

  // Deactivate any existing transfer to x3950 before creating new one
  await db.scheduledTransfer.updateMany({
    where: {
      active: true,
      toAccountId: savingsAccount.id,
    },
    data: { active: false },
  });

  await db.scheduledTransfer.create({
    data: {
      fromAccountId: primaryChecking.id,
      toAccountId: savingsAccount.id,
      amount: amountDecimal,
      cadence: "monthly",
      dayRules: { daysOfMonth: [1] },
      purpose: "Savings autopilot",
      active: true,
    },
  });

  revalidatePath("/personal/savings-autopilot");
  return { success: true };
}
