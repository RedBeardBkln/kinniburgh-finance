"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateTransactionProject } from "@/actions/transactions";

interface Project {
  id: string;
  name: string;
}

interface Props {
  transactionId: string;
  projects: Project[];
  initialProjectId: string | null;
}

export function InlineProjectCell({ transactionId, projects, initialProjectId }: Props) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [isPending, startTransition] = useTransition();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    setProjectId(next);
    startTransition(async () => {
      await updateTransactionProject(transactionId, next || null);
      router.refresh();
    });
  }

  if (projects.length === 0) return null;

  return (
    <select
      value={projectId}
      onChange={handleChange}
      disabled={isPending}
      className={`rounded border border-input bg-background px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring ${isPending ? "opacity-50" : ""}`}
      title="Assign to project"
    >
      <option value="">No project</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  );
}
