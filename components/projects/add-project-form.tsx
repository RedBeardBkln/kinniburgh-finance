"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createProject } from "@/actions/projects";

interface Props {
  slushFundsAccountId?: string;
}

export function AddProjectForm({ slushFundsAccountId }: Props) {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleCreate() {
    if (!name.trim()) { setError("Name is required"); return; }
    if (!targetAmount || parseFloat(targetAmount) <= 0) { setError("Target amount must be positive"); return; }
    setError(null);
    startTransition(async () => {
      try {
        await createProject({
          name: name.trim(),
          description: description.trim() || undefined,
          targetAmount: parseFloat(targetAmount),
          targetDate: targetDate || undefined,
          accountId: slushFundsAccountId,
        });
        setShow(false);
        setName(""); setDescription(""); setTargetAmount(""); setTargetDate("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to create project");
      }
    });
  }

  if (!show) {
    return (
      <button
        onClick={() => setShow(true)}
        className="inline-flex items-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
      >
        + New project
      </button>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">New project</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-sm font-medium">Name <span className="text-xs text-muted-foreground font-normal">required</span></label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Bathroom renovation"
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Target amount ($) <span className="text-xs text-muted-foreground font-normal">required</span></label>
            <input type="number" step="0.01" min="0" value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} placeholder="5000"
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Target date <span className="text-xs text-muted-foreground font-normal">optional</span></label>
            <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Description <span className="text-xs text-muted-foreground font-normal">optional</span></label>
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Notes about this project"
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <button onClick={handleCreate} disabled={isPending}
            className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {isPending ? "Creating…" : "Create project"}
          </button>
          <button onClick={() => setShow(false)} className="text-sm text-muted-foreground hover:underline">Cancel</button>
        </div>
      </CardContent>
    </Card>
  );
}
