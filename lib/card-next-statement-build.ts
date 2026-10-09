// DB-aware, READ-ONLY loader for the credit-card statement projections (lib/card-next-statement.ts). No writes, no
// auth: like lib/upcoming-ledger-build.ts the CALLER (a page that has already run auth(), or a cron job) is
// responsible for access control. Every read uses an explicit select. Nothing here logs an amount, payee or
// account identifier: a failure logs err.name only. FAIL-SOFT: any error returns { projections: [], error: true }
// and the caller shows its pre-existing behaviour (statement on file only) plus one muted notice.

import { Decimal } from "@prisma/client/runtime/library";
import { db } from "@/lib/db";
import { todayForNewYork } from "@/lib/upcoming-ledger";
import {
  projectCardStatements,
  type BankOutflowRow,
  type CardInput,
  type CardProjection,
  type CardTxRow,
} from "@/lib/card-next-statement";

/** How far back the card and bank history is read (a little over six months of payments). */
const HISTORY_DAYS = 200;
/** Most distinct payment amounts looked up on the bank side (a safety cap on the query size). */
const MAX_AMOUNT_LOOKUPS = 400;
const DAY_MS = 86_400_000;

export interface LoadedCardProjections {
  /** The America/New_York calendar date, as UTC midnight (what the projections were computed for). */
  today: Date;
  projections: CardProjection[];
  /** True when the read failed: `projections` is then empty and the caller must say so, not imply "no cards". */
  error: boolean;
}

export async function loadCardProjections(args: { now: Date }): Promise<LoadedCardProjections> {
  const today = todayForNewYork(args.now);
  try {
    const since = new Date(today.getTime() - HISTORY_DAYS * DAY_MS);

    const cards = await db.account.findMany({
      where: { accountType: "credit_card", archivedAt: null },
      select: {
        id: true,
        nickname: true,
        entityId: true,
        currentBalance: true,
        currentBalanceAt: true,
        ccDueDate: true,
        ccStatementBalance: true,
      },
      orderBy: { nickname: "asc" },
    });
    if (cards.length === 0) return { today, projections: [], error: false };

    const cardTxs = await db.transaction.findMany({
      where: { accountId: { in: cards.map((c) => c.id) }, archivedAt: null, postedAt: { gte: since } },
      select: { accountId: true, postedAt: true, amount: true, payeeNormalized: true, payeeRaw: true, pending: true },
    });

    const txsByCard = new Map<string, CardTxRow[]>();
    const inflowAmounts = new Set<string>();
    for (const t of cardTxs) {
      const amount = new Decimal(t.amount.toString());
      const row: CardTxRow = {
        postedAt: t.postedAt,
        amount,
        text: [t.payeeNormalized, t.payeeRaw].filter((s): s is string => !!s).join(" "),
        pending: t.pending,
      };
      const list = txsByCard.get(t.accountId) ?? [];
      list.push(row);
      txsByCard.set(t.accountId, list);
      if (!t.pending && amount.greaterThan(0)) inflowAmounts.add(amount.toFixed(2));
    }

    // Bank side: only outflows whose amount equals an inflow on a card (a payment), so the read stays small.
    const lookups = [...inflowAmounts].slice(0, MAX_AMOUNT_LOOKUPS).map((a) => new Decimal(a).negated().toFixed(2));
    const bankRows =
      lookups.length === 0
        ? []
        : await db.transaction.findMany({
            where: {
              archivedAt: null,
              pending: false,
              postedAt: { gte: since },
              amount: { in: lookups.map((a) => new Decimal(a)) },
              account: { archivedAt: null, accountType: { in: ["checking", "savings"] } },
            },
            select: {
              accountId: true,
              postedAt: true,
              amount: true,
              payeeNormalized: true,
              payeeRaw: true,
              account: { select: { nickname: true } },
            },
          });
    const bankOutflows: BankOutflowRow[] = bankRows.map((r) => ({
      accountId: r.accountId,
      accountNickname: r.account.nickname,
      postedAt: r.postedAt,
      amount: new Decimal(r.amount.toString()),
      text: [r.payeeNormalized, r.payeeRaw].filter((s): s is string => !!s).join(" "),
    }));

    const projections = cards.map((c) => {
      const input: CardInput = {
        id: c.id,
        nickname: c.nickname,
        entityId: c.entityId,
        currentBalance: c.currentBalance === null ? null : new Decimal(c.currentBalance.toString()),
        currentBalanceAt: c.currentBalanceAt,
        ccDueDate: c.ccDueDate,
        ccStatementBalance: c.ccStatementBalance === null ? null : new Decimal(c.ccStatementBalance.toString()),
        txs: txsByCard.get(c.id) ?? [],
      };
      return projectCardStatements({ card: input, bankOutflows, today });
    });
    return { today, projections, error: false };
  } catch (err) {
    console.error("Card statement projections unavailable", err instanceof Error ? err.name : "UnknownError");
    return { today, projections: [], error: true };
  }
}
