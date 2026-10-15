// DB-aware, READ-ONLY inputs for the dashboard overview (lib/dashboard-overview.ts): the owner's saved Fixed/Variable
// choices and each budget line's own spend in the months before the one shown. No auth here (the page runs auth()
// first), no writes, nothing is logged but an error name. Spend per month comes from the same model as the dashboard's
// Spent (buildMonthSpend), applied to the CURRENT month's lines, so a line is judged by what its category really cost.
import { getAppSetting } from "@/lib/settings";
import { HISTORY_MONTHS, OVERRIDES_SETTING_KEY, parseOverrides, type KindOverrides } from "@/lib/expense-kind";
import { buildMonthSpend, type OwnAccountByMask, type SpendLineInput, type SpendTag } from "@/lib/month-spend";
import { loadMonthTransactions } from "@/lib/month-spend-build";
import { toCents } from "@/lib/dashboard-drill-build";

export async function loadKindOverrides(): Promise<KindOverrides> {
  return parseOverrides(await getAppSetting(OVERRIDES_SETTING_KEY));
}

/** The `count` periods (YYYY-MM) before `period`, oldest first. */
export function previousPeriods(period: string, count: number): string[] {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const out: string[] = [];
  for (let back = count; back >= 1; back -= 1) {
    const d = new Date(Date.UTC(year, month - 1 - back, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/**
 * Each line's own spend (cents, positive = spent) in each of the HISTORY_MONTHS months before `period`, oldest first,
 * keyed by line id. Rejects if any month cannot be read (the caller treats that as "history unavailable").
 */
export async function loadLineHistory(opts: {
  entityId: string | null;
  period: string;
  tags: SpendTag[];
  lines: SpendLineInput[];
  ownAccountByMask: OwnAccountByMask;
}): Promise<Record<string, number[]>> {
  const periods = previousPeriods(opts.period, HISTORY_MONTHS);
  const months = await Promise.all(periods.map((p) => loadMonthTransactions({ entityId: opts.entityId, period: p })));
  const out: Record<string, number[]> = {};
  for (const line of opts.lines) out[line.id] = [];
  for (const txs of months) {
    const model = buildMonthSpend(txs, opts.tags, opts.lines, { ownAccountByMask: opts.ownAccountByMask });
    for (const spend of model.lines) out[spend.id]?.push(toCents(spend.ownSpend));
  }
  return out;
}
