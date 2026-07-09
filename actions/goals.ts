"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

export type GoalInput = {
  title: string;
  category: string;
  description?: string;
  targetAmountCents?: number;
  currentAmountCents?: number;
  targetDate?: Date;
  priority?: number;
  notes?: string;
};

export async function listGoals() {
  return db.financialGoal.findMany({
    where: { status: { not: "deleted" } },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
}

export async function createGoal(input: GoalInput) {
  const goal = await db.financialGoal.create({
    data: {
      title: input.title,
      category: input.category,
      description: input.description,
      targetAmountCents: input.targetAmountCents,
      currentAmountCents: input.currentAmountCents,
      targetDate: input.targetDate,
      priority: input.priority ?? 2,
      notes: input.notes,
    },
  });
  revalidatePath("/advisor");
  return goal;
}

export async function updateGoal(id: string, input: Partial<GoalInput & { status: string }>) {
  const goal = await db.financialGoal.update({
    where: { id },
    data: {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.targetAmountCents !== undefined && { targetAmountCents: input.targetAmountCents }),
      ...(input.currentAmountCents !== undefined && { currentAmountCents: input.currentAmountCents }),
      ...(input.targetDate !== undefined && { targetDate: input.targetDate }),
      ...(input.priority !== undefined && { priority: input.priority }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.status !== undefined && { status: input.status }),
    },
  });
  revalidatePath("/advisor");
  return goal;
}

export async function updateGoalStatus(id: string, status: "active" | "achieved" | "paused") {
  const goal = await db.financialGoal.update({
    where: { id },
    data: { status },
  });
  revalidatePath("/advisor");
  return goal;
}

export async function deleteGoal(id: string) {
  await db.financialGoal.delete({ where: { id } });
  revalidatePath("/advisor");
}
