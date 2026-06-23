"use client";

import { useState, useEffect, useRef, useTransition, useMemo } from "react";
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

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
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
    if (!q) return allTags.slice(0, 20);
    return allTags
      .filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.shortName.toLowerCase().includes(q)
      )
      .slice(0, 20);
  }, [allTags, query]);

  const selectedTags = useMemo(
    () => allTags.filter((t) => tagIds.includes(t.id)),
    [allTags, tagIds]
  );

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
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        title="Add tag"
      >
        +
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-60 rounded-md border bg-popover shadow-lg">
          <div className="p-2 border-b">
            <Input
              autoFocus
              placeholder="Search tags…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-7 text-xs"
            />
          </div>
          <ul className="max-h-48 overflow-y-auto py-1">
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
                      "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-accent",
                      isSelected && "font-medium text-primary"
                    )}
                  >
                    <span className="truncate">{tag.name}</span>
                    {isSelected && <span className="text-primary">✓</span>}
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
      )}
    </div>
  );
}
