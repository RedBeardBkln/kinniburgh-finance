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

// ── List projected revenue (forecast-only business income) ────────────────────

export async function listProjectedRevenue(entityId: string) {
  await requireAuth();
  return db.projectedRevenue.findMany({
    where: { entityId, archivedAt: null },
    orderBy: [{ expectedDate: "asc" }, { createdAt: "desc" }],
  });
}

// ── Create projected revenue ──────────────────────────────────────────────────

const createSchema = z.object({
  entityId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  description: z.string().min(1).max(200),
  expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountCents: z.number().int().positive(),
  notes: z.string().max(500).optional(),
});

export async function createProjectedRevenue(
  data: z.input<typeof createSchema>
): Promise<{ success: true; id: string } | { error: string }> {
  await requireAuth();

  const parsed = createSchema.safeParse(data);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  if (parsed.data.accountId) {
    const account = await db.account.findUnique({
      where: { id: parsed.data.accountId, archivedAt: null },
    });
    if (!account || account.entityId !== parsed.data.entityId) {
      return { error: "Account not found for this entity" };
    }
  }

  const row = await db.projectedRevenue.create({
    data: {
      entityId: parsed.data.entityId,
      accountId: parsed.data.accountId ?? null,
      description: parsed.data.description,
      expectedDate: new Date(`${parsed.data.expectedDate}T00:00:00Z`),
      amountCents: parsed.data.amountCents,
      notes: parsed.data.notes ?? null,
      source: "manual",
    },
  });

  revalidatePath("/business");
  if (parsed.data.accountId) revalidatePath("/forecast");
  return { success: true, id: row.id };
}

// ── Mark projected revenue as realized ────────────────────────────────────────

export async function markProjectedRevenueRealized(
  id: string,
  realized: boolean
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const row = await db.projectedRevenue.findUnique({ where: { id } });
  if (!row || row.archivedAt) return { error: "Projected revenue not found" };

  await db.projectedRevenue.update({
    where: { id },
    data: { realizedAt: realized ? new Date() : null },
  });

  revalidatePath("/business");
  return { success: true };
}

// ── Archive projected revenue ─────────────────────────────────────────────────

export async function archiveProjectedRevenue(
  id: string
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const row = await db.projectedRevenue.findUnique({ where: { id } });
  if (!row) return { error: "Projected revenue not found" };

  await db.projectedRevenue.update({
    where: { id },
    data: { archivedAt: new Date() },
  });

  revalidatePath("/business");
  return { success: true };
}