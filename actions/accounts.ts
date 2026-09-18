"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveOrCreateInstitution } from "@/lib/institutions";
import { ACCOUNT_TYPE_VALUES } from "@/lib/account-types";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

const createAccountSchema = z
  .object({
    institutionId: z.string().uuid().optional(),
    newInstitutionName: z.string().trim().min(1).max(200).optional(),
    entityId: z.string().uuid(),
    nickname: z.string().min(1).max(100),
    mask: z.string().max(10).optional(),
    accountType: z.enum(ACCOUNT_TYPE_VALUES),
    minimumBalance: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    minimumBalanceFee: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  })
  .refine((v) => !!v.institutionId !== !!v.newInstitutionName, {
    message: "Provide exactly one of institutionId or newInstitutionName",
    path: ["institutionId"],
  });

export async function createAccount(input: z.infer<typeof createAccountSchema>) {
  await requireAuth();
  const parsed = createAccountSchema.parse(input);

  const institutionId = parsed.institutionId
    ? parsed.institutionId
    : (await resolveOrCreateInstitution(parsed.newInstitutionName!)).id;

  await db.account.create({
    data: {
      institutionId,
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
  accountType: z.enum(ACCOUNT_TYPE_VALUES).optional(),
  minimumBalance: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
  minimumBalanceFee: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
});

export async function updateAccount(input: z.infer<typeof updateAccountSchema>) {
  await requireAuth();
  const { id, ...patch } = updateAccountSchema.parse(input);

  const data: Prisma.AccountUpdateInput = {};
  if (patch.nickname !== undefined) data.nickname = patch.nickname;
  if (patch.accountType !== undefined) data.accountType = patch.accountType;
  if (patch.minimumBalance !== undefined) {
    data.minimumBalance = patch.minimumBalance ? new Prisma.Decimal(patch.minimumBalance) : null;
  }
  if (patch.minimumBalanceFee !== undefined) {
    data.minimumBalanceFee = patch.minimumBalanceFee ? new Prisma.Decimal(patch.minimumBalanceFee) : null;
  }

  await db.account.update({ where: { id }, data });

  revalidatePath("/accounts");
  revalidatePath("/envelope");
  revalidatePath("/personal/retirement");
  return { success: true as const };
}

// ─── Reassign an account to a different entity ─────────────────────────────
// Deliberately a separate, explicit action rather than a field on
// updateAccount — moving an account across the Personal/business boundary
// has real downstream effects (existing transactions, tags, GL coding) that
// a plain rename/retype doesn't, so it needs its own considered UI and audit
// trail rather than being one more silently-mergeable patch field.

export async function countAccountTransactions(accountId: string): Promise<number> {
  await requireAuth();
  return db.transaction.count({ where: { accountId, archivedAt: null } });
}

const reassignAccountEntitySchema = z.object({
  accountId: z.string().uuid(),
  newEntityId: z.string().uuid(),
  reassignExistingTransactions: z.boolean(),
});

export async function reassignAccountEntity(
  input: z.infer<typeof reassignAccountEntitySchema>
): Promise<{ transactionsReassigned: number }> {
  const user = await requireAuth();
  const { accountId, newEntityId, reassignExistingTransactions } =
    reassignAccountEntitySchema.parse(input);

  const account = await db.account.findUnique({ where: { id: accountId } });
  if (!account) throw new Error("Account not found");
  if (account.entityId === newEntityId) {
    throw new Error("Account already belongs to that entity");
  }
  const oldEntityId = account.entityId;

  await db.account.update({
    where: { id: accountId },
    data: { entityId: newEntityId },
  });

  let transactionsReassigned = 0;
  if (reassignExistingTransactions) {
    // Only rows still on the account's old entity — never touch a
    // transaction someone already deliberately moved to a third entity.
    const txs = await db.transaction.findMany({
      where: { accountId, archivedAt: null, entityId: oldEntityId },
      select: { id: true },
    });

    if (txs.length > 0) {
      await db.auditLog.createMany({
        data: txs.map((tx) => ({
          transactionId: tx.id,
          changedBy: user.id!,
          changeType: "entity_change",
          before: { entityId: oldEntityId },
          after: { entityId: newEntityId, reason: "account_reassignment" },
        })),
      });

      const result = await db.transaction.updateMany({
        where: { id: { in: txs.map((tx) => tx.id) } },
        data: { entityId: newEntityId },
      });
      transactionsReassigned = result.count;
    }
  }

  revalidatePath("/accounts");
  revalidatePath("/business");
  revalidatePath("/transactions");
  return { transactionsReassigned };
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

// Dismisses a "pending mapping" banner for a PlaidItem that never got a real
// Account created for it (e.g. a stale/duplicate test connection). Only
// allowed while the item still has zero non-archived accounts — if it's
// been mapped since the banner was rendered, this is a no-op rather than
// silently hiding a real connection.
export async function dismissPendingPlaidItem(itemId: string) {
  await requireAuth();
  const item = await db.plaidItem.findUnique({
    where: { itemId },
    include: { accounts: { where: { archivedAt: null }, select: { id: true } } },
  });
  if (!item) throw new Error("Connection not found");
  if (item.accounts.length > 0) {
    throw new Error("This connection already has an account linked — refresh the page.");
  }
  await db.plaidItem.update({
    where: { itemId },
    data: { status: "dismissed" },
  });
  revalidatePath("/accounts");
  return { success: true as const };
}
