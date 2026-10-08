"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";

// Every export is a server action addressable by id, so each one starts with the auth gate (the page also redirects).
// The Advisor's Goals panel is the only caller and always runs inside a signed-in session.
async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

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
  await requireAuth();
  return db.financialGoal.findMany({
    where: { status: { not: "deleted" } },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
}

export async function createGoal(input: GoalInput) {
  await requireAuth();
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
  await requireAuth();
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
  await requireAuth();
  const goal = await db.financialGoal.update({
    where: { id },
    data: { status },
  });
  revalidatePath("/advisor");
  return goal;
}

export async function deleteGoal(id: string) {
  await requireAuth();
  await db.financialGoal.delete({ where: { id } });
  revalidatePath("/advisor");
}
