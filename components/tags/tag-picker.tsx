"use client";

import { useState, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Tag {
  id: string;
  name: string;
  shortName: string;
  parentId: string | null;
}

interface TagPickerProps {
  tags: Tag[];
  selected: string[]; // array of tag ids
  onChange: (selected: string[]) => void;
  placeholder?: string;
  maxSelected?: number;
}

export function TagPicker({
  tags,
  selected,
  onChange,
  placeholder = "Search tags…",
  maxSelected,
}: TagPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return tags.slice(0, 20);
    return tags.filter(
      (t) =>
        t.name.toLowerCase().includes(q) || t.shortName.toLowerCase().includes(q)
    ).slice(0, 20);
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
        placeholder={placeholder}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />

      {open && filtered.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover shadow-md">
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
        </ul>
      )}
    </div>
  );
}
