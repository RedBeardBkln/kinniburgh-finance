import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { AppShell } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listTaxWorkspaces } from "@/actions/tax";
import { listTaxDeadlines } from "@/actions/tax-deadlines";
import { MarkFiledButton } from "@/components/tax/deadline-actions";
import { AddDeadlineForm } from "@/components/tax/add-deadline-form";
import Link from "next/link";
import type { Route } from "next";

export default async function TaxPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const [workspaces, deadlines, allEntities] = await Promise.all([
    listTaxWorkspaces(),
    listTaxDeadlines(),
    db.entity.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Tax Workspaces</h1>
          <p className="text-sm text-muted-foreground">
            Filing checklists and document collections per entity and tax year.
            Confirm all deadlines with your CPA — this is not tax advice.
          </p>
        </div>

        {workspaces.length === 0 && (
          <p className="text-muted-foreground">No tax workspaces yet.</p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {workspaces.map((ws) => {
            const progress = ws.totalItems > 0 ? (ws.completedItems / ws.totalItems) * 100 : 0;
            const deadlineInfo = ws.deadline ? getDeadlineInfo(ws.deadline) : null;

            return (
              <Card key={ws.id} className={deadlineInfo?.overdue ? "border-destructive/40" : ""}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">
                        {ws.entity.name.split(",")[0]} — {ws.taxYear}
                      </CardTitle>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {ws.entity.type === "business" ? "Business" : "Personal"}
                      </p>
                    </div>
                    <StatusBadge status={ws.status} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Deadline */}
                  {deadlineInfo && (
                    <div className={`flex items-center gap-2 text-sm ${deadlineInfo.overdue ? "text-destructive" : "text-muted-foreground"}`}>
                      <span className="text-xs font-medium">Deadline:</span>
                      <span className="text-xs">
                        {ws.deadline!.toLocaleDateString("en-US", {
                          month: "long",
                          day: "numeric",
                          year: "numeric",
                          timeZone: "America/New_York",
                        })}
                      </span>
                      <span className={`text-xs font-medium ${deadlineInfo.overdue ? "text-destructive" : "text-amber-600"}`}>
                        {deadlineInfo.label}
                      </span>
                    </div>
                  )}

                  {/* Progress bar */}
                  {ws.totalItems > 0 && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>Checklist</span>
                        <span>{ws.completedItems}/{ws.totalItems}</span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <Link
                    href={`/tax/${ws.id}` as Route}
                    className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-3 h-8 text-xs font-medium hover:bg-primary/90"
                  >
                    Open Workspace →
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>

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
  if (status === "filed") return <Badge variant="outline" className="border-green-300 text-green-700">Filed</Badge>;
  if (status === "waived") return <Badge variant="secondary">Waived</Badge>;
  return <Badge variant="secondary">Upcoming</Badge>;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "filed") return <Badge variant="outline" className="border-green-300 text-green-700">Filed</Badge>;
  if (status === "extended") return <Badge variant="destructive">Extended</Badge>;
  return <Badge variant="secondary">In Progress</Badge>;
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
