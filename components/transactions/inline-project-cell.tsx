"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTransactionProject } from "@/actions/transactions";
import { cn } from "@/lib/utils";
import { MODAL_OVERLAY, modalPanelClass } from "@/components/ui/modal-frame";

interface Project {
  id: string;
  name: string;
  status?: string;
}

interface Props {
  transactionId: string;
  projects: Project[];
  initialProjectId: string | null;
}

function projectLabel(p: Project): string {
  return p.status === "completed" ? `${p.name} (completed)` : p.name;
}

export function InlineProjectCell({ transactionId, projects, initialProjectId }: Props) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [isPending, startTransition] = useTransition();
  // Phones: the project is a small link that opens this picker (most rows have no project, so it stays out of the way).
  const [pickerOpen, setPickerOpen] = useState(false);

  function save(next: string) {
    setProjectId(next);
    startTransition(async () => {
      await updateTransactionProject(transactionId, next || null);
      router.refresh();
    });
  }

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    save(e.target.value);
  }

  function pick(next: string) {
    setPickerOpen(false);
    if (next !== projectId) save(next);
  }

  // A completed project is not offered for new links, but the row already linked to it keeps showing it.
  const options = projects.filter((p) => p.status !== "completed" || p.id === projectId);
  if (options.length === 0) return null;
  const current = options.find((p) => p.id === projectId);

  return (
    <>
      <select
        value={projectId}
        onChange={handleChange}
        disabled={isPending}
        className={`w-full min-w-0 max-w-full truncate rounded border border-input bg-background px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring max-md:hidden ${isPending ? "opacity-50" : ""}`}
        title="Assign to project"
      >
        <option value="">No project</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>{projectLabel(p)}</option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        disabled={isPending}
        className={cn(
          "max-w-full truncate text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50 md:hidden",
          current && "text-foreground"
        )}
      >
        {current ? `Project: ${current.name}` : "Assign project"}
      </button>

      {pickerOpen && (
        <div
          className={MODAL_OVERLAY}
          onClick={(e) => {
            if (e.target === e.currentTarget) setPickerOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Assign to project"
            className={cn(modalPanelClass("sm"), "border bg-card p-4 text-left shadow-xl")}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-sm font-medium">Assign to project</p>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="shrink-0 text-xl leading-none text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <ul className="space-y-1">
              {[{ id: "", label: "No project" }, ...options.map((p) => ({ id: p.id, label: projectLabel(p) }))].map(
                (o) => (
                  <li key={o.id || "none"}>
                    <button
                      type="button"
                      onClick={() => pick(o.id)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2.5 text-left text-sm hover:bg-accent",
                        o.id === projectId && "bg-primary/10 font-medium text-primary"
                      )}
                    >
                      <span className="min-w-0 truncate">{o.label}</span>
                      {o.id === projectId && <span className="shrink-0">✓</span>}
                    </button>
                  </li>
                )
              )}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
