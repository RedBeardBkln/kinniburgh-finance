"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

const schema = z.object({
  entityId: z.string().uuid(),
  name: z.string().min(1).max(200),
  amountCents: z.number().int().positive(),
  frequency: z.enum(["monthly", "weekly", "biweekly", "quarterly", "annually"]),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  nextDueDate: z.string().nullable().optional(),
  tagId: z.string().uuid().nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

function revalidateAll() {
  revalidatePath("/forecast");
  revalidatePath("/budgets");
}

export async function listRecurringExpenses(entityId?: string) {
  await requireAuth();
  return db.recurringExpense.findMany({
    where: entityId ? { entityId } : {},
    include: { tag: { select: { id: true, shortName: true, name: true } } },
    orderBy: { name: "asc" },
  });
}

export async function createRecurringExpense(
  input: z.infer<typeof schema>
): Promise<{ success: true } | { error: string }> {
  await requireAuth();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const { nextDueDate, ...rest } = parsed.data;
  await db.recurringExpense.create({
    data: { ...rest, nextDueDate: nextDueDate ? new Date(nextDueDate) : null },
  });
  revalidateAll();
  return { success: true };
}

export async function updateRecurringExpense(
  id: string,
  input: Partial<z.infer<typeof schema>>
): Promise<{ success: true } | { error: string }> {
  await requireAuth();
  const { nextDueDate, ...rest } = input;
  await db.recurringExpense.update({
    where: { id },
    data: {
      ...rest,
      ...(nextDueDate !== undefined
        ? { nextDueDate: nextDueDate ? new Date(nextDueDate) : null }
        : {}),
    },
  });
  revalidateAll();
  return { success: true };
}

export async function deleteRecurringExpense(id: string): Promise<void> {
  await requireAuth();
  await db.recurringExpense.delete({ where: { id } });
  revalidateAll();
}

