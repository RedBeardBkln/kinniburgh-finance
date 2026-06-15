"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { updateProject, archiveProject } from "@/actions/projects";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  targetAmount: { toNumber: () => number };
  savedAmount: { toNumber: () => number };
  targetDate: Date | null;
  status: string;
}

interface Props {
  project: ProjectRow;
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-green-50 text-green-700 border-green-200",
  completed: "bg-blue-50 text-blue-700 border-blue-200",
  paused: "bg-amber-50 text-amber-700 border-amber-200",
};

export function ProjectCard({ project }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [depositAmount, setDepositAmount] = useState("");
  const [showDeposit, setShowDeposit] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = project.targetAmount.toNumber();
  const saved = project.savedAmount.toNumber();
  const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;

  function handleDeposit() {
    const amount = parseFloat(depositAmount);
    if (!amount || amount <= 0) { setError("Enter a positive amount"); return; }
    setError(null);
    startTransition(async () => {
      try {
        await updateProject(project.id, { savedAmount: saved + amount });
        setDepositAmount(""); setShowDeposit(false);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update");
      }
    });
  }

  function handleComplete() {
    startTransition(async () => {
      await updateProject(project.id, { status: "completed" });
      router.refresh();
    });
  }

  function handleArchive() {
    if (!confirm(`Archive "${project.name}"? This cannot be undone.`)) return;
    startTransition(async () => {
      await archiveProject(project.id);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardContent className="pt-5 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-semibold">{project.name}</p>
            {project.description && (
              <p className="text-xs text-muted-foreground mt-0.5">{project.description}</p>
            )}
          </div>
          <span className={`shrink-0 rounded border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[project.status] ?? STATUS_BADGE.active}`}>
            {project.status}
          </span>
        </div>

        {/* Progress bar */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-muted-foreground">
              ${saved.toLocaleString("en-US", { maximumFractionDigits: 0 })} saved
            </span>
            <span className="font-medium">{pct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs mt-1">
            <span className="text-muted-foreground">
              Goal: ${target.toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </span>
            {project.targetDate && (
              <span className="text-muted-foreground">
                by {new Date(project.targetDate).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
              </span>
            )}
          </div>
        </div>

        {/* Actions */}
        {project.status === "active" && (
          <div className="space-y-2">
            {showDeposit ? (
              <div className="flex items-center gap-2">
                <input
                  type="number" step="0.01" min="0" value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="Amount to add ($)"
                  className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                />
                <button onClick={handleDeposit} disabled={isPending}
                  className="inline-flex rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                  Add
                </button>
                <button onClick={() => setShowDeposit(false)} className="text-xs text-muted-foreground hover:underline">Cancel</button>
              </div>
            ) : (
              <div className="flex gap-2">
                <button onClick={() => setShowDeposit(true)}
                  className="text-xs text-primary hover:underline">
                  Add funds
                </button>
                <span className="text-xs text-muted-foreground">·</span>
                <button onClick={handleComplete} disabled={isPending}
                  className="text-xs text-muted-foreground hover:text-foreground">
                  Mark complete
                </button>
                <span className="text-xs text-muted-foreground">·</span>
                <button onClick={handleArchive} disabled={isPending}
                  className="text-xs text-muted-foreground hover:text-destructive">
                  Archive
                </button>
              </div>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
