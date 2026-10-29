"use client";

import { createPortal } from "react-dom";

// Read-only summary of one list row, shown while the pointer rests on the row (or the payee link has keyboard focus), so
// the note and details can be read without opening the transaction. Fixed-position in a portal: the table sits in a
// scroll box that would clip an absolutely positioned card. pointer-events-none, so it never blocks a click.

export interface HoverCardData {
  payee: string;
  date: string;
  amount: string;
  isOutflow: boolean;
  account: string;
  status: string;
  description: string | null;
  normalizedPayee: string | null;
  tags: string[];
  project: string | null;
  notes: string | null;
}

export interface HoverCardAnchor {
  left: number;
  top: number;
  bottom: number;
}

export const HOVER_CARD_ID = "transaction-hover-card";
const CARD_GAP = 4;
// Below the row when there is room for a typical card, otherwise above it.
const ROOM_BELOW = 260;

export function TransactionHoverCard({ data, anchor }: { data: HoverCardData; anchor: HoverCardAnchor }) {
  if (typeof document === "undefined") return null;
  const below = window.innerHeight - anchor.bottom > ROOM_BELOW || anchor.top < ROOM_BELOW;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 328));
  const style: React.CSSProperties = below
    ? { left, top: anchor.bottom + CARD_GAP }
    : { left, bottom: window.innerHeight - anchor.top + CARD_GAP };

  return createPortal(
    <div
      id={HOVER_CARD_ID}
      role="tooltip"
      style={style}
      className="pointer-events-none fixed z-40 w-80 max-w-[calc(100vw-1rem)] rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 break-words text-sm font-medium">{data.payee}</p>
        <p
          className={`shrink-0 font-mono font-medium tabular-nums ${data.isOutflow ? "text-destructive" : "text-green-600"}`}
        >
          {data.amount}
        </p>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 [&>dd]:min-w-0 [&>dd]:break-words">
        <dt className="text-muted-foreground">Date</dt>
        <dd>{data.date}</dd>
        <dt className="text-muted-foreground">Account</dt>
        <dd>{data.account}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>{data.status}</dd>
        {data.description && (
          <>
            <dt className="text-muted-foreground">Description</dt>
            <dd>{data.description}</dd>
          </>
        )}
        {data.normalizedPayee && (
          <>
            <dt className="text-muted-foreground">Normalized</dt>
            <dd className="font-mono">{data.normalizedPayee}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Tags</dt>
        <dd>{data.tags.length > 0 ? data.tags.join(", ") : <span className="text-muted-foreground">None</span>}</dd>
        {data.project && (
          <>
            <dt className="text-muted-foreground">Project</dt>
            <dd>{data.project}</dd>
          </>
        )}
      </dl>
      <div className="mt-2 border-t pt-2">
        <p className="text-muted-foreground">Note</p>
        {data.notes ? (
          <p className="mt-0.5 line-clamp-[12] whitespace-pre-wrap break-words">{data.notes}</p>
        ) : (
          <p className="mt-0.5 text-muted-foreground">No note</p>
        )}
      </div>
    </div>,
    document.body
  );
}
