"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
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

// ── Internal helper ───────────────────────────────────────────────────────────

async function upsertBudgetBill(
  tagId: string,
  entityId: string,
  accountId: string,
  budgeted: string,
  payDay: number
) {
  const tag = await db.tag.findUnique({ where: { id: tagId } });
  if (!tag) return;

  await db.scheduledBill.upsert({
    where: { budgetTagId_budgetEntityId: { budgetTagId: tagId, budgetEntityId: entityId } },
    create: {
      accountId,
      entityId,
      payee: tag.shortName,
      amountType: "static",
      expectedAmount: new Prisma.Decimal(budgeted),
      autopayDay: payDay,
      budgetTagId: tagId,
      budgetEntityId: entityId,
      active: true,
    },
    update: {
      accountId,
      expectedAmount: new Prisma.Decimal(budgeted),
      autopayDay: payDay,
      active: true,
    },
  });
}

function revalidateAll() {
  revalidatePath("/budgets");
  revalidatePath("/envelope");
  revalidatePath("/forecast");
}

// ── Create ────────────────────────────────────────────────────────────────────

const CreateSchema = z.object({
  tagId: z.string().uuid(),
  entityId: z.string().uuid(),
  accountId: z.string().uuid(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  budgeted: z.string().regex(/^\d+(\.\d{1,2})?$/),
  payDay: z.number().int().min(1).max(31).optional(),
});

export async function createBudget(
  input: z.infer<typeof CreateSchema>
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  const { tagId, entityId, accountId, period, budgeted, payDay } = parsed.data;

  await db.budget.create({
    data: {
      tagId,
      entityId,
      accountId,
      period,
      budgeted: new Prisma.Decimal(budgeted),
      payDay: payDay ?? null,
    },
  });

  if (payDay !== undefined) {
    await upsertBudgetBill(tagId, entityId, accountId, budgeted, payDay);
  }

  revalidateAll();
  return { success: true };
}

// ── Update ────────────────────────────────────────────────────────────────────

const UpdateBudgetSchema = z.object({
  budgeted: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  payDay: z.number().int().min(1).max(31).nullable().optional(),
  accountId: z.string().uuid().optional(),
  applyToFuture: z.boolean().optional(),
});

export async function updateBudget(
  id: string,
  input: z.infer<typeof UpdateBudgetSchema>
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const parsed = UpdateBudgetSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  const { budgeted, payDay, accountId, applyToFuture } = parsed.data;

  const current = await db.budget.findUnique({ where: { id } });
  if (!current) return { error: "Budget not found" };

  const updateData: Prisma.BudgetUpdateInput = {};
  if (budgeted !== undefined) updateData.budgeted = new Prisma.Decimal(budgeted);
  if (payDay !== undefined) updateData.payDay = payDay;
  if (accountId !== undefined) updateData.account = { connect: { id: accountId } };

  await db.budget.update({ where: { id }, data: updateData });

  if (applyToFuture && (payDay !== undefined || accountId !== undefined)) {
    const futureData: Prisma.BudgetUpdateManyMutationInput = {};
    if (payDay !== undefined) futureData.payDay = payDay;
    // accountId requires relation update — use raw update per record for future periods
    const futureBudgets = await db.budget.findMany({
      where: {
        tagId: current.tagId,
        entityId: current.entityId,
        period: { gt: current.period },
      },
    });
    for (const fb of futureBudgets) {
      const fbData: Prisma.BudgetUpdateInput = {};
      if (payDay !== undefined) fbData.payDay = payDay;
      if (accountId !== undefined) fbData.account = { connect: { id: accountId } };
      await db.budget.update({ where: { id: fb.id }, data: fbData });
    }
  }

  const effectivePayDay = payDay !== undefined ? payDay : current.payDay;
  const effectiveAccountId = accountId ?? current.accountId;
  const effectiveBudgeted = budgeted ?? current.budgeted.toString();

  if (effectivePayDay !== null && effectivePayDay !== undefined) {
    await upsertBudgetBill(
      current.tagId,
      current.entityId,
      effectiveAccountId,
      effectiveBudgeted,
      effectivePayDay
    );
  } else if (payDay === null) {
    await db.scheduledBill.updateMany({
      where: { budgetTagId: current.tagId, budgetEntityId: current.entityId },
      data: { active: false },
    });
  }

  revalidateAll();
  return { success: true };
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteBudget(
  id: string
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const current = await db.budget.findUnique({ where: { id } });
  if (!current) return { error: "Budget not found" };

  await db.scheduledBill.updateMany({
    where: { budgetTagId: current.tagId, budgetEntityId: current.entityId },
    data: { active: false },
  });

  await db.budget.delete({ where: { id } });

  revalidateAll();
  return { success: true };
}
