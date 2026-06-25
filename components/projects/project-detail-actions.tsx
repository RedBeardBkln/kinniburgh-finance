"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateProject, archiveProject } from "@/actions/projects";

interface Project {
  id: string;
  name: string;
  status: string;
  budget: { toString: () => string };
  description: string | null;
  targetDate: Date | null;
}

interface Props {
  project: Project;
}

export function ProjectDetailActions({ project }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [budget, setBudget] = useState(project.budget.toString());
  const [targetDate, setTargetDate] = useState(
    project.targetDate ? new Date(project.targetDate).toISOString().split("T")[0] : ""
  );
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    if (!name.trim()) { setError("Name is required"); return; }
    if (!budget || parseFloat(budget) <= 0) { setError("Budget must be positive"); return; }
    setError(null);
    startTransition(async () => {
      try {
        await updateProject(project.id, {
          name: name.trim(),
          description: description.trim() || undefined,
          budget: parseFloat(budget),
          targetDate: targetDate || null,
        });
        setEditing(false);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save");
      }
    });
  }

  function handleStatusChange(status: string) {
    startTransition(async () => {
      await updateProject(project.id, { status });
      router.refresh();
    });
  }

  function handleArchive() {
    if (!confirm(`Archive "${project.name}"? This will remove it from the projects list.`)) return;
    startTransition(async () => {
      await archiveProject(project.id);
      router.push("/projects");
    });
  }

  if (editing) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-md rounded-lg border bg-card p-5 space-y-3">
          <h3 className="font-semibold">Edit project</h3>
          <div className="space-y-1">
            <label className="text-sm font-medium">Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Budget ($)</label>
            <input type="number" step="0.01" min="0" value={budget} onChange={(e) => setBudget(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Target date</label>
            <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Description</label>
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <button onClick={handleSave} disabled={isPending}
              className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {isPending ? "Saving…" : "Save"}
            </button>
            <button onClick={() => setEditing(false)} className="text-sm text-muted-foreground hover:underline">
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      <button onClick={() => setEditing(true)}
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
        Edit
      </button>
      {project.status === "active" && (
        <button onClick={() => handleStatusChange("paused")} disabled={isPending}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent text-muted-foreground">
          Pause
        </button>
      )}
      {project.status === "paused" && (
        <button onClick={() => handleStatusChange("active")} disabled={isPending}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
          Resume
        </button>
      )}
      {project.status !== "completed" && (
        <button onClick={() => handleStatusChange("completed")} disabled={isPending}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent text-muted-foreground">
          Complete
        </button>
      )}
      <button onClick={handleArchive} disabled={isPending}
        className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent text-destructive">
        Archive
      </button>
    </div>
  );
}
