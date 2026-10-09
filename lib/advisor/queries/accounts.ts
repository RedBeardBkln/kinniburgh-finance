// Account reads for the assistant. DB-aware, explicit select only. Never selects plaidItemId, plaidAccountId or the PlaidItem row; the
// last-4 `mask` is the only account identifier returned (decision D10).

import { db } from "@/lib/db";

export interface AccountRow {
  nickname: string;
  accountType: string;
  mask: string | null;
  integrationMode: string;
  currentBalance: { toString(): string } | null;
  currentBalanceAt: Date | null;
  minimumBalance: { toString(): string } | null;
  ccDueDate: Date | null;
  ccStatementBalance: { toString(): string } | null;
  ccApr: { toString(): string } | null;
  archivedAt: Date | null;
  entity: { name: string };
  institution: { name: string };
}

export async function loadAccounts(opts: { entity?: string; includeArchived: boolean; take: number }): Promise<AccountRow[]> {
  return db.account.findMany({
    where: {
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      ...(opts.entity !== undefined
        ? { entity: { OR: [{ name: { equals: opts.entity, mode: "insensitive" as const } }, { slug: { equals: opts.entity, mode: "insensitive" as const } }] } }
        : {}),
    },
    orderBy: [{ entity: { name: "asc" } }, { nickname: "asc" }],
    take: opts.take,
    select: {
      nickname: true,
      accountType: true,
      mask: true,
      integrationMode: true,
      currentBalance: true,
      currentBalanceAt: true,
      minimumBalance: true,
      ccDueDate: true,
      ccStatementBalance: true,
      ccApr: true,
      archivedAt: true,
      entity: { select: { name: true } },
      institution: { select: { name: true } },
    },
  });
}
