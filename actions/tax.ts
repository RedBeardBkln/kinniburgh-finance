"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

const STATUSES = ["in_progress", "extended", "filed"] as const;

const ensureSchema = z.object({
  entityId: z.string().uuid(),
  taxYear: z.number().int().min(2000).max(2100),
});

/**
 * Creates (or returns) a tax workspace for any entity + year, then redirects
 * to it. Used by the year-grouped tax page to open a workspace that doesn't
 * exist yet. Tax records are never hard-deleted — creation is idempotent.
 */
export async function ensureTaxWorkspace(formData: FormData): Promise<void> {
  await requireAuth();

  const parsed = ensureSchema.parse({
    entityId: formData.get("entityId") ?? "",
    taxYear: formData.get("taxYear") ? Number(formData.get("taxYear")) : NaN,
  });

  const entity = await db.entity.findUnique({ where: { id: parsed.entityId } });
  if (!entity) throw new Error("Entity not found");

  const existing = await db.taxWorkspace.findUnique({
    where: { entityId_taxYear: { entityId: entity.id, taxYear: parsed.taxYear } },
  });

  let workspaceId = existing?.id;
  if (!workspaceId) {
    const workspace = await db.taxWorkspace.create({
      data: {
        entityId: entity.id,
        taxYear: parsed.taxYear,
        status: "in_progress",
        deadline: new Date(`${parsed.taxYear + 1}-04-15T04:00:00Z`),
        notes:
          entity.type === "business"
            ? `${entity.name} — tax year ${parsed.taxYear}. Draft is prepared by the platform and reviewed by your CPA.`
            : `Personal federal + CT state return. Draft is prepared by the platform and reviewed by your CPA.`,
      },
    });
    workspaceId = workspace.id;
  }

  revalidatePath("/tax");
  redirect(`/tax/${workspaceId}`);
}

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
