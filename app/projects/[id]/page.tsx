import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import {
  getProject,
  getProjectSpend,
  getProjectTransactions,
  getProjectReceipts,
} from "@/actions/projects";
import { ProjectDetailActions } from "@/components/projects/project-detail-actions";
import type { Route } from "next";
import { Prisma } from "@prisma/client";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ProjectDetailPage({ params }: Props) {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const { id } = await params;
  const [project, spend, transactions, receipts] = await Promise.all([
    getProject(id),
    getProjectSpend(id),
    getProjectTransactions(id),
    getProjectReceipts(id),
  ]);

  if (!project || project.archivedAt) notFound();

  const budget = new Prisma.Decimal(project.budget.toString());
  const total = spend.total;
  const remaining = budget.minus(total);
  const pct = budget.gt(0) ? Math.min(100, total.div(budget).times(100).toNumber()) : 0;

  const STATUS_BADGE: Record<string, string> = {
    active: "bg-green-50 text-green-700 border-green-200",
    completed: "bg-blue-50 text-blue-700 border-blue-200",
    paused: "bg-amber-50 text-amber-700 border-amber-200",
  };

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-semibold">{project.name}</h1>
              <span className={`rounded border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[project.status] ?? STATUS_BADGE.active}`}>
                {project.status}
              </span>
            </div>
            {project.entity && (
              <p className="text-sm text-muted-foreground">
                {project.entity.navLabel ?? project.entity.name}
              </p>
            )}
            {project.description && (
              <p className="text-sm text-muted-foreground mt-1">{project.description}</p>
            )}
          </div>
          <ProjectDetailActions project={project} />
        </div>

        {/* Budget summary */}
        <div className="rounded-lg border bg-card p-5 space-y-4">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Budget</p>
              <p className="text-xl font-semibold mt-1">${budget.toFixed(2)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Spent</p>
              <p className={`text-xl font-semibold mt-1 ${total.gt(budget) ? "text-destructive" : ""}`}>
                ${total.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide">
                {remaining.lt(0) ? "Over Budget" : "Remaining"}
              </p>
              <p className={`text-xl font-semibold mt-1 ${remaining.lt(0) ? "text-destructive" : "text-green-600"}`}>
                ${remaining.abs().toFixed(2)}
              </p>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-muted-foreground">
                {Math.round(pct)}% of budget used
              </span>
              {project.targetDate && (
                <span className="text-muted-foreground">
                  Target: {new Date(project.targetDate).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
                </span>
              )}
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-primary"}`}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
          </div>

          {(spend.transactionTotal.gt(0) || spend.receiptTotal.gt(0)) && (
            <div className="flex gap-6 text-sm text-muted-foreground pt-1 border-t">
              <span>Transactions: <span className="text-foreground font-medium">${spend.transactionTotal.toFixed(2)}</span></span>
              <span>Receipts: <span className="text-foreground font-medium">${spend.receiptTotal.toFixed(2)}</span></span>
            </div>
          )}
        </div>

        {/* Transactions */}
        <section>
          <h2 className="text-base font-semibold mb-3">
            Transactions <span className="text-muted-foreground font-normal text-sm">({transactions.length})</span>
          </h2>
          {transactions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No transactions assigned to this project yet. Open a transaction and select this project to assign it.
            </p>
          ) : (
            <div className="rounded-lg border divide-y">
              {transactions.map((tx) => {
                const amt = new Prisma.Decimal(tx.amount.toString());
                return (
                  <div key={tx.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{tx.payeeRaw ?? tx.description ?? "—"}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(tx.postedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        {" · "}
                        {tx.account.nickname}{tx.account.mask ? ` (${tx.account.mask})` : ""}
                        {" · "}
                        {tx.entity.navLabel ?? tx.entity.name}
                      </p>
                      {tx.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {tx.tags.map(({ tag }) => (
                            <span key={tag.id} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                              {tag.shortName}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className={`font-mono text-sm font-medium ${amt.lt(0) ? "text-destructive" : "text-green-600"}`}>
                        {amt.lt(0) ? "-" : "+"}${amt.abs().toFixed(2)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Receipts */}
        <section>
          <h2 className="text-base font-semibold mb-3">
            Receipts <span className="text-muted-foreground font-normal text-sm">({receipts.length})</span>
          </h2>
          {receipts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No receipts assigned to this project yet.
            </p>
          ) : (
            <div className="rounded-lg border divide-y">
              {receipts.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{r.vendor ?? "Unknown vendor"}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {r.receiptDate
                        ? new Date(r.receiptDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                        : "No date"}
                      {" · "}
                      {r.entity.navLabel ?? r.entity.name}
                    </p>
                    {r.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{r.description}</p>
                    )}
                  </div>
                  <span className="font-mono text-sm font-medium text-destructive shrink-0">
                    {r.total ? `-$${new Prisma.Decimal(r.total.toString()).abs().toFixed(2)}` : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
