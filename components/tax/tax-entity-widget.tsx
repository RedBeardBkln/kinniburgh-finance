"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ensureTaxWorkspace } from "@/actions/tax";
import type { Route } from "next";

export interface TaxWidgetData {
  entityId: string;
  entityName: string;
  entityShortName: string;
  entityType: string;
  taxYear: number;
  workspaceId: string | null;
  status: string | null;
  deadline: string | null;
  totalIncome: string | null;
  totalExpenses: string | null;
  documentCount: number;
  completedItems: number;
  totalItems: number;
  plUrl: string | null;
  balanceSheetUrl: string | null;
  workspaceHref: string | null;
}

function fmtUSD(value: string | null): string {
  if (value === null) return "—";
  const n = Number(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function StatusBadge({ status }: { status: string | null }) {
  if (status === "filed") {
    return <span className="rounded-full border border-green-300 px-2 py-0.5 text-xs text-green-700">Filed</span>;
  }
  if (status === "extended") {
    return <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">Extended</span>;
  }
  return <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">In Progress</span>;
}

export function TaxEntityWidget({ data }: { data: TaxWidgetData }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const progress =
    data.totalItems > 0 ? (data.completedItems / data.totalItems) * 100 : 0;

  function handleCreate() {
    const fd = new FormData();
    fd.set("entityId", data.entityId);
    fd.set("taxYear", String(data.taxYear));
    startTransition(async () => {
      await ensureTaxWorkspace(fd);
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border bg-card flex flex-col">
      <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div>
          <p className="text-sm font-semibold">{data.entityShortName}</p>
          <p className="text-xs text-muted-foreground">
            {data.entityType === "business" ? "Business" : "Personal"}
          </p>
        </div>
        {data.workspaceId && <StatusBadge status={data.status} />}
      </div>

      <div className="space-y-3 px-4 py-3 flex-1">
        {/* Financial snapshot from entity data */}
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Income</p>
            <p className="font-medium text-green-600">{fmtUSD(data.totalIncome)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Expenses</p>
            <p className="font-medium text-destructive">{fmtUSD(data.totalExpenses)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Documents</p>
            <p className="font-medium">{data.documentCount}</p>
          </div>
        </div>

        {/* Deadline */}
        {data.deadline && (
          <p className="text-xs text-muted-foreground">
            Deadline:{" "}
            {new Date(data.deadline).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
              timeZone: "America/New_York",
            })}
          </p>
        )}

        {/* Checklist progress */}
        {data.totalItems > 0 && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Checklist</span>
              <span>
                {data.completedItems}/{data.totalItems}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Forms & documents */}
        {data.workspaceId && (
          <div className="space-y-1 border-t pt-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
              Forms &amp; Documents
            </p>
            <div className="flex flex-col gap-1 text-sm">
              {data.plUrl ? (
                <a href={data.plUrl} download className="text-primary hover:underline">
                  P&amp;L Report (CSV) →
                </a>
              ) : (
                <span className="text-muted-foreground">P&amp;L — no GL-coded data</span>
              )}
              {data.balanceSheetUrl && (
                <a href={data.balanceSheetUrl} download className="text-primary hover:underline">
                  Balance Sheet (CSV) →
                </a>
              )}
              <a
                href={`/documents?entityId=${data.entityId}&year=${data.taxYear}` as Route}
                className="text-primary hover:underline"
              >
                Tax documents ({data.documentCount}) →
              </a>
            </div>
          </div>
        )}
      </div>

      <div className="border-t px-4 py-3">
        {data.workspaceId && data.workspaceHref ? (
          <a
            href={data.workspaceHref}
            className="inline-flex w-full items-center justify-center rounded-md bg-primary text-primary-foreground px-3 h-8 text-xs font-medium hover:bg-primary/90"
          >
            Open Workspace →
          </a>
        ) : (
          <button
            onClick={handleCreate}
            disabled={isPending}
            className="inline-flex w-full items-center justify-center rounded-md border border-input bg-background px-3 h-8 text-xs font-medium hover:bg-accent disabled:opacity-60"
          >
            {isPending ? "Creating…" : "Create Workspace"}
          </button>
        )}
      </div>
    </div>
  );
}