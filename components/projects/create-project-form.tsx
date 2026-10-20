"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createProject } from "@/actions/projects";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MODAL_OVERLAY, modalPanelClass } from "@/components/ui/modal-frame";

interface EntityOption {
  id: string;
  name: string;
  navLabel: string | null;
}

export interface AccountOption {
  id: string;
  nickname: string;
  mask: string | null;
}

interface Props {
  entities: EntityOption[];
  accounts: AccountOption[];
}

export function CreateProjectForm({ entities, accounts }: Props) {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [entityId, setEntityId] = useState(entities[0]?.id ?? "");
  const [budget, setBudget] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleCreate() {
    if (!name.trim()) { setError("Name is required"); return; }
    if (!budget || parseFloat(budget) <= 0) { setError("Budget must be a positive amount"); return; }
    if (!accountId) { setError("Choose the account this project is paid from"); return; }
    setError(null);
    startTransition(async () => {
      try {
        await createProject({
          name: name.trim(),
          description: description.trim() || undefined,
          entityId: entityId || undefined,
          budget: parseFloat(budget),
          targetDate: targetDate || undefined,
          accountId,
        });
        setShow(false);
        setName(""); setDescription(""); setBudget(""); setTargetDate(""); setAccountId("");
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
        className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 shrink-0"
      >
        + New project
      </button>
    );
  }

  return (
    <div className={cn(MODAL_OVERLAY, "bg-black/40")}>
      <Card className={cn(modalPanelClass("lg"), "max-sm:rounded-b-none")}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">New project</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2 space-y-1">
              <label className="text-sm font-medium">
                Name <span className="text-xs text-muted-foreground font-normal">required</span>
              </label>
              <input
                type="text" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Bathroom renovation"
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">
                Master budget ($) <span className="text-xs text-muted-foreground font-normal">required</span>
              </label>
              <input
                type="number" step="0.01" min="0" value={budget} onChange={(e) => setBudget(e.target.value)}
                placeholder="10000"
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">
                Master entity <span className="text-xs text-muted-foreground font-normal">required</span>
              </label>
              <select
                value={entityId} onChange={(e) => setEntityId(e.target.value)}
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>{e.navLabel ?? e.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">
                Paid from account <span className="text-xs text-muted-foreground font-normal">required</span>
              </label>
              <select
                value={accountId} onChange={(e) => setAccountId(e.target.value)}
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Choose an account…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.nickname}{a.mask ? ` ···${a.mask}` : ""}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">
                Target date <span className="text-xs text-muted-foreground font-normal">optional</span>
              </label>
              <input
                type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)}
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <p className="sm:col-span-2 text-xs text-muted-foreground">
              With a target date, the forecast takes what is left of the budget out of this account on that date. Leave the date
              blank for an ongoing project: it is not counted as a one-time expense.
            </p>
            <div className="space-y-1">
              <label className="text-sm font-medium">
                Description <span className="text-xs text-muted-foreground font-normal">optional</span>
              </label>
              <input
                type="text" value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="Notes about this project"
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              onClick={handleCreate} disabled={isPending}
              className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {isPending ? "Creating…" : "Create project"}
            </button>
            <button onClick={() => setShow(false)} className="text-sm text-muted-foreground hover:underline">
              Cancel
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
