"use client";

import { useId, useState } from "react";
import { listTaxReturnOverrideHistory } from "@/actions/tax-return-overrides";
import { BUSINESS_USE_TARGET_PREFIX } from "@/lib/tax2025/business-use";
import { formatOverrideHistoryRow, reasonCounterText, sortHistoryNewestFirst } from "@/lib/tax2025/override-input";
import type { OverrideAuthority, OverrideHistoryRow, OverrideTargetKind } from "@/lib/tax2025/overrides";

// Shared pieces of the override dialogs (line and decision): authority, reason, the
// two-step clear and the lazily loaded history. Client components; plain props only.

export const BUTTON_PRIMARY =
  "min-h-[44px] rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0";
export const BUTTON_PLAIN =
  "min-h-[44px] rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0";
export const BUTTON_DANGER =
  "min-h-[44px] rounded-md border border-red-300 px-4 py-2 text-sm text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0";
export const FIELD = "w-full rounded-md border bg-background px-3 py-2 text-sm";

/**
 * The owner prepares the return and is the only decider, so there is nothing to choose: every override is recorded as
 * the owner's (authority "owner"). Older rows stored as "cpa" still display as "Advisor (recorded earlier)".
 */
export const NEW_OVERRIDE_AUTHORITY: OverrideAuthority = "owner";

export function AuthorityField() {
  return (
    <p className="text-xs text-muted-foreground" data-testid="override-authority">
      Recorded as the owner&apos;s decision (Owner (Eric/Eva)).
    </p>
  );
}

export function ReasonField({
  value,
  onChange,
  error,
  disabled,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  disabled: boolean;
  label: string;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        disabled={disabled}
        aria-invalid={error !== null}
        aria-describedby={`${id}-help`}
        className={FIELD}
      />
      <p id={`${id}-help`} className="flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
        <span>Who said so and why, in a sentence. Do not type Social Security or account numbers.</span>
        <span className="tabular-nums">{reasonCounterText(value)}</span>
      </p>
      {error !== null ? <p className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}

/** Two-step clear (no window.confirm): ask for a reason, then "Yes, clear it" / "Keep it". */
export function ClearSection({
  open,
  onOpen,
  onCancel,
  reason,
  onReason,
  reasonError,
  canClear,
  busy,
  onClear,
  what,
}: {
  open: boolean;
  onOpen: () => void;
  onCancel: () => void;
  reason: string;
  onReason: (v: string) => void;
  reasonError: string | null;
  canClear: boolean;
  busy: boolean;
  onClear: () => void;
  what: string;
}) {
  if (!open) {
    return (
      <button type="button" className="text-xs text-red-800 underline" onClick={onOpen} disabled={busy}>
        Clear this {what}
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-red-300 bg-red-50/50 p-3" data-testid="clear-confirm">
      <p className="text-sm">
        Clearing puts the app&apos;s own figure back. The override stays in the history; nothing is deleted. Why are you clearing it?
      </p>
      <ReasonField value={reason} onChange={onReason} error={reasonError} disabled={busy} label="Reason for clearing (required)" />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON_DANGER} onClick={onClear} disabled={!canClear}>
          Yes, clear it
        </button>
        <button type="button" className={BUTTON_PLAIN} onClick={onCancel} disabled={busy}>
          Keep it
        </button>
      </div>
    </div>
  );
}

/** Every version of one target, newest first. Loads only when opened. */
export function HistorySection({ taxYear, targetKind, targetKey }: { taxYear: 2025; targetKind: OverrideTargetKind; targetKey: string }) {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; rows: OverrideHistoryRow[] }>({ kind: "idle" });

  async function load() {
    setState({ kind: "loading" });
    try {
      const res = await listTaxReturnOverrideHistory({ taxYear, targetKind, targetKey });
      setState(res.ok ? { kind: "ok", rows: sortHistoryNewestFirst(res.rows) } : { kind: "error", message: res.error });
    } catch {
      setState({ kind: "error", message: "The history could not be loaded. Close this and try again." });
    }
  }

  return (
    <details
      className="rounded-md border px-3 py-2"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && state.kind === "idle") void load();
      }}
    >
      <summary className="min-h-[44px] cursor-pointer py-2 text-sm font-medium sm:min-h-0 sm:py-0">History</summary>
      <div className="mt-2 space-y-2 text-sm" aria-live="polite">
        {state.kind === "loading" ? <p className="text-muted-foreground">Loading...</p> : null}
        {state.kind === "error" ? <p className="text-red-700">{state.message}</p> : null}
        {state.kind === "ok" && state.rows.length === 0 ? <p className="text-muted-foreground">Nothing has been recorded here yet.</p> : null}
        {state.kind === "ok"
          ? state.rows.map((r) => {
              const t = formatOverrideHistoryRow(r, { percent: targetKey.startsWith(BUSINESS_USE_TARGET_PREFIX) });
              return (
                <div key={r.id} className="rounded border p-2 text-xs" data-testid="history-row">
                  <p className="font-medium">
                    {t.title}: {t.valueText} ({t.authorityLabel})
                  </p>
                  <p className="text-muted-foreground">{t.setText}</p>
                  <p>Reason: {t.reasonText}</p>
                  {t.clearReasonText !== null ? <p>Cleared because: {t.clearReasonText}</p> : null}
                </div>
              );
            })
          : null}
      </div>
    </details>
  );
}
