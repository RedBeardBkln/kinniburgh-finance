"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  updateWorkspace,
  toggleChecklistItem,
  addChecklistItem,
  removeChecklistItem,
} from "@/actions/tax";

interface ChecklistItem {
  id: string;
  label: string;
  completed: boolean;
  completedAt: string | null;
  dueDate: string | null;
}

interface Document {
  id: string;
  docType: string;
  notes: string | null;
  taxYear: number | null;
  createdAt: string;
}

interface Props {
  workspaceId: string;
  entityId: string;
  entityName: string;
  taxYear: number;
  initialStatus: string;
  initialDeadline: string | null;
  initialNotes: string | null;
  filedAt: string | null;
  checklistItems: ChecklistItem[];
  relatedDocuments: Document[];
  exportUrl: string;
}

const STATUS_OPTIONS = [
  { value: "in_progress", label: "In Progress" },
  { value: "extended", label: "Extended" },
  { value: "filed", label: "Filed" },
] as const;

const DOC_TYPE_LABELS: Record<string, string> = {
  w2: "W-2", "1099": "1099", k1: "K-1", extension: "Extension",
  property_tax: "Property Tax", mortgage_interest: "Mortgage Interest (1098)",
  policy: "Policy", statement: "Statement", other: "Other",
};

export function TaxWorkspaceClient({
  workspaceId,
  entityName,
  taxYear,
  initialStatus,
  initialDeadline,
  initialNotes,
  filedAt,
  checklistItems: initialItems,
  relatedDocuments,
  exportUrl,
}: Props) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [deadline, setDeadline] = useState(
    initialDeadline ? initialDeadline.split("T")[0] : ""
  );
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [items, setItems] = useState(initialItems);
  const [newItemLabel, setNewItemLabel] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const [isSaving, startSave] = useTransition();
  const [isToggling, startToggle] = useTransition();
  const [isAdding, startAdd] = useTransition();
  const [isRemoving, startRemove] = useTransition();

  function handleSave() {
    startSave(async () => {
      try {
        await updateWorkspace(workspaceId, {
          status,
          deadline: deadline || null,
          notes: notes || null,
        });
        setSaveError(null);
        router.refresh();
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  function handleToggle(itemId: string, completed: boolean) {
    startToggle(async () => {
      await toggleChecklistItem(itemId, completed);
      setItems((prev) =>
        prev.map((i) => (i.id === itemId ? { ...i, completed, completedAt: completed ? new Date().toISOString() : null } : i))
      );
    });
  }

  function handleAdd() {
    if (!newItemLabel.trim()) return;
    startAdd(async () => {
      await addChecklistItem(workspaceId, newItemLabel.trim());
      setItems((prev) => [
        ...prev,
        { id: crypto.randomUUID(), label: newItemLabel.trim(), completed: false, completedAt: null, dueDate: null },
      ]);
      setNewItemLabel("");
    });
  }

  function handleRemove(itemId: string) {
    startRemove(async () => {
      await removeChecklistItem(itemId);
      setItems((prev) => prev.filter((i) => i.id !== itemId));
    });
  }

  const completedCount = items.filter((i) => i.completed).length;
  const progress = items.length > 0 ? (completedCount / items.length) * 100 : 0;

  return (
    <div className="space-y-6">
      {/* Header controls */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {entityName.split(",")[0]} — Tax Year {taxYear}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">
                Filing deadline
                <span className="ml-1 text-xs text-muted-foreground font-normal">(confirm with CPA)</span>
              </label>
              <input
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>

            {filedAt && (
              <div className="space-y-1">
                <label className="text-sm font-medium">Filed on</label>
                <p className="text-sm text-muted-foreground py-2">
                  {new Date(filedAt).toLocaleDateString("en-US", { timeZone: "America/New_York" })}
                </p>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none"
              placeholder="CPA contact, notes on deductions, etc."
            />
          </div>

          {saveError && <p className="text-sm text-destructive">{saveError}</p>}

          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 h-9 text-sm font-medium hover:bg-primary/90 disabled:opacity-60"
            >
              {isSaving ? "Saving…" : "Save Changes"}
            </button>
            <a
              href={exportUrl}
              className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 h-9 text-sm font-medium hover:bg-accent"
              download
            >
              Export CPA Bundle (CSV)
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Checklist */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Checklist</CardTitle>
            <span className="text-xs text-muted-foreground">{completedCount}/{items.length} complete</span>
          </div>
          {items.length > 0 && (
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden mt-2">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-1">
          {items.map((item) => (
            <div key={item.id} className="flex items-start gap-3 rounded-md py-1.5 hover:bg-muted/30 px-2 group">
              <input
                type="checkbox"
                checked={item.completed}
                onChange={(e) => handleToggle(item.id, e.target.checked)}
                disabled={isToggling}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 cursor-pointer"
              />
              <span className={`flex-1 text-sm ${item.completed ? "line-through text-muted-foreground" : ""}`}>
                {item.label}
              </span>
              <button
                onClick={() => handleRemove(item.id)}
                disabled={isRemoving}
                className="opacity-0 group-hover:opacity-100 text-xs text-muted-foreground hover:text-destructive transition-opacity"
              >
                ×
              </button>
            </div>
          ))}

          {/* Add item */}
          <div className="flex gap-2 mt-3 pt-3 border-t">
            <Input
              value={newItemLabel}
              onChange={(e) => setNewItemLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              placeholder="Add checklist item…"
              className="h-8 text-sm"
            />
            <button
              onClick={handleAdd}
              disabled={isAdding || !newItemLabel.trim()}
              className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-3 h-8 text-xs font-medium hover:bg-primary/90 disabled:opacity-60 shrink-0"
            >
              Add
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Related documents */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Related Documents</CardTitle>
            <a href="/documents" className="text-xs text-primary hover:underline">Upload document →</a>
          </div>
        </CardHeader>
        <CardContent>
          {relatedDocuments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No documents for this entity and tax year.{" "}
              <a href="/documents" className="text-primary hover:underline">Upload one →</a>
            </p>
          ) : (
            <div className="space-y-1">
              {relatedDocuments.map((doc) => (
                <div key={doc.id} className="flex items-center justify-between py-1 text-sm">
                  <span className="font-medium text-xs px-1.5 py-0.5 rounded bg-muted">
                    {DOC_TYPE_LABELS[doc.docType] ?? doc.docType}
                  </span>
                  <span className="flex-1 mx-3 text-muted-foreground truncate">
                    {doc.notes ?? "—"}
                  </span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(doc.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
