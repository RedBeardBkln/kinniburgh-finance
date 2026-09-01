import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { listTaxDeadlines } from "@/actions/tax-deadlines";
import { MarkFiledButton } from "@/components/tax/deadline-actions";
import { AddDeadlineForm } from "@/components/tax/add-deadline-form";
import { TaxEntityWidget, type TaxWidgetData } from "@/components/tax/tax-entity-widget";
import { computePL } from "@/lib/reports";

export default async function TaxPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const [workspaces, deadlines, allEntities] = await Promise.all([
    db.taxWorkspace.findMany({
      include: { entity: true, checklistItems: true },
      orderBy: [{ taxYear: "desc" }, { createdAt: "asc" }],
    }),
    listTaxDeadlines(),
    db.entity.findMany({
      where: { archivedAt: null, type: { in: ["personal", "business"] } },
      orderBy: [{ type: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true, foundedDate: true, slug: true },
    }),
  ]);

  // Documents per entity+year for the widgets
  const docYearCounts = await db.document.groupBy({
    by: ["entityId", "taxYear"],
    where: { archivedAt: null },
    _count: { _all: true },
  });
  const docKey = (entityId: string, year: number) => `${entityId}:${year}`;
  const docCountMap = new Map(
    docYearCounts
      .filter((d) => d.taxYear !== null)
      .map((d) => [docKey(d.entityId, d.taxYear!), d._count._all])
  );

  // ── Build year-grouped widget data ────────────────────────────────────────
  // Years: every workspace year, plus the current year.
  const currentYear = new Date().getUTCFullYear();
  const yearSet = new Set<number>(workspaces.map((w) => w.taxYear));
  yearSet.add(currentYear);
  const years = Array.from(yearSet).sort((a, b) => b - a);

  const shortName = (name: string) => name.split(",")[0] ?? name;

  // Per-entity P&L totals, computed per year (only for years with a workspace
  // or the current year, to bound the work).
  const plCache = new Map<string, { totalIncome: string; totalExpenses: string }>();
  await Promise.all(
    years.flatMap((year) =>
      allEntities.map(async (e) => {
        const key = docKey(e.id, year);
        void key;
        const from = new Date(Date.UTC(year, 0, 1));
        const to = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
        try {
          const pl = await computePL(e.id, from, to);
          plCache.set(docKey(e.id, year), {
            totalIncome: pl.totalIncome.toString(),
            totalExpenses: pl.totalExpenses.toString(),
          });
        } catch {
          // P&L is a nice-to-have — a failure must not break the page
        }
      })
    )
  );

  function widgetData(entityId: string, year: number): TaxWidgetData {
    const entity = allEntities.find((e) => e.id === entityId)!;
    const ws = workspaces.find((w) => w.entityId === entityId && w.taxYear === year);
    const pl = plCache.get(docKey(entityId, year)) ?? null;

    // Personal workspaces use the dedicated personal flow (questions, AI
    // review, form plan); business workspaces use the generic workspace view.
    const workspaceHref = ws
      ? entity.type === "personal"
        ? `/tax/personal/${year}`
        : `/tax/${ws.id}`
      : null;

    return {
      entityId: entity.id,
      entityName: entity.name,
      entityShortName: shortName(entity.name),
      entityType: entity.type,
      taxYear: year,
      workspaceId: ws?.id ?? null,
      status: ws?.status ?? null,
      deadline: ws?.deadline?.toISOString() ?? null,
      totalIncome: pl?.totalIncome ?? null,
      totalExpenses: pl?.totalExpenses ?? null,
      documentCount: docCountMap.get(docKey(entity.id, year)) ?? 0,
      completedItems: ws
        ? ws.checklistItems.filter((i) => i.completed).length
        : 0,
      totalItems: ws ? ws.checklistItems.length : 0,
      plUrl: ws ? `/api/export/${entity.id}?year=${year}` : null,
      balanceSheetUrl:
        ws && entity.type === "business" && entity.slug
          ? `/business/${entity.slug}/balance-sheet`
          : null,
      workspaceHref,
    };
  }

  // Entities eligible per year: Personal + businesses. A business formed after
  // the year started has no filing for that year (e.g. Sudden Valley, founded
  // Feb 2026, has no 2025 workspace).
  function entitiesForYear(year: number) {
    return allEntities.filter((e) => {
      if (e.type === "personal") return true;
      if (!e.foundedDate) return true; // no founding date recorded — show it
      // Entity must have existed during the tax year
      return e.foundedDate.getUTCFullYear() <= year;
    });
  }

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Tax Workspaces</h1>
          <p className="text-sm text-muted-foreground">
            Filing workspaces organized by tax year — one per entity. Financial
            data, documents, and drafts all live in one place. Confirm all
            deadlines with your CPA — this is not tax advice.
          </p>
        </div>

        {years.map((year) => (
          <section key={year} className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{year}</h2>
              {year === currentYear && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  Current year
                </span>
              )}
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {entitiesForYear(year).map((entity) => (
                <TaxEntityWidget key={entity.id} data={widgetData(entity.id, year)} />
              ))}
            </div>
          </section>
        ))}

        {/* Tax Deadlines */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Deadlines</h2>
            <AddDeadlineForm entities={allEntities} />
          </div>
          {deadlines.length === 0 ? (
            <p className="text-sm text-muted-foreground">No upcoming deadlines.</p>
          ) : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Entity</th>
                      <th className="px-4 py-2 font-medium">Label</th>
                      <th className="px-4 py-2 font-medium">Type</th>
                      <th className="px-4 py-2 font-medium">Due Date</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {deadlines.map((d) => {
                      const info = getDeadlineInfo(d.dueDate);
                      return (
                        <tr key={d.id} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="px-4 py-2 text-xs text-muted-foreground">
                            {d.entity.name.split(",")[0]}
                          </td>
                          <td className="px-4 py-2 font-medium">{d.label}</td>
                          <td className="px-4 py-2 text-xs">
                            <span className="rounded-full bg-muted px-2 py-0.5">
                              {TYPE_LABELS[d.type] ?? d.type}
                            </span>
                          </td>
                          <td className="px-4 py-2 tabular-nums">
                            {d.dueDate.toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                              timeZone: "America/New_York",
                            })}
                            <span className={`ml-2 text-xs font-medium ${info.overdue ? "text-destructive" : info.soon ? "text-amber-600" : "text-muted-foreground"}`}>
                              {info.label}
                            </span>
                          </td>
                          <td className="px-4 py-2">
                            <DeadlineStatusBadge status={d.status} />
                          </td>
                          <td className="px-4 py-2">
                            {d.status === "upcoming" && <MarkFiledButton id={d.id} />}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}

const TYPE_LABELS: Record<string, string> = {
  quarterly_est: "Quarterly Est.",
  annual: "Annual",
  extension: "Extension",
  other: "Other",
};

function DeadlineStatusBadge({ status }: { status: string }) {
  if (status === "filed") return <span className="rounded-full border border-green-300 px-2 py-0.5 text-xs text-green-700">Filed</span>;
  if (status === "waived") return <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Waived</span>;
  return <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Upcoming</span>;
}

function getDeadlineInfo(deadline: Date): { label: string; overdue: boolean; soon: boolean } {
  const now = new Date();
  const diff = deadline.getTime() - now.getTime();
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));

  if (days < 0) return { label: `${Math.abs(days)} days overdue`, overdue: true, soon: false };
  if (days === 0) return { label: "Due today!", overdue: true, soon: false };
  if (days === 1) return { label: "Due tomorrow", overdue: false, soon: true };
  if (days <= 30) return { label: `${days} days remaining`, overdue: false, soon: true };
  return { label: `${days} days remaining`, overdue: false, soon: false };
}