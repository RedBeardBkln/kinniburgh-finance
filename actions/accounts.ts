"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

const ACCOUNT_TYPES = ["checking", "savings", "credit_card", "mortgage", "loan", "investment", "insurance"] as const;

const createAccountSchema = z.object({
  institutionId: z.string().uuid(),
  entityId: z.string().uuid(),
  nickname: z.string().min(1).max(100),
  mask: z.string().max(10).optional(),
  accountType: z.enum(ACCOUNT_TYPES),
  minimumBalance: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  minimumBalanceFee: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
});

export async function createAccount(input: z.infer<typeof createAccountSchema>) {
  await requireAuth();
  const parsed = createAccountSchema.parse(input);

  await db.account.create({
    data: {
      institutionId: parsed.institutionId,
      entityId: parsed.entityId,
      nickname: parsed.nickname,
      mask: parsed.mask ?? null,
      accountType: parsed.accountType,
      integrationMode: "manual_entry",
      minimumBalance: parsed.minimumBalance ? new Prisma.Decimal(parsed.minimumBalance) : null,
      minimumBalanceFee: parsed.minimumBalanceFee ? new Prisma.Decimal(parsed.minimumBalanceFee) : null,
    },
  });

  revalidatePath("/accounts");
  revalidatePath("/envelope");
  return { success: true as const };
}

const updateAccountSchema = z.object({
  id: z.string().uuid(),
  nickname: z.string().min(1).max(100).optional(),
  minimumBalance: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
  minimumBalanceFee: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
});

export async function updateAccount(input: z.infer<typeof updateAccountSchema>) {
  await requireAuth();
  const { id, ...patch } = updateAccountSchema.parse(input);

  const data: Prisma.AccountUpdateInput = {};
  if (patch.nickname !== undefined) data.nickname = patch.nickname;
  if (patch.minimumBalance !== undefined) {
    data.minimumBalance = patch.minimumBalance ? new Prisma.Decimal(patch.minimumBalance) : null;
  }
  if (patch.minimumBalanceFee !== undefined) {
    data.minimumBalanceFee = patch.minimumBalanceFee ? new Prisma.Decimal(patch.minimumBalanceFee) : null;
  }

  await db.account.update({ where: { id }, data });

  revalidatePath("/accounts");
  revalidatePath("/envelope");
  return { success: true as const };
}

export async function archiveAccount(id: string) {
  await requireAuth();
  await db.account.update({
    where: { id },
    data: { archivedAt: new Date() },
  });
  revalidatePath("/accounts");
  return { success: true as const };
}
