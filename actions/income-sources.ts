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

const CADENCES = ["semi_monthly", "biweekly", "monthly", "weekly"] as const;
type Cadence = (typeof CADENCES)[number];

function validateDayRules(
  cadence: Cadence,
  dayRules: unknown
): string | null {
  if (cadence === "semi_monthly") {
    const r = z
      .object({ daysOfMonth: z.tuple([z.number().int().min(1).max(31), z.number().int().min(1).max(31)]) })
      .safeParse(dayRules);
    if (!r.success) return "semi_monthly requires daysOfMonth: [day1, day2]";
  } else if (cadence === "biweekly") {
    const r = z
      .object({ intervalDays: z.literal(14), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .safeParse(dayRules);
    if (!r.success) return "biweekly requires intervalDays: 14 and anchorDate: YYYY-MM-DD";
  } else if (cadence === "monthly") {
    const r = z.object({ dayOfMonth: z.number().int().min(1).max(31) }).safeParse(dayRules);
    if (!r.success) return "monthly requires dayOfMonth: number";
  } else if (cadence === "weekly") {
    const r = z.object({ dayOfWeek: z.number().int().min(0).max(6) }).safeParse(dayRules);
    if (!r.success) return "weekly requires dayOfWeek: 0–6 (0=Sun)";
  }
  return null;
}

const CreateSchema = z.object({
  entityId: z.string().min(1),
  accountId: z.string().min(1),
  description: z.string().min(1).max(200),
  cadence: z.enum(CADENCES),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "Amount must be a positive decimal"),
  dayRules: z.unknown(),
});

export async function listIncomeSources(entityId?: string) {
  await requireAuth();

  return db.incomeSource.findMany({
    where: entityId ? { entityId } : undefined,
    orderBy: { description: "asc" },
    include: { entity: true, account: true },
  });
}

export async function createIncomeSource(
  data: z.infer<typeof CreateSchema>
): Promise<{ success: true; id: string } | { error: string }> {
  await requireAuth();

  const parsed = CreateSchema.safeParse(data);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  const rulesError = validateDayRules(parsed.data.cadence, parsed.data.dayRules);
  if (rulesError) return { error: rulesError };

  const source = await db.incomeSource.create({
    data: {
      entityId: parsed.data.entityId,
      accountId: parsed.data.accountId,
      description: parsed.data.description,
      cadence: parsed.data.cadence,
      amount: parsed.data.amount,
      dayRules: parsed.data.dayRules as object,
      active: true,
    },
  });

  revalidatePath("/settings/income-sources");
  return { success: true, id: source.id };
}

const PatchSchema = z.object({
  accountId: z.string().min(1).optional(),
  description: z.string().min(1).max(200).optional(),
  cadence: z.enum(CADENCES).optional(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  dayRules: z.unknown().optional(),
});

export async function updateIncomeSource(
  id: string,
  patch: z.infer<typeof PatchSchema>
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  const parsed = PatchSchema.safeParse(patch);
  if (!parsed.success) {
    return { error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }

  // A cadence change without new dayRules would leave stale rules behind —
  // require matching rules whenever cadence is touched.
  if (parsed.data.cadence && parsed.data.dayRules === undefined) {
    return { error: "Changing cadence requires new day rules" };
  }
  if (parsed.data.cadence && parsed.data.dayRules !== undefined) {
    const rulesError = validateDayRules(parsed.data.cadence, parsed.data.dayRules);
    if (rulesError) return { error: rulesError };
  }

  // Account (if changing) must exist and belong to the same entity
  if (parsed.data.accountId) {
    const source = await db.incomeSource.findUnique({ where: { id } });
    if (!source) return { error: "Income source not found" };
    const account = await db.account.findUnique({
      where: { id: parsed.data.accountId, archivedAt: null },
    });
    if (!account || account.entityId !== source.entityId) {
      return { error: "Account not found for this entity" };
    }
  }

  await db.incomeSource.update({
    where: { id },
    data: {
      ...(parsed.data.accountId !== undefined && { accountId: parsed.data.accountId }),
      ...(parsed.data.description !== undefined && { description: parsed.data.description }),
      ...(parsed.data.cadence !== undefined && { cadence: parsed.data.cadence }),
      ...(parsed.data.amount !== undefined && { amount: parsed.data.amount }),
      ...(parsed.data.dayRules !== undefined && { dayRules: parsed.data.dayRules as object }),
    },
  });

  revalidatePath("/settings/income-sources");
  revalidatePath("/forecast");
  revalidatePath("/personal/income");
  return { success: true };
}

export async function toggleIncomeSource(
  id: string,
  active: boolean
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  await db.incomeSource.update({ where: { id }, data: { active } });

  revalidatePath("/settings/income-sources");
  return { success: true };
}

export async function deleteIncomeSource(
  id: string
): Promise<{ success: true } | { error: string }> {
  await requireAuth();

  await db.incomeSource.delete({ where: { id } });

  revalidatePath("/settings/income-sources");
  return { success: true };
}
