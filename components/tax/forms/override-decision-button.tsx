"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clearTaxReturnOverride, setTaxReturnOverride } from "@/actions/tax-return-overrides";
import { checkDecisionForm, checkReasonInput, describeActionFailure } from "@/lib/tax2025/override-input";
import type { OverrideAuthority } from "@/lib/tax2025/overrides";
import { ModalShell } from "@/components/tax/forms/modal-shell";
import { AuthorityField, NEW_OVERRIDE_AUTHORITY, BUTTON_PLAIN, BUTTON_PRIMARY, ClearSection, HistorySection, ReasonField } from "@/components/tax/forms/override-parts";

// "Record this decision" on the owner-decisions part of the review sheet. Recording a
// decision is the ONE case where the whole return is recomputed: the choice is fed to
// the engine, every alternative stays visible side by side, and who / when / why is
// shown with the decision. Same mechanics as the line dialog (authority, required
// reason, two-step clear, history), no window.confirm.

export interface DecisionDialogData {
  id: string;
  label: string;
  decisionKey: string;
  undecided: boolean;
  choices: { id: string; label: string; effectText: string; isDefault: boolean; inForce: boolean }[];
  override: { id: string; version: number; authority: OverrideAuthority; choice: string; note: string } | null;
}

function DecisionDialog({ data, taxYear, onClose }: { data: DecisionDialogData; taxYear: 2025; onClose: () => void }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const radioName = useId();
  const current = data.override;
  const [choice, setChoice] = useState<string | null>(current?.choice ?? null);
  const [reasonText, setReasonText] = useState("");
  const [clearing, setClearing] = useState(false);
  const [clearReason, setClearReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const form = checkDecisionForm({ choice, reasonText, busy });
  const clearCheck = checkReasonInput(clearReason);

  function finish() {
    startTransition(() => router.refresh());
    onClose();
  }

  async function save() {
    if (!form.canSave || choice === null) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await setTaxReturnOverride({ taxYear, targetKind: "decision", targetKey: data.decisionKey, choice, authority: NEW_OVERRIDE_AUTHORITY, reason: reasonText.trim() });
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
    <ModalShell title={`${current === null ? "Record" : "Change"} decision ${data.id}`} onClose={onClose} busy={busy}>
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{data.label}</p>
        <p className="text-xs text-muted-foreground">
          The return is recomputed with the choice you record. Until one is recorded the app uses the conservative default. The effect of each choice is shown
          below before you save.
        </p>

        <fieldset className="space-y-2" disabled={busy}>
          <legend className="text-xs font-medium">Choice</legend>
          {data.choices.map((c) => (
            <label key={c.id} className={`block min-h-[44px] cursor-pointer rounded-md border p-3 text-sm sm:min-h-0 ${choice === c.id ? "border-primary" : ""}`}>
              <span className="flex items-start gap-2">
                <input type="radio" name={radioName} checked={choice === c.id} onChange={() => setChoice(c.id)} className="mt-1" />
                <span>
                  <span className="font-medium">{c.label}</span>
                  {c.isDefault ? <span className="ml-2 rounded-full border border-amber-400 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900">the default</span> : null}
                  <span className="mt-1 block text-xs text-muted-foreground">{c.effectText}</span>
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {current !== null ? (
          <p className="rounded-md border border-violet-300 bg-violet-50 p-3 text-xs text-violet-900" data-testid="override-current">
            {current.note}
          </p>
        ) : null}

        <AuthorityField />
        <ReasonField value={reasonText} onChange={setReasonText} error={form.reasonError} disabled={busy} label="Reason (required)" />

        <p aria-live="polite" className={`min-h-[1.25rem] text-sm ${result === null ? "" : "text-red-700"}`}>
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
            what="decision"
          />
        ) : null}

        <HistorySection taxYear={taxYear} targetKind="decision" targetKey={data.decisionKey} />
      </div>
    </ModalShell>
  );
}

export function OverrideDecisionButton({ data, taxYear }: { data: DecisionDialogData; taxYear: 2025 }) {
  const [open, setOpen] = useState(false);
  if (data.choices.length === 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="decision-chip"
        aria-label={`${data.override === null ? "Record" : "Change"} decision ${data.id}`}
        className="inline-flex min-h-[44px] items-center rounded-md border border-primary/40 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10 print:hidden sm:min-h-0"
      >
        {data.override === null ? "Record this decision" : "Change decision"}
      </button>
      {open ? <DecisionDialog data={data} taxYear={taxYear} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
