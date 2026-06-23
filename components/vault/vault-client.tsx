"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createVaultEntry, updateVaultEntry, deleteVaultEntry } from "@/actions/vault";
import type { VaultEntryDecrypted, VaultField } from "@/actions/vault";
import { Badge } from "@/components/ui/badge";

const CATEGORIES = [
  { value: "login", label: "Login" },
  { value: "account", label: "Bank Account" },
  { value: "card", label: "Card" },
  { value: "contact", label: "Contact" },
  { value: "other", label: "Other" },
] as const;

const CATEGORY_TEMPLATES: Record<string, VaultField[]> = {
  login: [
    { key: "URL", value: "" },
    { key: "Username", value: "" },
    { key: "Password", value: "" },
  ],
  account: [
    { key: "Account #", value: "" },
    { key: "Routing #", value: "" },
    { key: "Account type", value: "" },
  ],
  card: [
    { key: "Card number", value: "" },
    { key: "Expiry", value: "" },
    { key: "CVV", value: "" },
    { key: "PIN", value: "" },
  ],
  contact: [
    { key: "Name", value: "" },
    { key: "Phone", value: "" },
    { key: "Email", value: "" },
  ],
  other: [{ key: "Note", value: "" }],
};

type ModalMode = "add" | "edit";

interface ModalState {
  mode: ModalMode;
  entry?: VaultEntryDecrypted;
}

function groupByCategory(entries: VaultEntryDecrypted[]) {
  const groups: Record<string, VaultEntryDecrypted[]> = {};
  for (const e of entries) {
    (groups[e.category] ??= []).push(e);
  }
  return groups;
}

function categoryLabel(cat: string) {
  return CATEGORIES.find((c) => c.value === cat)?.label ?? cat;
}

interface EntryCardProps {
  entry: VaultEntryDecrypted;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}

function EntryCard({ entry, onEdit, onDelete, deleting }: EntryCardProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-sm">{entry.name}</p>
          {entry.institution && (
            <p className="text-xs text-muted-foreground">{entry.institution}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setRevealed(!revealed)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {revealed ? "Hide" : "View"}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="text-xs text-muted-foreground hover:text-primary"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>

      <dl className="grid gap-1.5">
        {entry.fields.map((f, i) => (
          <div key={i} className="grid grid-cols-[120px_1fr] gap-2 text-sm">
            <dt className="text-muted-foreground truncate">{f.key}</dt>
            <dd className="font-mono truncate">
              {revealed ? f.value || "—" : "••••••••"}
            </dd>
          </div>
        ))}
        {entry.notes && revealed && (
          <div className="pt-1 border-t text-xs text-muted-foreground">
            {entry.notes}
          </div>
        )}
      </dl>
    </div>
  );
}

interface EntryModalProps {
  mode: ModalMode;
  entry?: VaultEntryDecrypted;
  onClose: () => void;
}

function EntryModal({ mode, entry, onClose }: EntryModalProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(entry?.name ?? "");
  const [category, setCategory] = useState(entry?.category ?? "login");
  const [institution, setInstitution] = useState(entry?.institution ?? "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [fields, setFields] = useState<VaultField[]>(
    entry?.fields ?? CATEGORY_TEMPLATES["login"] ?? []
  );

  function onCategoryChange(cat: string) {
    setCategory(cat);
    if (!entry) {
      setFields(CATEGORY_TEMPLATES[cat] ?? [{ key: "", value: "" }]);
    }
  }

  function setField(index: number, partial: Partial<VaultField>) {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...partial } : f)));
  }

  function addField() {
    setFields((prev) => [...prev, { key: "", value: "" }]);
  }

  function removeField(index: number) {
    setFields((prev) => prev.filter((_, i) => i !== index));
  }

  function save() {
    if (!name.trim()) { setError("Name is required"); return; }
    setError(null);
    startTransition(async () => {
      try {
        if (mode === "add") {
          await createVaultEntry({ name: name.trim(), category, institution: institution || undefined, fields, notes: notes || undefined });
        } else {
          await updateVaultEntry(entry!.id, { name: name.trim(), category, institution: institution || null, fields, notes: notes || null });
        }
        router.refresh();
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed");
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg bg-background rounded-lg shadow-xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-semibold">{mode === "add" ? "New Entry" : "Edit Entry"}</h2>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none">×</button>
        </div>

        <div className="overflow-y-auto p-4 space-y-4 flex-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Chase Checking"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Category</label>
              <select
                value={category}
                onChange={(e) => onCategoryChange(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <label className="text-sm font-medium">Institution <span className="text-muted-foreground font-normal">optional</span></label>
              <input
                value={institution}
                onChange={(e) => setInstitution(e.target.value)}
                placeholder="e.g. Chase Bank"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Fields</label>
              <button type="button" onClick={addField} className="text-xs text-primary hover:underline">+ Add field</button>
            </div>
            {fields.map((f, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input
                  value={f.key}
                  onChange={(e) => setField(i, { key: e.target.value })}
                  placeholder="Label"
                  className="w-32 shrink-0 rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <input
                  value={f.value}
                  onChange={(e) => setField(i, { value: e.target.value })}
                  placeholder="Value"
                  className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  type="text"
                  autoComplete="off"
                />
                <button type="button" onClick={() => removeField(i)} className="text-muted-foreground hover:text-destructive text-xs shrink-0">×</button>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Notes <span className="text-muted-foreground font-normal">optional</span></label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t">
          <button type="button" onClick={onClose} className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 h-9 text-sm hover:bg-accent">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 h-9 text-sm font-medium hover:bg-primary/90 disabled:opacity-60"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface Props {
  initialEntries: VaultEntryDecrypted[];
}

export function VaultClient({ initialEntries }: Props) {
  const router = useRouter();
  const [modal, setModal] = useState<ModalState | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const groups = groupByCategory(initialEntries);
  const orderedCategories = CATEGORIES.map((c) => c.value).filter((c) => groups[c]);
  const otherCats = Object.keys(groups).filter((c) => !CATEGORIES.find((cc) => cc.value === c));

  function handleDelete(id: string) {
    setDeletingId(id);
    startTransition(async () => {
      try {
        await deleteVaultEntry(id);
        router.refresh();
      } finally {
        setDeletingId(null);
      }
    });
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Vault</h1>
            <p className="text-sm text-muted-foreground">Financial credentials and account details — end-to-end encrypted</p>
          </div>
          <button
            onClick={() => setModal({ mode: "add" })}
            className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 h-9 text-sm font-medium hover:bg-primary/90"
          >
            + New Entry
          </button>
        </div>

        {initialEntries.length === 0 && (
          <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
            No entries yet. Add your first login, account, or contact.
          </div>
        )}

        {[...orderedCategories, ...otherCats].map((cat) => {
          const catEntries = groups[cat] ?? [];
          return (
          <section key={cat}>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
              {categoryLabel(cat)}
              <Badge variant="secondary" className="text-xs font-normal">{catEntries.length}</Badge>
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {catEntries.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  onEdit={() => setModal({ mode: "edit", entry })}
                  onDelete={() => handleDelete(entry.id)}
                  deleting={deletingId === entry.id}
                />
              ))}
            </div>
          </section>
          );
        })}
      </div>

      {modal && (
        <EntryModal
          mode={modal.mode}
          entry={modal.entry}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}
