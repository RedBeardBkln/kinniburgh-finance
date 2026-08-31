import { Decimal } from "@prisma/client/runtime/library";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { encrypt, decrypt } from "@/lib/encrypt";
import { normalizePayee, matchTagRule } from "@/lib/tags";

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
  /** Institution login name that was synced (all sibling accounts share one Item) */
  institutionName: string | null;
  /** Credit cards whose statement data was refreshed this sync */
  cardsUpdated: { accountNickname: string; dueDate: string | null; statementBalance: string | null }[];
  /** Why statement data was unavailable, if it was (e.g. product not granted yet) */
  liabilitiesNote: string | null;
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

// ── Credit card liabilities normalization (pure) ──────────────────────────────

export interface PlaidLiabilityCardShape {
  account_id: string;
  aprs?: { apr_percentage?: number | null; apr_type?: string }[];
  minimum_payment_amount?: number | null;
  next_payment_due_date?: string | null; // ISO date
  statement_balance?: number | null;     // positive = owed
  statement_balance_due_date?: string | null;
  last_statement_balance?: number | null;
  last_statement_issue_date?: string | null;
}

export interface NormalizedCardStatement {
  dueDate: Date | null;
  statementBalance: Decimal | null;
  minimumPayment: Decimal | null;
  apr: Decimal | null;
}

/**
 * Normalizes a Plaid credit-card liability into statement fields.
 * Pay statementBalance by dueDate to avoid interest.
 * - dueDate: next_payment_due_date (falls back to statement_balance_due_date)
 * - statementBalance: statement_balance (falls back to last_statement_balance)
 * - apr: primary (usually purchase) APR if present
 */
