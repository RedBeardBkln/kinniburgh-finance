// DB-aware, READ-ONLY loader for the projects the forecast may count (lib/project-forecast.ts). No writes, no auth: the
// CALLER (a page that already ran auth(), a server action after requireAuth(), a notification job) owns access control.
// Explicit selects only. Spending so far is the Projects pages' definition: the project's outflow transactions
// (negative amounts, not archived) plus its receipts with a total. Rejects if the projects themselves cannot be read;
// callers are fail-soft.
import { Decimal } from "@prisma/client/runtime/library";
import { db } from "@/lib/db";
import type { ProjectForecastInput } from "@/lib/project-forecast";

export async function loadForecastProjects(opts: { entityId?: string | null } = {}): Promise<ProjectForecastInput[]> {
  const projects = await db.project.findMany({
    where: { archivedAt: null, status: "active", ...(opts.entityId ? { account: { entityId: opts.entityId } } : {}) },
    select: {
      id: true,
      name: true,
      entityId: true,
      accountId: true,
      status: true,
      budget: true,
      targetDate: true,
      account: { select: { entityId: true } },
    },
    orderBy: [{ targetDate: "asc" }, { id: "asc" }],
  });
  if (projects.length === 0) return [];
  const ids = projects.map((p) => p.id);
  const [txSums, receiptSums] = await Promise.all([
    db.transaction.groupBy({
      by: ["projectId"],
      where: { projectId: { in: ids }, archivedAt: null, amount: { lt: 0 } },
      _sum: { amount: true },
    }),
    db.receipt.groupBy({
      by: ["projectId"],
      where: { projectId: { in: ids }, archivedAt: null, total: { not: null } },
      _sum: { total: true },
    }),
  ]);
  const spent = new Map<string, Decimal>();
  for (const r of txSums) {
    if (r.projectId && r._sum.amount) spent.set(r.projectId, new Decimal(r._sum.amount.toString()).abs());
  }
  for (const r of receiptSums) {
    if (r.projectId && r._sum.total) {
      spent.set(r.projectId, (spent.get(r.projectId) ?? new Decimal(0)).plus(new Decimal(r._sum.total.toString()).abs()));
    }
  }
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    entityId: p.entityId,
    accountId: p.accountId,
    accountEntityId: p.account?.entityId ?? null,
    status: p.status,
    budget: new Decimal(p.budget.toString()),
    spent: spent.get(p.id) ?? new Decimal(0),
    targetDate: p.targetDate,
  }));
}
