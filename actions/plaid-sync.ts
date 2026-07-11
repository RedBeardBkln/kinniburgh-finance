"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { syncPlaidTransactions } from "@/lib/plaid-sync";
import { revalidatePath } from "next/cache";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

export async function syncEntityPlaidAccounts(
  entityId?: string
): Promise<{ synced: number; failed: number; added: number }> {
  await requireAuth();

  // Find all Plaid-connected accounts for this entity (or all entities if none specified)
  const accounts = await db.account.findMany({
    where: {
      plaidItemId: { not: null },
      archivedAt: null,
      ...(entityId ? { entityId } : {}),
    },
    select: { plaidItemId: true },
  });

  const itemIds = [...new Set(
    accounts.map((a) => a.plaidItemId).filter((id): id is string => id !== null)
  )];

  if (itemIds.length === 0) {
    return { synced: 0, failed: 0, added: 0 };
  }

  const items = await db.plaidItem.findMany({
    where: { itemId: { in: itemIds }, status: "active" },
    select: { itemId: true },
  });

  const results = await Promise.allSettled(
    items.map((item) => syncPlaidTransactions(item.itemId))
  );

  const synced = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - synced;
  const added = results
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof syncPlaidTransactions>>> =>
      r.status === "fulfilled"
    )
    .reduce((sum, r) => sum + (r.value.added ?? 0), 0);

  revalidatePath("/transactions");
  return { synced, failed, added };
}
