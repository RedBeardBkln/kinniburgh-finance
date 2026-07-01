"use client";

import { useState, useTransition } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { createTag, updateTag, deleteTag, type TagWithCounts } from "@/actions/tags";

interface Props {
  initialTags: TagWithCounts[];
}

interface EditState {
  id: string;
  shortName: string;
  parentId: string | null;
}

function depthOf(name: string): number {
  return (name.match(/\//g) ?? []).length;
}

export function TagsClient({ initialTags }: Props) {
  const [tags, setTags] = useState(initialTags);
  const [showNew, setShowNew] = useState(false);
  const [newShortName, setNewShortName] = useState("");
  const [newParentId, setNewParentId] = useState("");
  const [editing, setEditing] = useState<EditState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Tags eligible to be a parent: cannot be the tag being edited or its descendants
  function eligibleParents(excludeId?: string): TagWithCounts[] {
    if (!excludeId) return tags;
    const excluded = new Set<string>();
    function markDescendants(id: string) {
      excluded.add(id);
      tags.filter((t) => t.parentId === id).forEach((t) => markDescendants(t.id));
    }
    markDescendants(excludeId);
    return tags.filter((t) => !excluded.has(t.id));
  }

  function handleCreate() {
    if (!newShortName.trim()) { setError("Name is required"); return; }
    setError(null);
    startTransition(async () => {
      try {
        const result = await createTag({
          shortName: newShortName.trim(),
          parentId: newParentId || undefined,
        });
        const parent = tags.find((t) => t.id === newParentId);
        const fullName = parent
          ? `${parent.name} / ${newShortName.trim()}`
          : newShortName.trim();
        setTags((prev) =>
          [...prev, {
            id: result.id,
            name: fullName,
            shortName: newShortName.trim(),
            parentId: newParentId || null,
            txCount: 0,
            ruleCount: 0,
            childCount: 0,
          }].sort((a, b) => a.name.localeCompare(b.name))
        );
        // Increment parent's childCount optimistically
        if (newParentId) {
          setTags((prev) =>
            prev.map((t) =>
              t.id === newParentId ? { ...t, childCount: t.childCount + 1 } : t
            )
          );
        }
        setNewShortName("");
        setNewParentId("");
        setShowNew(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Create failed");
      }
    });
  }

  function handleSaveEdit() {
    if (!editing) return;
    if (!editing.shortName.trim()) { setError("Name is required"); return; }
    setError(null);
    startTransition(async () => {
      try {
        await updateTag(editing.id, {
          shortName: editing.shortName.trim(),
          parentId: editing.parentId,
        });
        const parent = tags.find((t) => t.id === editing.parentId);
        const newFullName = parent
          ? `${parent.name} / ${editing.shortName.trim()}`
          : editing.shortName.trim();
        const oldTag = tags.find((t) => t.id === editing.id)!;
        // Update this tag and fix names of any descendant tags
        setTags((prev) =>
          prev.map((t) => {
            if (t.id === editing.id) {
              return { ...t, name: newFullName, shortName: editing.shortName.trim(), parentId: editing.parentId };
            }
            // Fix descendant names
            if (t.name.startsWith(oldTag.name + " / ")) {
              return { ...t, name: t.name.replace(oldTag.name, newFullName) };
            }
            return t;
          }).sort((a, b) => a.name.localeCompare(b.name))
        );
        setEditing(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  function handleDelete(tag: TagWithCounts) {
    if (tag.childCount > 0) {
      setError(`"${tag.shortName}" has ${tag.childCount} child tag${tag.childCount !== 1 ? "s" : ""} — delete them first.`);
      return;
    }
    if (tag.txCount > 0 || tag.ruleCount > 0) {
      setError(
        `"${tag.shortName}" is used by ${tag.txCount} transaction${tag.txCount !== 1 ? "s" : ""} and ${tag.ruleCount} rule${tag.ruleCount !== 1 ? "s" : ""}.`
      );
      return;
    }
    if (!confirm(`Delete tag "${tag.name}"? This cannot be undone.`)) return;
    startTransition(async () => {
      try {
        await deleteTag(tag.id);
        setTags((prev) => {
          const updated = prev.filter((t) => t.id !== tag.id);
          // Decrement parent's childCount
          return tag.parentId
            ? updated.map((t) =>
                t.id === tag.parentId ? { ...t, childCount: Math.max(0, t.childCount - 1) } : t
              )
            : updated;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Delete failed");
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => { setShowNew(!showNew); setError(null); }}
          variant={showNew ? "outline" : "default"}
        >
          {showNew ? "Cancel" : "+ New Tag"}
        </Button>
      </div>

      {showNew && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-sm font-medium">Tag name</label>
                <Input
                  autoFocus
                  value={newShortName}
                  onChange={(e) => setNewShortName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  placeholder="e.g. Groceries"
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">
                  Parent <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <select
                  value={newParentId}
                  onChange={(e) => setNewParentId(e.target.value)}
                  className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">— Root (no parent)</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button size="sm" onClick={handleCreate} disabled={isPending}>
              {isPending ? "Creating…" : "Create Tag"}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Transactions</th>
                <th className="px-4 py-3 font-medium">Rules</th>
                <th className="px-4 py-3 font-medium">Children</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {tags.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No tags yet. Create one above.
                  </td>
                </tr>
              )}
              {tags.map((tag) => {
                const depth = depthOf(tag.name);
                const isEditing = editing?.id === tag.id;

                return (
                  <tr key={tag.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-4 py-2.5">
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <div
                            className="shrink-0"
                            style={{ width: `${depth * 16}px` }}
                          />
                          <Input
                            autoFocus
                            value={editing.shortName}
                            onChange={(e) =>
                              setEditing({ ...editing, shortName: e.target.value })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSaveEdit();
                              if (e.key === "Escape") setEditing(null);
                            }}
                            className="h-7 text-sm w-40"
                          />
                          <span className="text-xs text-muted-foreground">under:</span>
                          <select
                            value={editing.parentId ?? ""}
                            onChange={(e) =>
                              setEditing({ ...editing, parentId: e.target.value || null })
                            }
                            className="rounded border border-input bg-background px-2 py-1 text-xs"
                          >
                            <option value="">— Root</option>
                            {eligibleParents(editing.id).map((t) => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <div className="flex items-center">
                          <div
                            className="shrink-0 border-l border-dashed border-muted-foreground/30 mr-2"
                            style={{
                              width: `${depth * 16}px`,
                              height: depth > 0 ? "1px" : undefined,
                              display: depth > 0 ? "flex" : "none",
                            }}
                          />
                          {depth > 0 && (
                            <span className="mr-2 text-muted-foreground/40 text-xs select-none">└</span>
                          )}
                          <span className="font-medium">{tag.shortName}</span>
                          {depth === 0 && tag.childCount > 0 && (
                            <span className="ml-2 text-xs text-muted-foreground">{tag.name}</span>
                          )}
                          {depth > 0 && (
                            <span className="ml-2 text-xs text-muted-foreground font-mono">{tag.name}</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {tag.txCount > 0 ? (
                        <Badge variant="secondary">{tag.txCount}</Badge>
                      ) : (
                        <span className="text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {tag.ruleCount > 0 ? (
                        <Badge variant="outline">{tag.ruleCount}</Badge>
                      ) : (
                        <span className="text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground text-xs">
                      {tag.childCount > 0 ? tag.childCount : "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      {isEditing ? (
                        <div className="flex gap-2">
                          <button
                            onClick={handleSaveEdit}
                            disabled={isPending}
                            className="text-xs text-primary hover:underline disabled:opacity-50"
                          >
                            {isPending ? "Saving…" : "Save"}
                          </button>
                          <button
                            onClick={() => { setEditing(null); setError(null); }}
                            className="text-xs text-muted-foreground hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-3">
                          <button
                            onClick={() =>
                              setEditing({
                                id: tag.id,
                                shortName: tag.shortName,
                                parentId: tag.parentId,
                              })
                            }
                            className="text-xs text-muted-foreground hover:text-primary"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDelete(tag)}
                            disabled={isPending}
                            className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-40"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {!showNew && error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
