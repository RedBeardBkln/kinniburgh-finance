"use client";

import type { RuleConflictView } from "@/lib/tag-rule-conflicts";

const KIND_LABEL: Record<RuleConflictView["kind"], string> = {
  duplicate: "Duplicate",
  competing: "Competing",
  overlapping: "Overlapping",
};

function describeScope(c: RuleConflictView, accountName: (id: string) => string): string {
  const parts: string[] = [];
  if (c.amountMin !== null || c.amountMax !== null) {
    parts.push(`$${c.amountMin ?? 0}–${c.amountMax !== null ? `$${c.amountMax}` : "∞"}`);
  }
  parts.push(
    c.accountIds && c.accountIds.length > 0
      ? c.accountIds.map(accountName).join(", ")
      : "any account"
  );
  return parts.join(" · ");
}

/**
 * Lists existing rules that duplicate/compete with a rule about to be saved.
 * When `onApprove` is given, renders the approve/cancel buttons (the save-time
 * gate); without it, it is a passive live preview while the user types.
 */
export function RuleConflictWarning({
  conflicts,
  accountName = (id) => id,
  onApprove,
  onCancel,
  busy,
}: {
  conflicts: RuleConflictView[];
  accountName?: (id: string) => string;
  onApprove?: () => void;
  onCancel?: () => void;
  busy?: boolean;
}) {
  if (conflicts.length === 0) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-2 text-sm text-amber-900"
    >
      <p className="font-medium">
        {onApprove
          ? "Similar rules already exist. Approve to save this one anyway."
          : `${conflicts.length} existing rule${conflicts.length === 1 ? "" : "s"} overlap with this one:`}
      </p>
      <ul className="space-y-1.5">
        {conflicts.map((c, i) => (
          <li key={c.ruleId ?? i} className="text-xs">
            <span className="font-semibold">{KIND_LABEL[c.kind]}:</span>{" "}
            <span className="font-mono">{c.payeePattern ?? "(any payee)"}</span> → {c.tagName}{" "}
            <span className="text-amber-800/80">({describeScope(c, accountName)})</span>
            <div className="text-amber-800/80">{c.reason}</div>
          </li>
        ))}
      </ul>
      {onApprove && (
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onApprove}
            disabled={busy}
            className="inline-flex items-center rounded-md bg-amber-600 px-3 h-8 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Approve & save anyway"}
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="inline-flex items-center rounded-md border px-3 h-8 text-xs font-medium hover:bg-amber-100 disabled:opacity-60"
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  );
}
