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
    .regex(/^(\d+(\.\d{1,2})?)?$/, "Must be blank (to auto-sum nested lines) or a positive dollar amount (e.g. 217.00)")
    .optional(),
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

  const budgetedDecimal = parsed.data.budgeted ? new Prisma.Decimal(parsed.data.budgeted) : null;

  await db.budget.update({
    where: { id: budgetId },
    data: { budgeted: budgetedDecimal },
  });

  revalidatePath("/budgets");
  return { success: true };
}

// ── Internal helper ───────────────────────────────────────────────────────────

async function upsertBudgetBill(
  tagId: string,
  entityId: string,
  accountId: string,
  budgeted: string | null,
  payDay: number | null,
  frequency: string,
  payDayOfWeek: number | null,
  biweeklyAnchorDate: Date | null
) {
  const tag = await db.tag.findUnique({ where: { id: tagId } });
  if (!tag) return;

  const expectedAmount = budgeted ? new Prisma.Decimal(budgeted) : null;

  await db.scheduledBill.upsert({
    where: { budgetTagId_budgetEntityId: { budgetTagId: tagId, budgetEntityId: entityId } },
    create: {
      accountId,
      entityId,
      payee: tag.shortName,
      amountType: "static",
      expectedAmount,
      autopayDay: payDay,
      frequency,
      payDayOfWeek,
      biweeklyAnchorDate,
      budgetTagId: tagId,
      budgetEntityId: entityId,
      active: true,
    },
    update: {
      accountId,
      expectedAmount,
      autopayDay: payDay,
      frequency,
      payDayOfWeek,
      biweeklyAnchorDate,
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
  budgeted: z
    .string()
    .trim()
    .regex(/^(\d+(\.\d{1,2})?)?$/, "Must be blank (to auto-sum nested lines) or a positive dollar amount (e.g. 217.00)")
    .optional(),
  payDay: z.number().int().min(1).max(31).optional(),
  frequency: z.enum(["monthly", "weekly", "biweekly"]).optional(),
  payDayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  biweeklyAnchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
})
  .refine((data) => data.frequency !== "weekly" || data.payDayOfWeek != null, {
    message: "Day of week is required for a weekly budget line",
    path: ["payDayOfWeek"],
  })
  .refine(
    (data) =>
      data.frequency !== "biweekly" ||
      (data.payDayOfWeek != null && data.biweeklyAnchorDate != null),
    {
      message: "Day of week and anchor date are required for a biweekly budget line",
      path: ["biweeklyAnchorDate"],
    }
  );

export async function createBudget(
  input: z.infer<typeof CreateSchema>
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  const { tagId, entityId, accountId, period, budgeted, payDay, frequency, payDayOfWeek, biweeklyAnchorDate } =
    parsed.data;
  const budgetedDecimal = budgeted ? new Prisma.Decimal(budgeted) : null;
  const effectiveFrequency = frequency ?? "monthly";
  const effectivePayDayOfWeek = payDayOfWeek ?? null;
  const effectiveBiweeklyAnchorDate = biweeklyAnchorDate ? new Date(biweeklyAnchorDate) : null;

  // A tag can only be budgeted by one entity per period, household-wide —
  // the UI's Add Budget Line dropdown already hides tags used by ANY entity
  // this period, but that's just a filtered list; enforce it here too so a
  // stale dropdown or a direct call can't create a cross-entity duplicate.
  const existingElsewhere = await db.budget.findFirst({
    where: { tagId, period },
    include: { entity: true },
  });
  if (existingElsewhere) {
    return {
      error:
        existingElsewhere.entityId === entityId
          ? "This tag already has a budget line this period."
          : `This tag already has a budget line under ${existingElsewhere.entity.name} this period.`,
    };
  }

  await db.budget.create({
    data: {
      tagId,
      entityId,
      accountId,
      period,
      budgeted: budgetedDecimal,
      payDay: payDay ?? null,
      frequency: effectiveFrequency,
      payDayOfWeek: effectivePayDayOfWeek,
      biweeklyAnchorDate: effectiveBiweeklyAnchorDate,
    },
  });

  if (payDay !== undefined || effectiveFrequency === "weekly" || effectiveFrequency === "biweekly") {
    await upsertBudgetBill(
      tagId,
      entityId,
      accountId,
      budgeted ?? null,
      payDay ?? null,
      effectiveFrequency,
      effectivePayDayOfWeek,
      effectiveBiweeklyAnchorDate
    );
  }

  revalidateAll();
  return { success: true };
}

// ── Update ────────────────────────────────────────────────────────────────────

const UpdateBudgetSchema = z.object({
  budgeted: z
    .string()
    .trim()
    .regex(/^(\d+(\.\d{1,2})?)?$/, "Must be blank (to auto-sum nested lines) or a positive dollar amount (e.g. 217.00)")
    .optional(),
  payDay: z.number().int().min(1).max(31).nullable().optional(),
  accountId: z.string().uuid().optional(),
  applyToFuture: z.boolean().optional(),
  frequency: z.enum(["monthly", "weekly", "biweekly"]).optional(),
  payDayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  biweeklyAnchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
})
  .refine((data) => data.frequency !== "weekly" || data.payDayOfWeek != null, {
    message: "Day of week is required for a weekly budget line",
    path: ["payDayOfWeek"],
  })
  .refine(
    (data) =>
      data.frequency !== "biweekly" ||
      (data.payDayOfWeek != null && data.biweeklyAnchorDate != null),
    {
      message: "Day of week and anchor date are required for a biweekly budget line",
      path: ["biweeklyAnchorDate"],
    }
  );

export async function updateBudget(
  id: string,
  input: z.infer<typeof UpdateBudgetSchema>
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const parsed = UpdateBudgetSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  const { budgeted, payDay, accountId, applyToFuture, frequency, payDayOfWeek, biweeklyAnchorDate } = parsed.data;

  const current = await db.budget.findUnique({ where: { id } });
  if (!current) return { error: "Budget not found" };

  // Three distinguishable states: omitted (undefined — no change), explicit
  // blank ("" — clear to auto-sum), explicit value.
  const newBudgetedRaw = budgeted !== undefined ? (budgeted === "" ? null : budgeted) : undefined;
  const newBiweeklyAnchorDate =
    biweeklyAnchorDate !== undefined ? (biweeklyAnchorDate ? new Date(biweeklyAnchorDate) : null) : undefined;

  const updateData: Prisma.BudgetUpdateInput = {};
  if (newBudgetedRaw !== undefined) {
    updateData.budgeted = newBudgetedRaw ? new Prisma.Decimal(newBudgetedRaw) : null;
  }
  if (payDay !== undefined) updateData.payDay = payDay;
  if (accountId !== undefined) updateData.account = { connect: { id: accountId } };
  if (frequency !== undefined) updateData.frequency = frequency;
  if (payDayOfWeek !== undefined) updateData.payDayOfWeek = payDayOfWeek;
  if (newBiweeklyAnchorDate !== undefined) updateData.biweeklyAnchorDate = newBiweeklyAnchorDate;

  await db.budget.update({ where: { id }, data: updateData });

  if (
    applyToFuture &&
    (payDay !== undefined ||
      accountId !== undefined ||
      frequency !== undefined ||
      payDayOfWeek !== undefined ||
      newBiweeklyAnchorDate !== undefined)
  ) {
    const futureData: Prisma.BudgetUpdateManyMutationInput = {};
    if (payDay !== undefined) futureData.payDay = payDay;
    if (frequency !== undefined) futureData.frequency = frequency;
    if (payDayOfWeek !== undefined) futureData.payDayOfWeek = payDayOfWeek;
    if (newBiweeklyAnchorDate !== undefined) futureData.biweeklyAnchorDate = newBiweeklyAnchorDate;
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
      if (frequency !== undefined) fbData.frequency = frequency;
      if (payDayOfWeek !== undefined) fbData.payDayOfWeek = payDayOfWeek;
      if (newBiweeklyAnchorDate !== undefined) fbData.biweeklyAnchorDate = newBiweeklyAnchorDate;
      await db.budget.update({ where: { id: fb.id }, data: fbData });
    }
  }

  const effectivePayDay = payDay !== undefined ? payDay : current.payDay;
  const effectiveAccountId = accountId ?? current.accountId;
  const effectiveBudgeted =
    newBudgetedRaw !== undefined ? newBudgetedRaw : current.budgeted !== null ? current.budgeted.toString() : null;
  const effectiveFrequency = frequency !== undefined ? frequency : current.frequency;
  const effectivePayDayOfWeek = payDayOfWeek !== undefined ? payDayOfWeek : current.payDayOfWeek;
  const effectiveBiweeklyAnchorDate =
    newBiweeklyAnchorDate !== undefined ? newBiweeklyAnchorDate : current.biweeklyAnchorDate;

  if (
    (effectivePayDay !== null && effectivePayDay !== undefined) ||
    effectiveFrequency === "weekly" ||
    effectiveFrequency === "biweekly"
  ) {
    await upsertBudgetBill(
      current.tagId,
      current.entityId,
      effectiveAccountId,
      effectiveBudgeted,
      effectivePayDay ?? null,
      effectiveFrequency,
      effectivePayDayOfWeek,
      effectiveBiweeklyAnchorDate
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

// ── Additional recurring buffer ────────────────────────────────────────────────

export async function updateBudgetAdditionalAmount(
  budgetId: string,
  amountCents: number
): Promise<{ success: true } | { error: string }> {
  await requireAuth();
  if (!Number.isInteger(amountCents) || amountCents < 0)
    return { error: "Amount must be a non-negative integer (cents)" };
  await db.budget.update({
    where: { id: budgetId },
    data: { additionalAmountCents: new Prisma.Decimal(amountCents) },
  });
  revalidatePath("/budgets");
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
