"use client";

import { useState, useEffect, useRef, useTransition, useMemo } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { updateTransactionTags } from "@/actions/transactions";
import { cn } from "@/lib/utils";

interface Tag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

interface Props {
  transactionId: string;
  allTags: Tag[];
  initialTagIds: string[];
}

export function InlineTagCell({ transactionId, allTags, initialTagIds }: Props) {
  const router = useRouter();
  const [tagIds, setTagIds] = useState(initialTagIds);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 });

  // Click-outside: check both the trigger container and the floating dropdown
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !containerRef.current?.contains(target) &&
        !dropdownRef.current?.contains(target)
      ) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { setOpen(false); setQuery(""); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function handleOpen() {
    if (open) { setOpen(false); setQuery(""); return; }
    // Compute fixed position from the + button
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      setDropPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen(true);
  }

  function save(newIds: string[]) {
    setTagIds(newIds);
    startTransition(async () => {
      await updateTransactionTags(transactionId, newIds);
      router.refresh();
    });
  }

  function toggle(tagId: string) {
    const next = tagIds.includes(tagId)
      ? tagIds.filter((id) => id !== tagId)
      : [...tagIds, tagId];
    save(next);
  }

  function removeTag(tagId: string, e: React.MouseEvent) {
    e.stopPropagation();
    save(tagIds.filter((id) => id !== tagId));
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return allTags.slice(0, 30);
    return allTags
      .filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.shortName.toLowerCase().includes(q)
      )
      .slice(0, 30);
  }, [allTags, query]);

  const selectedTags = useMemo(
    () => allTags.filter((t) => tagIds.includes(t.id)),
    [allTags, tagIds]
  );

  const dropdown = open ? (
    <div
      ref={dropdownRef}
      style={{ position: "fixed", top: dropPos.top, left: dropPos.left, zIndex: 9999 }}
      className="w-80 rounded-md border border-border bg-card shadow-2xl"
    >
      <div className="p-2 border-b border-border">
        <Input
          autoFocus
          placeholder="Search tags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 text-xs bg-background"
        />
      </div>
      <ul className="max-h-56 overflow-y-auto py-1">
        {filtered.map((tag) => {
          const isSelected = tagIds.includes(tag.id);
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
                  "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-accent gap-2",
                  isSelected && "font-medium text-primary"
                )}
              >
                <span className="leading-snug">{tag.name}</span>
                {isSelected && <span className="text-primary shrink-0">✓</span>}
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="px-3 py-2 text-xs text-muted-foreground">
            No tags found
          </li>
        )}
      </ul>
    </div>
  ) : null;

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative inline-flex flex-wrap items-center gap-1",
        isPending && "opacity-50 pointer-events-none"
      )}
    >
      {selectedTags.map((t) => (
        <Badge key={t.id} variant="secondary" className="text-xs pr-1 gap-0.5">
          {t.shortName}
          <button
            type="button"
            onClick={(e) => removeTag(t.id, e)}
            className="ml-0.5 text-muted-foreground hover:text-destructive leading-none"
          >
            ×
          </button>
        </Badge>
      ))}

      <button
        ref={buttonRef}
        type="button"
        onClick={handleOpen}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        title="Add tag"
      >
        +
      </button>

      {typeof document !== "undefined" && dropdown
        ? createPortal(dropdown, document.body)
        : null}
    </div>
  );
}
