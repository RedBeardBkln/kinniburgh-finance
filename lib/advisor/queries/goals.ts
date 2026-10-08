// Financial goal reads for the assistant. DB-aware, explicit select only.

import { db } from "@/lib/db";

export interface GoalRow {
  title: string;
  description: string | null;
  category: string;
  targetAmountCents: number | null;
  currentAmountCents: number | null;
  targetDate: Date | null;
  priority: number;
  status: string;
  notes: string | null;
}

export async function loadGoals(status: "active" | "achieved" | "paused" | "all", take: number): Promise<GoalRow[]> {
  return db.financialGoal.findMany({
    where: status === "all" ? { status: { not: "deleted" } } : { status },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take,
    select: {
      title: true,
      description: true,
      category: true,
      targetAmountCents: true,
      currentAmountCents: true,
      targetDate: true,
      priority: true,
      status: true,
      notes: true,
    },
  });
}
