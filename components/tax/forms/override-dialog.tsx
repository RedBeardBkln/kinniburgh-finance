"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clearTaxReturnOverride, setTaxReturnOverride } from "@/actions/tax-return-overrides";
import { amountEntryHint, checkLineForm, checkReasonInput, describeActionFailure } from "@/lib/tax2025/override-input";
import type { OverrideAuthority } from "@/lib/tax2025/overrides";
import { AuthorityField, BUTTON_PLAIN, BUTTON_PRIMARY, ClearSection, FIELD, HistorySection, ReasonField } from "@/components/tax/forms/override-parts";
import { ModalShell } from "@/components/tax/forms/modal-shell";

// The override dialog for ONE line of the review sheet. Plain language, no
// window.confirm. Props are the plain JSON the sheet model already carries (the
// client never imports the engine or the flow table). Saving / clearing call the
// server actions (which re-validate everything and never trust a client number),
// then refresh the page so the sheet, the CSV and the PDF packet all show the result.

export interface OverrideDialogLine {
  key: string;
  form: string;
  formLine: string;
  label: string;
  computed: { amount: number | null; amountText: string; statusLabel: string; reason: string | null; blocked: boolean };
  override: { id: string; version: number; authority: OverrideAuthority; nowAmount: number; note: string; reason: string; stale: boolean } | null;
  affects: string[];
  affectsMore: number;
}

export function OverrideDialog({ line, taxYear, onClose }: { line: OverrideDialogLine; taxYear: 2025; onClose: () => void }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const resultId = useId();
  const amountId = useId();
  const current = line.override;
  const [amountText, setAmountText] = useState(current === null ? "" : String(current.nowAmount));
  const [authority, setAuthority] = useState<OverrideAuthority>(current?.authority ?? "cpa");
  const [reasonText, setReasonText] = useState("");
  const [clearing, setClearing] = useState(false);
  const [clearReason, setClearReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const form = checkLineForm({ amountText, reasonText, busy });
  const amountHint = amountEntryHint(line.key);
  const clearCheck = checkReasonInput(clearReason);

  function finish() {
    startTransition(() => router.refresh());
    onClose();
  }

  async function save() {
    if (!form.canSave || form.cents === null) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await setTaxReturnOverride({ taxYear, targetKind: "line", targetKey: line.key, valueCents: form.cents, authority, reason: reasonText.trim() });
      if (!res.ok) {
        setResult(describeActionFailure(res));
        return;
      }
      finish();
    } catch {
      setResult("Something went wrong and nothing was saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (current === null || !clearCheck.ok) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await clearTaxReturnOverride({ id: current.id, reason: clearReason.trim() });
      if (!res.ok) {
        setResult(describeActionFailure(res));
        return;
      }
      finish();
    } catch {
      setResult("Something went wrong and nothing was cleared. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title={`${current === null ? "Set a figure for" : "Change the figure for"} ${line.form}, line ${line.formLine}`} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{line.label}</p>

        <div className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="override-computed">
          <p className="text-xs font-medium">What the app computed</p>
          {line.computed.blocked ? (
            <p>No value yet: {line.computed.reason ?? line.computed.statusLabel}</p>
          ) : (
            <p className="font-medium">
              {line.computed.amountText} <span className="font-normal text-muted-foreground">({line.computed.statusLabel})</span>
            </p>
          )}
        </div>

        {line.computed.blocked ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            The engine could not work this line out. Entering a value here records your CPA&apos;s figure on this line and in the PDF. It does NOT recompute the
            totals.
          </p>
        ) : null}

        {current !== null ? (
          <p className="rounded-md border border-violet-300 bg-violet-50 p-3 text-xs text-violet-900" data-testid="override-current">
            {current.note}
            {current.stale ? " This override may be out of date: the computed value changed after it was set." : ""}
          </p>
        ) : null}

        <div className="space-y-1">
          <label htmlFor={amountId} className="text-xs font-medium">
            Amount (whole dollars)
          </label>
          <input
            id={amountId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            disabled={busy}
            aria-invalid={form.amountError !== null}
            aria-describedby={form.amountError !== null ? `${amountId}-err` : undefined}
            placeholder="for example 12345 or $12,345"
            className={FIELD}
          />
          {amountHint !== null ? (
            <p className="text-xs text-muted-foreground" data-testid="override-amount-hint">
              {amountHint}
            </p>
          ) : null}
          {form.amountError !== null ? (
            <p id={`${amountId}-err`} className="text-xs text-red-700">
              {form.amountError}
            </p>
          ) : null}
        </div>

        <AuthorityField value={authority} onChange={setAuthority} disabled={busy} />
        <ReasonField value={reasonText} onChange={setReasonText} error={form.reasonError} disabled={busy} label="Reason (required)" />

        {line.affects.length > 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="override-affects">
            These lines depend on this one and will NOT be recalculated: {line.affects.join(", ")}
            {line.affectsMore > 0 ? `, and ${line.affectsMore} more` : ""}. They are flagged &quot;depends on an override&quot; so nothing is silently out of date.
          </p>
        ) : null}

        <p id={resultId} aria-live="polite" className={`min-h-[1.25rem] text-sm ${result === null ? "" : "text-red-700"}`}>
          {result}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON_PRIMARY} onClick={() => void save()} disabled={!form.canSave}>
            {busy ? "Saving..." : "Save"}
          </button>
          <button type="button" className={BUTTON_PLAIN} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>

        {current !== null ? (
          <ClearSection
            open={clearing}
            onOpen={() => setClearing(true)}
            onCancel={() => {
              setClearing(false);
              setClearReason("");
            }}
            reason={clearReason}
            onReason={setClearReason}
            reasonError={clearReason.trim() === "" || clearCheck.ok ? null : clearCheck.error}
            canClear={!busy && clearCheck.ok}
            busy={busy}
            onClear={() => void clear()}
            what="override"
          />
        ) : null}

        <HistorySection taxYear={taxYear} targetKind="line" targetKey={line.key} />
      </div>
    </ModalShell>
  );
}