export function normalizeCardLiability(
  card: PlaidLiabilityCardShape
): NormalizedCardStatement {
  const parseDate = (s: string | null | undefined): Date | null => {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };

  const toDecimal = (n: number | null | undefined): Decimal | null => {
    if (n === null || n === undefined || !Number.isFinite(n)) return null;
    return new Decimal(n);
  };

  const dueRaw = card.next_payment_due_date ?? card.statement_balance_due_date ?? null;
  const balanceRaw =
    card.statement_balance ?? card.last_statement_balance ?? null;

  // APR: prefer the purchase APR; fall back to any listed APR
  let apr: Decimal | null = null;
  if (Array.isArray(card.aprs) && card.aprs.length > 0) {
    const purchase = card.aprs.find((a) => a.apr_type === "purchase");
    const chosen = purchase?.apr_percentage ?? card.aprs.find((a) => a.apr_percentage != null)?.apr_percentage;
    apr = toDecimal(chosen);
  }

  return {
    dueDate: parseDate(dueRaw),
    statementBalance: toDecimal(balanceRaw),
    minimumPayment: toDecimal(card.minimum_payment_amount),
    apr,
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
    select: { id: true, entityId: true, plaidAccountId: true, nickname: true },
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

  // Fetch a fresh balance snapshot using accountsGet — more reliable than
  // transactionsSync balances, which can be null for investment/savings accounts.
  const syncedAt = new Date();
  const balanceRes = await getPlaidClient().accountsGet({ access_token: accessToken });
  const freshAccounts = balanceRes.data.accounts;

  // Credit card statement data: pull Liabilities and persist due date +
  // statement balance + minimum payment + APR per credit-card account.
  // Non-fatal: institutions without liability data simply skip.
  const cardsUpdated: SyncResult["cardsUpdated"] = [];
  let liabilitiesNote: string | null = null;
  const ccUpdatePromises: Promise<unknown>[] = [];
  try {
    const liabilitiesRes = await getPlaidClient().liabilitiesGet({ access_token: accessToken });
    const creditCards = liabilitiesRes.data.liabilities?.credit ?? [];
    if (creditCards.length === 0) {
      liabilitiesNote = "No credit card liability data returned — the bank may not support Liabilities, or the item may need re-linking to grant it.";
    }
    for (const card of creditCards) {
      if (!card.account_id) continue;
      const localAcct = accountByPlaidId.get(card.account_id);
      if (!localAcct) continue;
      const normalized = normalizeCardLiability(card as PlaidLiabilityCardShape);
      ccUpdatePromises.push(
        db.account.update({
          where: { id: localAcct.id },
          data: {
            ccDueDate: normalized.dueDate,
            ccStatementBalance: normalized.statementBalance,
            ccMinimumPayment: normalized.minimumPayment,
            ccApr: normalized.apr,
            ccDataAt: syncedAt,
          },
        })
      );
      cardsUpdated.push({
        accountNickname: localAcct.nickname,
        dueDate: normalized.dueDate?.toISOString() ?? null,
        statementBalance: normalized.statementBalance?.toString() ?? null,
      });
    }
  } catch (err) {
    // Extract Plaid's structured error code for a precise note
    const plaidData = (err as { response?: { data?: { error_code?: string; error_message?: string } } })?.response?.data;
    const code = plaidData?.error_code ?? null;
    const msg = plaidData?.error_message ?? (err as Error).message;
    if (code === "PRODUCTS_NOT_SUPPORTED") {
      liabilitiesNote = "This bank does not provide statement data through Plaid (Liabilities not supported). Enter the due date and statement balance manually via Edit on the account row.";
    } else if (code === "INVALID_PRODUCT") {
      liabilitiesNote = "Statement access was never granted for this bank login. Re-link the bank (Accounts → Re-link) and include card/statement access to enable it.";
    } else {
      liabilitiesNote = `Statement data unavailable: ${code ?? msg}`;
    }
    console.warn("[plaid-sync] liabilitiesGet failed", {
      itemId,
      code,
      message: msg,
    });
  }

  await Promise.all([
    db.plaidItem.update({
      where: { itemId },
      data: {
        cursorEncrypted: nextCursor ? encrypt(nextCursor) : null,
        lastSyncedAt: syncedAt,
        status: "active",
      },
    }),
    ...ccUpdatePromises,
    ...freshAccounts.map((pa) => {
      const localAcct = accountByPlaidId.get(pa.account_id);
      if (!localAcct) return Promise.resolve();
      // current is the primary balance for all account types; available is a fallback
      // for accounts where Plaid doesn't populate current (rare edge case).
      const balance = pa.balances.current ?? pa.balances.available;
      if (balance === null || balance === undefined) return Promise.resolve();
      return db.account.update({
        where: { id: localAcct.id },
        data: {
          currentBalance: new Decimal(balance),
          currentBalanceAt: syncedAt,
        },
      });
    }),
  ]);

  const institutionName = plaidItem.institutionName ?? null;

  // Log which products this item actually has granted (diagnoses why
  // liabilitiesGet fails when Liabilities wasn't granted at link time)
  try {
    const itemRes = await getPlaidClient().itemGet({ access_token: accessToken });
    console.log("[plaid-sync] item products", {
      itemId,
      institutionName,
      products: itemRes.data.item.products,
      billedProducts: itemRes.data.item.billed_products,
    });
  } catch {
    // Non-fatal diagnostic
  }

  console.log("[plaid-sync] complete", {
    itemId,
    institutionName,
    added,
    modified,
    removed,
    cardsUpdated: cardsUpdated.length,
    liabilitiesNote,
  });
  return { added, modified, removed, institutionName, cardsUpdated, liabilitiesNote };
}

// ── Auto-tag uncategorized transactions against saved tag rules ───────────────

/**
 * Applies saved tag rules to every currently-uncategorized (tag-less,
 * non-archived) transaction. Transactions that don't match any rule are left
 * blank for manual tagging — this never guesses.
 */
export async function autoTagUncategorizedTransactions(): Promise<{ tagged: number; scanned: number }> {
  const [rules, uncategorized] = await Promise.all([
    db.tagRule.findMany(),
    db.transaction.findMany({
      where: { archivedAt: null, tags: { none: {} } },
      select: { id: true, payeeNormalized: true, amount: true, accountId: true },
    }),
  ]);

  if (rules.length === 0 || uncategorized.length === 0) {
    return { tagged: 0, scanned: uncategorized.length };
  }

  const ruleInput = rules.map((r) => ({
    tagId: r.tagId,
    payeePattern: r.payeePattern,
    amountMin: r.amountMin ? Number(r.amountMin) : null,
    amountMax: r.amountMax ? Number(r.amountMax) : null,
    accountId: r.accountId,
    accountIds: r.accountIds ? (JSON.parse(r.accountIds) as string[]) : null,
  }));

  const assignments: { transactionId: string; tagId: string }[] = [];
  for (const tx of uncategorized) {
    if (!tx.payeeNormalized) continue;
    const matched = matchTagRule(ruleInput, {
      normalizedPayee: tx.payeeNormalized,
      amount: tx.amount.abs().toNumber(),
      accountId: tx.accountId,
    });
    if (matched) assignments.push({ transactionId: tx.id, tagId: matched });
  }

  if (assignments.length > 0) {
    await db.transactionTag.createMany({ data: assignments, skipDuplicates: true });
  }

  console.log("[plaid-sync] auto-tag complete", { scanned: uncategorized.length, tagged: assignments.length });
  return { tagged: assignments.length, scanned: uncategorized.length };
}
