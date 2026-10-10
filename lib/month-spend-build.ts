// Read-only loader for the month's transactions behind the dashboard, /budgets and the drill-down dialogs. It does not
// authenticate (callers run auth() first), does not write, and does not read the Budget table (callers pass their lines
// to buildMonthSpend). Explicit selects only: no description, no notes, no account mask, no tokens.
import { db } from "@/lib/db";
import { Decimal } from "@prisma/client/runtime/library";
import { periodBounds, type SpendTx } from "@/lib/month-spend";

export async function loadMonthTransactions(opts: { entityId: string | null; period: string }): Promise<SpendTx[]> {
  const { start, end } = periodBounds(opts.period);
  const rows = await db.transaction.findMany({
    where: {
      ...(opts.entityId ? { entityId: opts.entityId } : {}),
      archivedAt: null,
      postedAt: { gte: start, lt: end },
    },
    select: {
      id: true,
      postedAt: true,
      amount: true,
      payeeRaw: true,
      payeeNormalized: true,
      pending: true,
      transferPairId: true,
      accountId: true,
      entityId: true,
      account: { select: { nickname: true, accountType: true } },
      entity: { select: { name: true } },
      tags: { select: { tagId: true } },
    },
    orderBy: [{ postedAt: "desc" }, { id: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    day: r.postedAt.toISOString().slice(0, 10),
    amount: new Decimal(r.amount.toString()),
    payee: r.payeeRaw ?? r.payeeNormalized ?? "(no payee)",
    accountId: r.accountId,
    accountNickname: r.account.nickname,
    accountType: r.account.accountType,
    entityId: r.entityId,
    entityName: r.entity.name,
    pending: r.pending,
    transferPairId: r.transferPairId,
    tagIds: r.tags.map((t) => t.tagId),
  }));
}
