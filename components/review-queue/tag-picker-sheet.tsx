"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { alnum, buildTagTree, flattenTagTree } from "@/lib/tags";
import type { CreateTagForQueueResult, QueueTag } from "@/actions/review-queue";

// Full-height bottom sheet for picking (or creating) a tag on a phone.
// Inputs are text-base (16px) so iOS Safari doesn't zoom on focus; rows are
// min-h-12 (48px) tap targets; the sheet uses dvh so the on-screen keyboard
// shrinks the list instead of hiding it.

interface Props {
  tags: QueueTag[];
  /** Tag ids already chosen in this list, most recent first: offered as one-tap quick picks. */
  recentTagIds: string[];
  currentTagId: string | null;
  payeeLabel: string;
  onSelect: (tagId: string) => void;
  onCreate: (input: { shortName: string; parentId?: string }) => Promise<CreateTagForQueueResult>;
  onClose: () => void;
}

function depthOf(name: string): number {
  return name.split(" / ").length - 1;
}

export function TagPickerSheet({
  tags,
  recentTagIds,
  currentTagId,
  payeeLabel,
  onSelect,
  onCreate,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, startCreate] = useTransition();

  // Lock background scroll and close on Escape while the sheet is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const ordered = useMemo(() => flattenTagTree(buildTagTree(tags)), [tags]);
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);

  const q = query.trim().toLowerCase();
  const qa = alnum(q);
  const filtered = q
    ? ordered.filter((t) => t.name.toLowerCase().includes(q) || (qa !== "" && alnum(t.name).includes(qa)))
    : ordered;

  const recents = q
    ? []
    : recentTagIds.map((id) => tagById.get(id)).filter((t): t is QueueTag => t !== undefined).slice(0, 5);

  function openCreate() {
    setCreating(true);
    setCreateError(null);
    if (newName === "" && query.trim() !== "") setNewName(query.trim());
  }

  function submitCreate() {
    const shortName = newName.trim();
    if (!shortName) {
      setCreateError("Enter a name for the new tag.");
      return;
    }
    setCreateError(null);
    startCreate(async () => {
      try {
        const result = await onCreate({
          shortName,
          ...(newParentId ? { parentId: newParentId } : {}),
        });
        if (!result.ok) {
          setCreateError(result.error);
          return;
        }
        onSelect(result.tag.id);
      } catch {
        setCreateError("Couldn't create that tag. Check your connection and try again.");
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close tag picker"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Choose a tag for ${payeeLabel}`}
        className="relative flex h-[88dvh] max-h-[88dvh] flex-col rounded-t-2xl bg-background shadow-xl"
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Choose a tag</h2>
            <p className="truncate text-sm text-muted-foreground">{payeeLabel}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 shrink-0 rounded-md px-3 text-base font-medium text-muted-foreground"
          >
            Close
          </button>
        </div>

        <div className="px-4 pb-2">
          <input
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            placeholder="Search tags"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-12 w-full rounded-lg border border-input bg-background px-3 text-base"
          />
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          {recents.length > 0 && (
            <div className="px-2 pb-2">
              <p className="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Used in this list
              </p>
              <div className="flex flex-wrap gap-2">
                {recents.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onSelect(t.id)}
                    className="min-h-11 rounded-full border border-input bg-muted/40 px-4 text-base"
                  >
                    {t.shortName}
                  </button>
                ))}
              </div>
            </div>
          )}

          <ul>
            {filtered.map((t) => {
              const selected = t.id === currentTagId;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(t.id)}
                    aria-label={t.name}
                    aria-pressed={selected}
                    style={q ? undefined : { paddingLeft: 12 + depthOf(t.name) * 18 }}
                    className={`flex min-h-12 w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-base ${
                      selected ? "bg-primary/10 font-medium" : "active:bg-muted"
                    }`}
                  >
                    <span className="min-w-0 break-words">{q ? t.name : t.shortName}</span>
                    {selected && <span aria-hidden="true">✓</span>}
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-3 py-6 text-center text-base text-muted-foreground">
                No tags match. Create a new one below.
              </li>
            )}
          </ul>
        </div>

        <div className="border-t bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {!creating ? (
            <button
              type="button"
              onClick={openCreate}
              className="min-h-12 w-full rounded-lg border border-dashed border-input text-base font-medium"
            >
              + Create new tag
            </button>
          ) : (
            <div className="space-y-2">
              <input
                type="text"
                autoComplete="off"
                placeholder="New tag name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={100}
                className="h-12 w-full rounded-lg border border-input bg-background px-3 text-base"
              />
              <select
                value={newParentId}
                onChange={(e) => setNewParentId(e.target.value)}
                aria-label="Parent tag (optional)"
                className="h-12 w-full rounded-lg border border-input bg-background px-3 text-base"
              >
                <option value="">No parent (top level)</option>
                {ordered.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {createError && (
                <p role="alert" className="text-sm text-destructive">
                  {createError}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  disabled={isCreating}
                  className="min-h-12 flex-1 rounded-lg border border-input text-base font-medium disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitCreate}
                  disabled={isCreating}
                  className="min-h-12 flex-1 rounded-lg bg-primary text-base font-medium text-primary-foreground disabled:opacity-50"
                >
                  {isCreating ? "Creating…" : "Create & use"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
