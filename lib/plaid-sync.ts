import { Decimal } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { encrypt, decrypt } from "@/lib/encrypt";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlaidTransactionShape {
  transaction_id: string;
  pending: boolean;
  pending_transaction_id?: string | null;
  amount: number;         // positive = outflow, negative = inflow
  date: string;           // ISO date "YYYY-MM-DD"
  name: string;
  merchant_name?: string | null;
  payment_channel?: string;
}

export interface NormalizedTransaction {
  plaidTransactionId: string;
  pending: boolean;
  amount: Decimal;        // negative = outflow, positive = inflow (our convention)
  postedAt: Date;
  payeeRaw: string;
  source: "plaid";
  accountId: string;
  entityId: string;
}

export interface SyncResult {
  added: number;
  modified: number;
  removed: number;
}

// ── Pure normalization (testable without DB) ──────────────────────────────────

export function normalizePlaidTransaction(
  plaidTx: PlaidTransactionShape,
  accountId: string,
  entityId: string,
): NormalizedTransaction {
  // Plaid: positive = money out; our schema: negative = outflow
  const amount = new Decimal(-plaidTx.amount);

  // payeeRaw priority: merchant_name > name
  const payeeRaw = (plaidTx.merchant_name?.trim() || plaidTx.name?.trim()) ?? "";

  // date is "YYYY-MM-DD"; store as UTC midnight
  const parts = plaidTx.date.split("-").map(Number);
  const postedAt = new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!));

  return {
    plaidTransactionId: plaidTx.transaction_id,
    pending: plaidTx.pending,
    amount,
    postedAt,
    payeeRaw,
    source: "plaid",
    accountId,
    entityId,
  };
}

// ── DB-aware sync engine ──────────────────────────────────────────────────────

export async function syncPlaidTransactions(itemId: string): Promise<SyncResult> {
  const plaidItem = await db.plaidItem.findUnique({ where: { itemId } });
  if (!plaidItem) throw new Error(`PlaidItem not found: ${itemId}`);

  const accessToken = decrypt(plaidItem.accessTokenEncrypted);
  const cursor = plaidItem.cursorEncrypted ? decrypt(plaidItem.cursorEncrypted) : undefined;

  // Fetch all pages of changes
  let added = 0;
  let modified = 0;
  let removed = 0;
  let nextCursor = cursor;
  let hasMore = true;

  // Load account→entity mapping for this item
  const accounts = await db.account.findMany({
    where: { plaidItemId: itemId },
    select: { id: true, entityId: true, plaidAccountId: true },
  });
  const accountByPlaidId = new Map(
    accounts
      .filter((a) => a.plaidAccountId)
      .map((a) => [a.plaidAccountId!, a])
  );

  while (hasMore) {
    const response = await getPlaidClient().transactionsSync({
      access_token: accessToken,
      cursor: nextCursor,
    });
    const data = response.data;

    for (const tx of data.added) {
      const acct = accountByPlaidId.get(tx.account_id);
      if (!acct) continue;

      const normalized = normalizePlaidTransaction(tx as PlaidTransactionShape, acct.id, acct.entityId);

      await db.transaction.upsert({
        where: { plaidTransactionId: normalized.plaidTransactionId },
        update: {
          pending: normalized.pending,
          amount: normalized.amount,
          postedAt: normalized.postedAt,
          payeeRaw: normalized.payeeRaw,
        },
        create: {
          plaidTransactionId: normalized.plaidTransactionId,
          accountId: normalized.accountId,
          entityId: normalized.entityId,
          pending: normalized.pending,
          amount: normalized.amount,
          postedAt: normalized.postedAt,
          payeeRaw: normalized.payeeRaw,
          payeeNormalized: normalized.payeeRaw.toLowerCase(),
          source: "plaid",
        },
      });
      added++;
    }

    for (const tx of data.modified) {
      const existing = await db.transaction.findUnique({
        where: { plaidTransactionId: tx.transaction_id },
      });
      if (!existing) continue;

      await db.transaction.update({
        where: { plaidTransactionId: tx.transaction_id },
        data: {
          pending: tx.pending,
          amount: new Prisma.Decimal(-tx.amount),
          postedAt: (() => {
            const p = tx.date.split("-").map(Number);
            return new Date(Date.UTC(p[0]!, p[1]! - 1, p[2]!));
          })(),
          payeeRaw: (tx.merchant_name?.trim() || tx.name?.trim()) ?? "",
        },
      });
      modified++;
    }

    for (const removedTx of data.removed) {
      await db.transaction.updateMany({
        where: { plaidTransactionId: removedTx.transaction_id, archivedAt: null },
        data: { archivedAt: new Date() },
      });
      removed++;
    }

    nextCursor = data.next_cursor;
    hasMore = data.has_more;
  }

  // Persist updated cursor
  await db.plaidItem.update({
    where: { itemId },
    data: {
      cursorEncrypted: nextCursor ? encrypt(nextCursor) : null,
      lastSyncedAt: new Date(),
    },
  });

  return { added, modified, removed };
}
