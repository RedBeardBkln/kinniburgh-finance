"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

const UpdateSchema = z.object({
  budgeted: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, "Must be a positive dollar amount (e.g. 217.00)"),
});

export async function updateBudgetLine(
  budgetId: string,
  budgeted: string
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const parsed = UpdateSchema.safeParse({ budgeted });
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid amount" };
  }

  await db.budget.update({
    where: { id: budgetId },
    data: { budgeted: parsed.data.budgeted },
  });

  revalidatePath("/budgets");
  return { success: true };
}
