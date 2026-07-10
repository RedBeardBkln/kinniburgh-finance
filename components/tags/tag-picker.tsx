"use client";

import { useState, useMemo, useTransition, useRef, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { createTag } from "@/actions/tags";

interface Tag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

interface TagPickerProps {
  tags: Tag[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
  maxSelected?: number;
  /** Called after a new tag is created so the parent can add it to its own list */
  onCreateTag?: (newTag: Tag) => void;
}

export function TagPicker({
  tags,
  selected,
  onChange,
  placeholder = "Search tags…",
  maxSelected,
  onCreateTag,
}: TagPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createParentId, setCreateParentId] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, startCreateTransition] = useTransition();
  const createNameRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Sync ref so the onBlur timeout can check createMode without stale closure
  const createModeRef = useRef(false);

  useEffect(() => {
    if (createMode) {
      const t = setTimeout(() => createNameRef.current?.focus(), 30);
      return () => clearTimeout(t);
    } else if (open) {
      // Re-entering list view — restore focus so onBlur-to-close still works
      const t = setTimeout(() => searchInputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [createMode, open]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return tags.slice(0, 20);
    return tags
      .filter(
        (t) =>
          t.name.toLowerCase().includes(q) || t.shortName.toLowerCase().includes(q)
      )
      .slice(0, 20);
  }, [tags, query]);

  const selectedTags = useMemo(
    () => tags.filter((t) => selected.includes(t.id)),
    [tags, selected]
  );

  function toggle(tagId: string) {
    if (selected.includes(tagId)) {
      onChange(selected.filter((id) => id !== tagId));
    } else {
      if (maxSelected && selected.length >= maxSelected) return;
      onChange([...selected, tagId]);
    }
  }

  function remove(tagId: string) {
    onChange(selected.filter((id) => id !== tagId));
  }

  function enterCreateMode() {
    createModeRef.current = true; // sync before setState so onBlur sees it
    setCreateName(query.trim());
    setCreateParentId("");
    setCreateError(null);
    setCreateMode(true);
  }

  const exitCreateMode = useCallback(() => {
    createModeRef.current = false;
    setCreateMode(false);
    setCreateName("");
    setCreateParentId("");
    setCreateError(null);
  }, []);

  function handleCreate() {
    if (!createName.trim()) { setCreateError("Name is required"); return; }
    setCreateError(null);
    startCreateTransition(async () => {
      try {
        const parent = createParentId ? tags.find((t) => t.id === createParentId) : null;
        const { id } = await createTag({
          shortName: createName.trim(),
          parentId: createParentId || undefined,
        });
        const fullName = parent
          ? `${parent.name} / ${createName.trim()}`
          : createName.trim();
        const newTag: Tag = {
          id,
          name: fullName,
          shortName: createName.trim(),
          parentId: createParentId || null,
        };
        exitCreateMode();
        setQuery("");
        setOpen(false);
        // Notify parent to add to its local list AND handle selection
        onCreateTag?.(newTag);
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : "Failed to create tag");
      }
    });
  }

  return (
    <div className="relative">
      {/* Selected badges */}
      {selectedTags.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {selectedTags.map((t) => (
            <Badge
              key={t.id}
              variant="secondary"
              className="cursor-pointer gap-1"
              onClick={() => remove(t.id)}
            >
              {t.shortName}
              <span className="text-muted-foreground">×</span>
            </Badge>
          ))}
        </div>
      )}

      <Input
        ref={searchInputRef}
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() =>
          setTimeout(() => {
            // Don't close if we just entered create mode — blur fires when the
            // Input unmounts during the transition and we must ignore it.
            if (!createModeRef.current) {
              setOpen(false);
            }
          }, 150)
        }
      />

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md">
          {!createMode ? (
            <>
              <ul className="max-h-52 overflow-auto py-1">
                {filtered.map((tag) => {
                  const isSelected = selected.includes(tag.id);
                  return (
                    <li key={tag.id}>
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          toggle(tag.id);
                          setQuery("");
                        }}
                        className={cn(
                          "flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent",
                          isSelected && "font-medium text-primary"
                        )}
                      >
                        <span className="truncate">{tag.name}</span>
                        {isSelected && <span className="ml-2 text-primary">✓</span>}
                      </button>
                    </li>
                  );
                })}
                {filtered.length === 0 && (
                  <li className="px-3 py-2 text-sm text-muted-foreground">
                    No tags found
                  </li>
                )}
              </ul>

              {onCreateTag && (
                <div className="border-t">
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      enterCreateMode();
                    }}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm text-primary hover:bg-accent"
                  >
                    <span className="text-base leading-none font-medium">+</span>
                    {query.trim() ? `Create "${query.trim()}"` : "Create new tag"}
                  </button>
                </div>
              )}
            </>
          ) : (
            /* ── Create mode ── */
            <div className="p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">New tag</span>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); exitCreateMode(); }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Name</label>
                <Input
                  ref={createNameRef}
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); handleCreate(); }
                    if (e.key === "Escape") { e.preventDefault(); exitCreateMode(); }
                  }}
                  placeholder="e.g. Groceries"
                  className="h-7 text-sm"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  Parent tag{" "}
                  <span className="opacity-60">(optional)</span>
                </label>
                <select
                  value={createParentId}
                  onChange={(e) => setCreateParentId(e.target.value)}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="w-full h-7 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">No parent</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>

              {createError && (
                <p className="text-xs text-destructive">{createError}</p>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); handleCreate(); }}
                  disabled={isCreating}
                  className="flex-1 h-7 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
                >
                  {isCreating ? "Creating…" : "Create & select"}
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); exitCreateMode(); }}
                  className="h-7 px-3 rounded-md border text-xs hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
