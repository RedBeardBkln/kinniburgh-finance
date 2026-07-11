"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { syncPlaidTransactions, type SyncResult } from "@/lib/plaid-sync";
import { revalidatePath } from "next/cache";

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

export interface SyncEntityResult {
  synced: number;
  failed: number;
  added: number;
  modified: number;
  needsReauth: boolean;
}

export async function syncEntityPlaidAccounts(
  entityId?: string
): Promise<SyncEntityResult> {
  await requireAuth();

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
    return { synced: 0, failed: 0, added: 0, modified: 0, needsReauth: false };
  }

  const items = await db.plaidItem.findMany({
    where: { itemId: { in: itemIds }, status: "active" },
    select: { itemId: true },
  });

  // If fewer active items than total, some need re-authentication
  const needsReauth = items.length < itemIds.length;

  const results = await Promise.allSettled(
    items.map((item) => syncPlaidTransactions(item.itemId))
  );

  const fulfilled = results.filter(
    (r): r is PromiseFulfilledResult<SyncResult> => r.status === "fulfilled"
  );
  const synced = fulfilled.length;
  const failed = results.length - synced;
  const added = fulfilled.reduce((sum, r) => sum + r.value.added, 0);
  const modified = fulfilled.reduce((sum, r) => sum + r.value.modified, 0);

  revalidatePath("/transactions");
  return { synced, failed, added, modified, needsReauth };
}
