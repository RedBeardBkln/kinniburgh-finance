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

const DeadlineSchema = z.object({
  entityId: z.string().min(1),
  label: z.string().trim().min(1, "Label is required"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  type: z.enum(["quarterly_est", "annual", "extension", "other"]),
  notes: z.string().trim().optional(),
});

const PatchSchema = z.object({
  label: z.string().trim().min(1).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  type: z.enum(["quarterly_est", "annual", "extension", "other"]).optional(),
  status: z.enum(["upcoming", "filed", "waived"]).optional(),
  notes: z.string().trim().optional(),
});

export async function listTaxDeadlines(entityId?: string) {
  await requireAuth();

  return db.taxDeadline.findMany({
    where: {
      archivedAt: null,
      ...(entityId ? { entityId } : {}),
    },
    include: { entity: { select: { name: true } } },
    orderBy: { dueDate: "asc" },
  });
}

export async function createTaxDeadline(
  data: z.infer<typeof DeadlineSchema>
): Promise<{ success: true; id: string } | { error: string }> {
  await requireAuth();

  const parsed = DeadlineSchema.safeParse(data);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid data" };
  }

  const { dueDate, ...rest } = parsed.data;

  const deadline = await db.taxDeadline.create({
    data: {
      ...rest,
      dueDate: new Date(`${dueDate}T12:00:00Z`),
    },
  });

  revalidatePath("/tax");
  return { success: true, id: deadline.id };
}

export async function updateTaxDeadline(
  id: string,
  patch: z.infer<typeof PatchSchema>
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const parsed = PatchSchema.safeParse(patch);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid data" };
  }

  const { dueDate, ...rest } = parsed.data;

  await db.taxDeadline.update({
    where: { id },
    data: {
      ...rest,
      ...(dueDate ? { dueDate: new Date(`${dueDate}T12:00:00Z`) } : {}),
    },
  });

  revalidatePath("/tax");
  return { success: true };
}

export async function archiveTaxDeadline(id: string): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  // Tax records are never hard-deleted — soft delete only
  await db.taxDeadline.update({
    where: { id },
    data: { archivedAt: new Date() },
  });

  revalidatePath("/tax");
  return { success: true };
}
