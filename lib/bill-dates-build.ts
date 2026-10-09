// DB-aware, READ-ONLY loader for the Budget schedule index used by lib/bill-dates.ts. Explicit select of the schedule
// fields only (never amounts other than annualAmountDue, never account data). No auth: the CALLER owns access
// control. FAIL-SOFT: on any error it returns an empty index with `failed: true`, so every caller behaves exactly as
// it did before this feature (the bill record's own dates) and may show one muted note. Logs err.name only.

import { db } from "@/lib/db";
import {
  buildBudgetScheduleIndex,
  periodsBetween,
  type BudgetScheduleIndex,
  type BudgetScheduleRow,
} from "@/lib/bill-dates";

export interface LoadedBudgetIndex {
  index: BudgetScheduleIndex;
  failed: boolean;
}

/** Budget schedule rows for every month touched by [from, to), as an index. Never rejects. */
export async function loadBudgetScheduleIndex(opts: { from: Date; to: Date }): Promise<LoadedBudgetIndex> {
  try {
    const periods = periodsBetween(opts.from, opts.to);
    if (periods.length === 0) return { index: new Map(), failed: false };
    const rows = await db.budget.findMany({
      where: { period: { in: periods } },
      select: {
        entityId: true,
        tagId: true,
        period: true,
        payDay: true,
        frequency: true,
        payDayOfWeek: true,
        biweeklyAnchorDate: true,
        payMonth: true,
        annualAmountDue: true,
      },
    });
    const mapped: BudgetScheduleRow[] = rows.map((r) => ({
      entityId: r.entityId,
      tagId: r.tagId,
      period: r.period,
      payDay: r.payDay,
      frequency: r.frequency,
      payDayOfWeek: r.payDayOfWeek,
      biweeklyAnchorDate: r.biweeklyAnchorDate,
      payMonth: r.payMonth,
      annualAmountDue: r.annualAmountDue,
    }));
    return { index: buildBudgetScheduleIndex(mapped), failed: false };
  } catch (err) {
    console.error("Budget schedule index unavailable", err instanceof Error ? err.name : "UnknownError");
    return { index: new Map(), failed: true };
  }
}
