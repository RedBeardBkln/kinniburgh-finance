"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { parseStoredWidths, sameWidths, widthAfterDrag } from "@/lib/resizable-columns";

export interface ResizableColumn {
  key: string;
  label: string;
  /** Starting width in px. Ignored for the last column, which fills the remaining space. */
  defaultWidth: number;
}

interface Props {
  columns: ResizableColumn[];
  /** localStorage key for remembering this user's widths on this browser. */
  storageKey: string;
  /** Minimum width reserved for the last (fill) column. */
  lastColumnMinWidth?: number;
  /** The <tbody> (rendered on the server). */
  children: ReactNode;
}

const KEY_STEP = 10;

/**
 * Table shell with drag-to-resize column dividers. Every column except the last
 * is resizable; the last one absorbs the remaining width, so dragging a divider
 * moves it 1:1 and the table never has to spill past its card unless the user
 * deliberately makes the columns wider than the screen (then it scrolls inside
 * the card). Double-click a divider or use "Reset column widths" to restore the
 * defaults. Widths are remembered per browser (best-effort; storage may be
 * unavailable, in which case the defaults are used and nothing breaks).
 */
export function ResizableTable({ columns, storageKey, lastColumnMinWidth = 150, children }: Props) {
  const resizable = columns.slice(0, -1);
  const defaults = resizable.map((c) => c.defaultWidth);
  const [widths, setWidths] = useState<number[]>(defaults);
  const drag = useRef<{ index: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    try {
      // Read after mount (not in the useState initializer) so the server render
      // and first client render both use the defaults and hydration matches.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWidths(parseStoredWidths(window.localStorage.getItem(storageKey), defaults));
    } catch {
      /* storage unavailable: keep defaults */
    }
    // defaults is derived from the static columns prop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  function persist(next: number[]) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* best-effort */
    }
  }

  function setWidth(index: number, width: number, save: boolean) {
    setWidths((prev) => {
      const next = [...prev];
      next[index] = width;
      if (save) persist(next);
      return next;
    });
  }

  function onPointerDown(index: number, e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { index, startX: e.clientX, startWidth: widths[index] ?? defaults[index] ?? 100 };
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    setWidth(d.index, widthAfterDrag(d.startWidth, e.clientX - d.startX), false);
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setWidth(d.index, widthAfterDrag(d.startWidth, e.clientX - d.startX), true);
  }

  function onKeyDown(index: number, e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const current = widths[index] ?? defaults[index] ?? 100;
    setWidth(index, widthAfterDrag(current, e.key === "ArrowRight" ? KEY_STEP : -KEY_STEP), true);
  }

  function resetOne(index: number) {
    setWidth(index, defaults[index] ?? 100, true);
  }

  function resetAll() {
    setWidths([...defaults]);
    persist([...defaults]);
  }

  const isDefault = sameWidths(widths, defaults);
  const fixedTotal = widths.reduce((sum, w) => sum + w, 0);

  return (
    <div>
      <div className="flex justify-end px-4 pt-2 text-xs text-muted-foreground">
        {isDefault ? (
          <span>Drag a column divider to resize</span>
        ) : (
          <button type="button" onClick={resetAll} className="text-primary hover:underline">
            Reset column widths
          </button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table
          className="resizable-table text-sm [&_td]:overflow-hidden [&_td]:break-words"
          style={{ tableLayout: "fixed", width: "100%", minWidth: fixedTotal + lastColumnMinWidth }}
        >
          <colgroup>
            {resizable.map((c, i) => (
              <col key={c.key} style={{ width: widths[i] }} />
            ))}
            <col />
          </colgroup>
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {columns.map((c, i) => (
                <th key={c.key} className="relative truncate px-4 py-3 font-medium" title={c.label || undefined}>
                  {c.label}
                  {i < resizable.length && (
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${c.label} column`}
                      tabIndex={0}
                      onPointerDown={(e) => onPointerDown(i, e)}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      onPointerCancel={onPointerUp}
                      onKeyDown={(e) => onKeyDown(i, e)}
                      onDoubleClick={() => resetOne(i)}
                      title="Drag to resize · double-click to reset"
                      className="absolute right-0 top-0 h-full w-2 cursor-col-resize touch-none select-none hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          {children}
        </table>
      </div>
    </div>
  );
}
