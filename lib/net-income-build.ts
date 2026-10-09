// DB-aware, READ-ONLY loader for income sources with their NET (take-home) amount resolved (lib/net-income.ts).
// This is the ONLY forecast-side module that reads `incomeSource` (a guard test pins it): every forecast, ledger,
// notification and advisor path gets its paychecks from here, so none of them can keep using the gross amount.
// IncomeSource.amount itself is never changed (it stays the gross shown on the Income page and used for tax work).
//
// No auth here: the CALLER (a page that already ran auth(), a server action after requireAuth(), a cron job) owns
// access control. Explicit selects only. A failed read of the SOURCES propagates (callers are already fail-soft);
// a failed read of deposits or paystubs degrades to basis "gross_unknown" with the label "take-home could not be
// read" (a flagged assumption, never a silent gross). Logs err.name only. Matching is local text comparison only;
// no names are sent anywhere.

import type { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { db } from "@/lib/db";
import {
  NET_LOOKBACK_DAYS,
  resolveNetIncome,
  unreadableNetInfo,
  type DepositRow,
  type NetBasis,
  type NetIncomeInfo,
  type StubRow,
} from "@/lib/net-income";

export interface LoadNetIncomeOptions {
  /** Extra filter on the sources (e.g. one account or one entity). `active: true` is applied unless includeInactive. */
  where?: Prisma.IncomeSourceWhereInput;
  includeInactive?: boolean;
  withAccount?: boolean;
  withEntity?: boolean;
  take?: number;
  now?: Date;
}

/** An income source whose `amount` is the NET per-paycheck figure to forecast with. */
export interface NetIncomeSourceRow {
  id: string;
  entityId: string;
  accountId: string;
  description: string;
  cadence: string;
  dayRules: Prisma.JsonValue;
  active: boolean;
  /** NET (take-home) per paycheck, or the gross when `amountBasis` is "gross_unknown". Use this for forecasting. */
  amount: Decimal;
  /** The stored gross amount, unchanged. */
  grossAmount: Decimal;
  amountBasis: NetBasis;
  netInfo: NetIncomeInfo;
  account?: { nickname: string; mask: string | null };
  entity?: { name: string };
}

const DEPOSIT_TAKE = 400;
const STUB_TAKE = 24;
const DAY_MS = 86400000;

/** Active income sources with take-home resolved. Rejects only if the sources themselves cannot be read. */
export async function loadNetIncomeSources(opts: LoadNetIncomeOptions = {}): Promise<NetIncomeSourceRow[]> {
  const now = opts.now ?? new Date();
  const where: Prisma.IncomeSourceWhereInput = {
    ...(opts.includeInactive ? {} : { active: true }),
    ...(opts.where ?? {}),
  };
  const sources = await db.incomeSource.findMany({
    where,
    select: {
      id: true,
      entityId: true,
      accountId: true,
      description: true,
      cadence: true,
      dayRules: true,
      amount: true,
      active: true,
      ...(opts.withAccount ? { account: { select: { nickname: true, mask: true } } } : {}),
      ...(opts.withEntity ? { entity: { select: { name: true } } } : {}),
    },
    orderBy: [{ description: "asc" }, { id: "asc" }],
    ...(opts.take != null ? { take: opts.take } : {}),
  });
  if (sources.length === 0) return [];

  let deposits: (DepositRow & { entityId: string })[] | null = null;
  let stubs: (StubRow & { entityId: string })[] | null = null;
  try {
    const accountIds = [...new Set(sources.map((s) => s.accountId))];
    const since = new Date(now.getTime() - NET_LOOKBACK_DAYS * DAY_MS);
    const [txRows, stubRows] = await Promise.all([
      db.transaction.findMany({
        where: {
          accountId: { in: accountIds },
          archivedAt: null,
          pending: false,
          transferPairId: null,
          amount: { gt: 0 },
          postedAt: { gte: since },
        },
        select: { postedAt: true, amount: true, payeeNormalized: true, accountId: true, entityId: true },
        orderBy: { postedAt: "desc" },
        take: DEPOSIT_TAKE,
      }),
      db.paystub.findMany({
        where: { archivedAt: null, confirmedAt: { not: null }, netPayCents: { not: null } },
        select: {
          entityId: true,
          employerName: true,
          payDate: true,
          payFrequency: true,
          grossPayCents: true,
          netPayCents: true,
          depositAccountId: true,
        },
        orderBy: { payDate: "desc" },
        take: STUB_TAKE,
      }),
    ]);
    deposits = txRows.map((t) => ({
      postedAt: t.postedAt,
      amount: new Decimal(String(t.amount)),
      payee: t.payeeNormalized,
      accountId: t.accountId,
      entityId: t.entityId,
    }));
    stubs = stubRows;
  } catch (err) {
    console.error("Net income inputs unavailable", err instanceof Error ? err.name : "UnknownError");
  }

  return sources.map((s) => {
    const gross = new Decimal(String(s.amount));
    const input = {
      id: s.id,
      accountId: s.accountId,
      entityId: s.entityId,
      description: s.description,
      cadence: s.cadence,
      dayRules: s.dayRules,
      amount: gross,
      active: s.active,
    };
    const info =
      deposits && stubs
        ? resolveNetIncome(
            input,
            deposits,
            stubs.filter((st) => st.entityId === s.entityId),
            now
          )
        : unreadableNetInfo(input);
    const row: NetIncomeSourceRow = {
      id: s.id,
      entityId: s.entityId,
      accountId: s.accountId,
      description: s.description,
      cadence: s.cadence,
      dayRules: s.dayRules,
      active: s.active,
      amount: info.net,
      grossAmount: gross,
      amountBasis: info.basis,
      netInfo: info,
    };
    const withAcct = s as { account?: { nickname: string; mask: string | null }; entity?: { name: string } };
    if (withAcct.account) row.account = withAcct.account;
    if (withAcct.entity) row.entity = withAcct.entity;
    return row;
  });
}

/** Fail-soft convenience for callers that must never throw: [] with `failed: true` when the sources cannot be read. */
export async function loadNetIncomeSourcesSafe(
  opts: LoadNetIncomeOptions = {}
): Promise<{ sources: NetIncomeSourceRow[]; failed: boolean }> {
  try {
    return { sources: await loadNetIncomeSources(opts), failed: false };
  } catch (err) {
    console.error("Income sources unavailable", err instanceof Error ? err.name : "UnknownError");
    return { sources: [], failed: true };
  }
}
