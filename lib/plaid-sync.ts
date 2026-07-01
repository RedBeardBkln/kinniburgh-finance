import { Decimal } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { encrypt, decrypt } from "@/lib/encrypt";
import { normalizePayee } from "@/lib/tags";

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
  let latestPlaidAccounts: Array<{ account_id: string; balances: { current: number | null } }> = [];

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
    let response;
    try {
      response = await getPlaidClient().transactionsSync({
        access_token: accessToken,
        cursor: nextCursor,
      });
    } catch (err: unknown) {
      // Plaid returns structured errors as axios error responses
      const plaidError = (err as { response?: { data?: { error_code?: string } } })?.response?.data;
      if (plaidError?.error_code === "ITEM_LOGIN_REQUIRED") {
        await db.plaidItem.update({ where: { itemId }, data: { status: "requires_login" } });
      } else if (plaidError?.error_code) {
        await db.plaidItem.update({ where: { itemId }, data: { status: "error" } });
      }
      throw err;
    }
    const data = response.data;
    latestPlaidAccounts = data.accounts as typeof latestPlaidAccounts;

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
          payeeNormalized: normalizePayee(normalized.payeeRaw),
        },
        create: {
          plaidTransactionId: normalized.plaidTransactionId,
          accountId: normalized.accountId,
          entityId: normalized.entityId,
          pending: normalized.pending,
          amount: normalized.amount,
          postedAt: normalized.postedAt,
          payeeRaw: normalized.payeeRaw,
          payeeNormalized: normalizePayee(normalized.payeeRaw),
          source: "plaid",
        },
      });
      added++;
    }

    for (const tx of data.modified) {
      const acct = accountByPlaidId.get(tx.account_id);
      if (!acct) continue;

      const normalized = normalizePlaidTransaction(tx as PlaidTransactionShape, acct.id, acct.entityId);

      const updated = await db.transaction.updateMany({
        where: { plaidTransactionId: tx.transaction_id },
        data: {
          pending: normalized.pending,
          amount: normalized.amount,
          postedAt: normalized.postedAt,
          payeeRaw: normalized.payeeRaw,
          payeeNormalized: normalizePayee(normalized.payeeRaw),
        },
      });
      if (updated.count > 0) modified++;
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

  // Update account balances from the final sync response and persist cursor
  const syncedAt = new Date();
  await Promise.all([
    db.plaidItem.update({
      where: { itemId },
      data: {
        cursorEncrypted: nextCursor ? encrypt(nextCursor) : null,
        lastSyncedAt: syncedAt,
      },
    }),
    ...latestPlaidAccounts
      .filter((pa) => pa.balances.current !== null && pa.balances.current !== undefined)
      .map((pa) => {
        const localAcct = accountByPlaidId.get(pa.account_id);
        if (!localAcct) return Promise.resolve();
        return db.account.update({
          where: { id: localAcct.id },
          data: {
            currentBalance: new Decimal(pa.balances.current!),
            currentBalanceAt: syncedAt,
          },
        });
      }),
  ]);

  return { added, modified, removed };
}
