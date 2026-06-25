import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { listProjects, getProjectSpend } from "@/actions/projects";
import { getAllBusinessEntities } from "@/lib/entity";
import { db } from "@/lib/db";
import Link from "next/link";
import { CreateProjectForm } from "@/components/projects/create-project-form";
import type { Route } from "next";
import { Prisma } from "@prisma/client";

export default async function ProjectsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login" as Route);

  const [projects, entities, personalEntity] = await Promise.all([
    listProjects(),
    getAllBusinessEntities(),
    db.entity.findFirst({ where: { type: "personal" }, select: { id: true, name: true, navLabel: true } }),
  ]);

  const allEntities = [
    ...(personalEntity ? [{ id: personalEntity.id, name: personalEntity.name, navLabel: personalEntity.navLabel }] : []),
    ...entities.map((e) => ({ id: e.id, name: e.name, navLabel: e.navLabel })),
  ];

  // Fetch spend for each project in parallel
  const spendMap = new Map<string, Prisma.Decimal>();
  await Promise.all(
    projects.map(async (p) => {
      const spend = await getProjectSpend(p.id);
      spendMap.set(p.id, spend.total);
    })
  );

  const active = projects.filter((p) => p.status === "active");
  const completed = projects.filter((p) => p.status === "completed");
  const paused = projects.filter((p) => p.status === "paused");

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Projects</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Cross-entity project budgets — assign transactions and receipts from any account.
            </p>
          </div>
          <CreateProjectForm entities={allEntities} />
        </div>

        {projects.length === 0 && (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No projects yet. Create one to start tracking expenses against a budget.
          </div>
        )}

        {active.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Active</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {active.map((p) => {
                const budget = new Prisma.Decimal(p.budget.toString());
                const spend = spendMap.get(p.id) ?? new Prisma.Decimal(0);
                const pct = budget.gt(0) ? Math.min(100, spend.div(budget).times(100).toNumber()) : 0;
                const remaining = budget.minus(spend);
                return (
                  <Link
                    key={p.id}
                    href={`/projects/${p.id}` as Route}
                    className="rounded-lg border bg-card p-5 hover:border-primary/50 transition-colors block"
                  >
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-semibold leading-tight">{p.name}</p>
                          {p.entity && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {p.entity.navLabel ?? p.entity.name}
                            </p>
                          )}
                        </div>
                        {p.targetDate && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            Due {new Date(p.targetDate).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
                          </span>
                        )}
                      </div>

                      {p.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">{p.description}</p>
                      )}

                      <div>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-muted-foreground">
                            ${spend.toFixed(2)} spent
                          </span>
                          <span className={pct >= 100 ? "font-semibold text-destructive" : "font-medium"}>
                            {Math.round(pct)}%
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full transition-all ${pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-primary"}`}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-xs mt-1">
                          <span className={remaining.lt(0) ? "text-destructive font-medium" : "text-muted-foreground"}>
                            {remaining.lt(0) ? `$${remaining.abs().toFixed(2)} over` : `$${remaining.toFixed(2)} remaining`}
                          </span>
                          <span className="text-muted-foreground">
                            Budget: ${budget.toFixed(2)}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{p._count.transactions} transaction{p._count.transactions !== 1 ? "s" : ""}</span>
                        {p._count.receipts > 0 && (
                          <span>{p._count.receipts} receipt{p._count.receipts !== 1 ? "s" : ""}</span>
                        )}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {paused.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Paused</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {paused.map((p) => {
                const budget = new Prisma.Decimal(p.budget.toString());
                const spend = spendMap.get(p.id) ?? new Prisma.Decimal(0);
                return (
                  <Link key={p.id} href={`/projects/${p.id}` as Route}
                    className="rounded-lg border bg-card p-5 hover:border-primary/50 transition-colors block opacity-70">
                    <p className="font-semibold">{p.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      ${spend.toFixed(2)} of ${budget.toFixed(2)} budget
                    </p>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {completed.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Completed</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {completed.map((p) => {
                const budget = new Prisma.Decimal(p.budget.toString());
                const spend = spendMap.get(p.id) ?? new Prisma.Decimal(0);
                return (
                  <Link key={p.id} href={`/projects/${p.id}` as Route}
                    className="rounded-lg border bg-card p-5 hover:border-primary/50 transition-colors block opacity-60">
                    <p className="font-semibold">{p.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      ${spend.toFixed(2)} of ${budget.toFixed(2)} budget · Completed
                    </p>
                  </Link>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}
