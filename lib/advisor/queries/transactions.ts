// Transaction search for the assistant. DB-aware, explicit select only. Never selects plaidTransactionId, receiptId, description (the bank
// memo, often a reference number) or any foreign key id other than the transaction's own id.

import { db } from "@/lib/db";
import { buildTransactionWhere, decodePage, type PageKey, type SearchInput } from "@/lib/advisor/tools/transactions-filter";

export interface TransactionRow {
  id: string;
  postedAt: Date;
  amount: { toString(): string };
  payeeRaw: string | null;
  payeeNormalized: string | null;
  notes: string | null;
  pending: boolean;
  transferPairId: string | null;
  account: { nickname: string };
  entity: { name: string };
  tags: { tag: { name: string } }[];
  glCode: { code: string; name: string } | null;
  project: { name: string } | null;
}

export interface TransactionSearchResult {
  rows: TransactionRow[];
  matchCount: number;
  sumOutflow: { toString(): string } | null;
  sumInflow: { toString(): string } | null;
  badPage: boolean;
}

export async function searchTransactions(input: SearchInput, limit: number): Promise<TransactionSearchResult> {
  let after: PageKey | null = null;
  if (input.page !== undefined) {
    after = decodePage(input.page);
    if (after === null) return { rows: [], matchCount: 0, sumOutflow: null, sumInflow: null, badPage: true };
  }
  const whole = buildTransactionWhere(input, null);
  const [rows, matchCount, out, inn] = await Promise.all([
    db.transaction.findMany({
      where: buildTransactionWhere(input, after),
      orderBy: [{ postedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        postedAt: true,
        amount: true,
        payeeRaw: true,
        payeeNormalized: true,
        notes: true,
        pending: true,
        transferPairId: true,
        account: { select: { nickname: true } },
        entity: { select: { name: true } },
        tags: { select: { tag: { select: { name: true } } } },
        glCode: { select: { code: true, name: true } },
        project: { select: { name: true } },
      },
    }),
    db.transaction.count({ where: whole }),
    db.transaction.aggregate({ where: { AND: [whole, { amount: { lt: 0 } }] }, _sum: { amount: true } }),
    db.transaction.aggregate({ where: { AND: [whole, { amount: { gt: 0 } }] }, _sum: { amount: true } }),
  ]);
  return { rows, matchCount, sumOutflow: out._sum.amount, sumInflow: inn._sum.amount, badPage: false };
}
