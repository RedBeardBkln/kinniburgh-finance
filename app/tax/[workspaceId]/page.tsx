import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getTaxWorkspace } from "@/actions/tax";
import { listDocuments } from "@/actions/documents";
import { TaxWorkspaceClient } from "@/components/tax/tax-workspace-client";
import { db } from "@/lib/db";
import Link from "next/link";
import type { Route } from "next";

interface PageProps {
  params: Promise<{ workspaceId: string }>;
}

export default async function TaxWorkspacePage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { workspaceId } = await params;

  let workspace;
  try {
    workspace = await getTaxWorkspace(workspaceId);
  } catch {
    redirect("/tax" as Route);
  }

  const [relatedDocs, entity] = await Promise.all([
    listDocuments({ entityId: workspace.entityId, taxYear: workspace.taxYear }),
    db.entity.findUnique({ where: { id: workspace.entityId } }),
  ]);

  const exportUrl = `/api/export/${workspace.entityId}?year=${workspace.taxYear}`;

  return (
    <AppShell userName={session.user.name ?? undefined}>
      <div className="space-y-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link href={"/tax" as Route} className="hover:underline">Tax Workspaces</Link>
            <span>/</span>
            <span>{entity?.name.split(",")[0]} {workspace.taxYear}</span>
          </div>
          <h1 className="text-2xl font-semibold">
            {entity?.name.split(",")[0]} — Tax Year {workspace.taxYear}
          </h1>
        </div>

        <TaxWorkspaceClient
          workspaceId={workspace.id}
          entityId={workspace.entityId}
          entityName={workspace.entity.name}
          taxYear={workspace.taxYear}
          initialStatus={workspace.status}
          initialDeadline={workspace.deadline?.toISOString() ?? null}
          initialNotes={workspace.notes}
          filedAt={workspace.filedAt?.toISOString() ?? null}
          checklistItems={workspace.checklistItems.map((i) => ({
            id: i.id,
            label: i.label,
            completed: i.completed,
            completedAt: i.completedAt?.toISOString() ?? null,
            dueDate: i.dueDate?.toISOString() ?? null,
          }))}
          relatedDocuments={relatedDocs.map((d) => ({
            id: d.id,
            docType: d.docType,
            notes: d.notes,
            taxYear: d.taxYear,
            createdAt: d.createdAt.toISOString(),
          }))}
          exportUrl={exportUrl}
        />
      </div>
    </AppShell>
  );
}
