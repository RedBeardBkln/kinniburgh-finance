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

const STATUSES = ["in_progress", "extended", "filed"] as const;

export async function listTaxWorkspaces() {
  await requireAuth();
  const workspaces = await db.taxWorkspace.findMany({
    include: {
      entity: true,
      checklistItems: true,
    },
    orderBy: [{ taxYear: "desc" }, { createdAt: "asc" }],
  });

  return workspaces.map((w) => ({
    ...w,
    totalItems: w.checklistItems.length,
    completedItems: w.checklistItems.filter((i) => i.completed).length,
  }));
}

export async function getTaxWorkspace(id: string) {
  await requireAuth();
  return db.taxWorkspace.findUniqueOrThrow({
    where: { id },
    include: {
      entity: true,
      checklistItems: { orderBy: { createdAt: "asc" } },
    },
  });
}

export async function updateWorkspace(
  id: string,
  patch: { status?: string; deadline?: string | null; notes?: string | null; filedAt?: string | null }
) {
  await requireAuth();
  const data = z
    .object({
      status: z.enum(STATUSES).optional(),
      deadline: z.string().nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
      filedAt: z.string().nullable().optional(),
    })
    .parse(patch);

  await db.taxWorkspace.update({
    where: { id },
    data: {
      ...(data.status !== undefined && { status: data.status }),
      ...(data.deadline !== undefined && {
        deadline: data.deadline ? new Date(data.deadline) : null,
      }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.filedAt !== undefined && {
        filedAt: data.filedAt ? new Date(data.filedAt) : null,
      }),
    },
  });
  revalidatePath("/tax");
}

export async function toggleChecklistItem(itemId: string, completed: boolean): Promise<void> {
  await requireAuth();
  await db.taxChecklistItem.update({
    where: { id: itemId },
    data: {
      completed,
      completedAt: completed ? new Date() : null,
    },
  });
  revalidatePath("/tax");
}

export async function addChecklistItem(workspaceId: string, label: string): Promise<void> {
  await requireAuth();
  const validated = z.string().min(1).max(500).parse(label);
  await db.taxChecklistItem.create({
    data: { workspaceId, label: validated },
  });
  revalidatePath("/tax");
}

export async function removeChecklistItem(itemId: string): Promise<void> {
  await requireAuth();
  await db.taxChecklistItem.delete({ where: { id: itemId } });
  revalidatePath("/tax");
}
