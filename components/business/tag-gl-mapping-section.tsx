"use client";

import { useState, useTransition } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
  upsertTagGlMapping,
  unsetTagGlMapping,
  type TagMappingRow,
  type UnusedTagOption,
} from "@/actions/gl-code-mappings";
import { GlBackfillModal } from "@/components/business/gl-backfill-modal";

interface GlCodeOption {
  id: string;
  code: string;
  name: string;
}

interface Props {
  entityId: string;
  glCodes: GlCodeOption[];
  inUse: TagMappingRow[];
  unused: UnusedTagOption[];
}

export function TagGlMappingSection({ entityId, glCodes, inUse: initialInUse, unused }: Props) {
  const [inUse, setInUse] = useState(initialInUse);
  const [addingTagId, setAddingTagId] = useState<string>("");
  const [manuallyAdded, setManuallyAdded] = useState<UnusedTagOption[]>([]);
  // Per-row save status — a single shared scalar previously meant only the
  // most-recently-edited row ever showed a saving/disabled state, and a
  // failed save had no error handling at all: the await simply threw,
  // setInUse never ran, and the row silently reverted with zero indication
  // anything went wrong. Assigning many tags in a row made this easy to miss
  // until navigating away and back.
  const [rowStatus, setRowStatus] = useState<Record<string, "saving" | "saved" | "error">>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [showBackfill, setShowBackfill] = useState(false);
  const [, startTransition] = useTransition();

  const mappedTagIds = new Set(inUse.map((r) => r.tagId));
  const remainingUnused = unused.filter((t) => !mappedTagIds.has(t.id));

  function handleSetMapping(tagId: string, tagName: string, glCodeId: string) {
    setRowStatus((prev) => ({ ...prev, [tagId]: "saving" }));
    setRowError((prev) => {
      if (!(tagId in prev)) return prev;
      const next = { ...prev };
      delete next[tagId];
      return next;
    });
    startTransition(async () => {
      try {
        if (glCodeId) {
          await upsertTagGlMapping(entityId, tagId, glCodeId);
          setInUse((prev) => {
            const exists = prev.some((r) => r.tagId === tagId);
            if (exists) {
              return prev.map((r) => (r.tagId === tagId ? { ...r, glCodeId } : r));
            }
            return [...prev, { tagId, tagName, usageCount: 0, glCodeId }];
          });
        } else {
          await unsetTagGlMapping(entityId, tagId);
          setInUse((prev) => prev.map((r) => (r.tagId === tagId ? { ...r, glCodeId: null } : r)));
        }
        setRowStatus((prev) => ({ ...prev, [tagId]: "saved" }));
        // Fade the "Saved" confirmation after a couple seconds rather than
        // leaving a permanent checkmark on every row that's ever been touched.
        setTimeout(() => {
          setRowStatus((prev) => {
            if (prev[tagId] !== "saved") return prev;
            const next = { ...prev };
            delete next[tagId];
            return next;
          });
        }, 2000);
      } catch (err) {
        setRowStatus((prev) => ({ ...prev, [tagId]: "error" }));
        setRowError((prev) => ({
          ...prev,
          [tagId]: err instanceof Error ? err.message : "Failed to save — try again.",
        }));
      }
    });
  }

  function handleAddTag() {
    const tag = remainingUnused.find((t) => t.id === addingTagId);
    if (!tag) return;
    setManuallyAdded((prev) => [...prev, tag]);
    setAddingTagId("");
  }

  const rows = [
    ...inUse,
    ...manuallyAdded
      .filter((t) => !mappedTagIds.has(t.id))
      .map((t) => ({ tagId: t.id, tagName: t.name, usageCount: 0, glCodeId: null as string | null })),
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Tag → GL Code Mapping</h2>
        <button
          onClick={() => setShowBackfill(true)}
          className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-3 h-8 text-xs font-medium hover:bg-primary/90"
        >
          Backfill existing transactions
        </button>
      </div>
      <p className="text-sm text-muted-foreground">
        Map a tag to a GL code so matching transactions are auto-coded going
        forward. If a transaction has multiple tags that map to different GL
        codes, it&apos;s left uncoded for manual review in the Coding Queue.
      </p>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium text-xs">Tag</th>
                <th className="px-3 py-2 font-medium text-xs">In-use count</th>
                <th className="px-3 py-2 font-medium text-xs">GL Code</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground text-sm">
                    No tags to map yet
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr key={row.tagId} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-2 text-xs">{row.tagName}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {row.usageCount > 0 ? row.usageCount : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <select
                        value={row.glCodeId ?? ""}
                        onChange={(e) => handleSetMapping(row.tagId, row.tagName, e.target.value)}
                        disabled={rowStatus[row.tagId] === "saving"}
                        className="block w-full rounded border border-input bg-background px-1.5 py-1 text-xs"
                      >
                        <option value="">— unmapped —</option>
                        {glCodes.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.code} {g.name}
                          </option>
                        ))}
                      </select>
                      {rowStatus[row.tagId] === "saving" && (
                        <span className="shrink-0 text-xs text-muted-foreground">Saving…</span>
                      )}
                      {rowStatus[row.tagId] === "saved" && (
                        <span className="shrink-0 text-xs text-green-600">Saved ✓</span>
                      )}
                    </div>
                    {rowStatus[row.tagId] === "error" && (
                      <p className="mt-1 text-xs text-destructive">
                        {rowError[row.tagId] ?? "Failed to save — try again."}
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {remainingUnused.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={addingTagId}
            onChange={(e) => setAddingTagId(e.target.value)}
            className="rounded border border-input bg-background px-2 py-1.5 text-xs"
          >
            <option value="">Map another tag…</option>
            {remainingUnused.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            onClick={handleAddTag}
            disabled={!addingTagId}
            className="rounded-md border px-3 h-8 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            Add
          </button>
        </div>
      )}

      {showBackfill && (
        <GlBackfillModal entityId={entityId} onDone={() => setShowBackfill(false)} />
      )}
    </div>
  );
}
