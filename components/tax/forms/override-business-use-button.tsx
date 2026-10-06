"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clearTaxReturnOverride, setTaxReturnOverride } from "@/actions/tax-return-overrides";
import { formatCentsText } from "@/lib/tax2025/business-use";
import { checkBusinessUseForm, checkReasonInput, describeActionFailure, previewBusinessUse } from "@/lib/tax2025/override-input";
import type { OverrideAuthority } from "@/lib/tax2025/overrides";
import { ModalShell } from "@/components/tax/forms/modal-shell";
import {
  AuthorityField,
  BUTTON_PLAIN,
  BUTTON_PRIMARY,
  ClearSection,
  FIELD,
  HistorySection,
  NEW_OVERRIDE_AUTHORITY,
  ReasonField,
} from "@/components/tax/forms/override-parts";

// "Record this decision" for a shared (mixed-use) account, decision X6 and any later list entry: the owner types the
// business-use PERCENTAGE (0 to 100, one decimal) and the written basis. The return is recomputed with it: the line uses
// (booked amount x percentage), rounded once; the personal portion is informational only and nothing is booked.
// Same mechanics as the choice dialog (authority, required reason, two-step clear, history), no window.confirm.

export interface BusinessUseDialogData {
  /** "X6". */
  id: string;
  label: string;
  /** `businessUse.<key>`. */
  decisionKey: string;
  percent: {
    /** The recorded percentage as typed text ("70", "70.5"), null when none is recorded. */
    currentText: string | null;
    bookedCents: number;
    otherLineCents: number;
    lineLabel: string;
    accountText: string;
  };
  override: { id: string; version: number; authority: OverrideAuthority; choice: string; note: string } | null;
}

function BusinessUseDialog({ data, taxYear, onClose }: { data: BusinessUseDialogData; taxYear: 2025; onClose: () => void }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const percentId = useId();
  const current = data.override;
  const [percentText, setPercentText] = useState(current?.choice ?? data.percent.currentText ?? "");
  const [reasonText, setReasonText] = useState("");
  const [clearing, setClearing] = useState(false);
  const [clearReason, setClearReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const form = checkBusinessUseForm({ percentText, reasonText, busy });
  const clearCheck = checkReasonInput(clearReason);
  const preview =
    form.tenths === null
      ? null
      : previewBusinessUse({ flaggedCents: data.percent.bookedCents, otherCents: data.percent.otherLineCents, tenths: form.tenths, lineLabel: data.percent.lineLabel });

  function finish() {
    startTransition(() => router.refresh());
    onClose();
  }

  async function save() {
    if (!form.canSave) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await setTaxReturnOverride({
        taxYear,
        targetKind: "decision",
        targetKey: data.decisionKey,
        choice: percentText.trim(),
        authority: NEW_OVERRIDE_AUTHORITY,
        reason: reasonText.trim(),
      });
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
          This is {data.percent.accountText}. Only the business share is deductible. Record the percentage that is business use; the return is recomputed with it.
          Until you record one the app uses 100% and marks it &quot;default, undecided&quot;. The personal share is not deducted and is shown for information only:
          nothing is booked and no transaction is changed. The percentage is your own statement; no document supports it, so write down how you worked it out.
        </p>
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900" data-testid="business-use-phone-help">
          Phone service: the Schedule C instructions say not to deduct the base rate (including taxes) of the first phone line into your home, even if you use it
          for business. Extra lines, and costs that are only for the business, can be deducted (a second line at its business percentage). If this account includes a
          landline, work that out first and say so in your reason.
        </p>

        <div className="space-y-1">
          <label htmlFor={percentId} className="text-xs font-medium">
            Business-use percentage (0 to 100, one decimal allowed)
          </label>
          <input
            id={percentId}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={percentText}
            onChange={(e) => setPercentText(e.target.value)}
            disabled={busy}
            aria-invalid={form.percentError !== null}
            aria-describedby={`${percentId}-help`}
            className={FIELD}
            data-testid="business-use-percent"
          />
          <p id={`${percentId}-help`} className="text-[11px] text-muted-foreground">
            For example 70 or 62.5. 100 means all of it is business use; 0 means none of it is.
          </p>
          {form.percentError !== null ? <p className="text-xs text-red-700">{form.percentError}</p> : null}
        </div>

        <p aria-live="polite" className="min-h-[1.25rem] rounded-md border bg-muted/40 p-2 text-xs" data-testid="business-use-preview">
          {preview === null ? `Booked to this account for 2025: ${formatCentsText(data.percent.bookedCents)}. Type a percentage to see the effect.` : preview.text}
        </p>

        {current !== null ? (
          <p className="rounded-md border border-violet-300 bg-violet-50 p-3 text-xs text-violet-900" data-testid="override-current">
            {current.note}
          </p>
        ) : null}

        <AuthorityField />
        <ReasonField
          value={reasonText}
          onChange={setReasonText}
          error={form.reasonError}
          disabled={busy}
          label="Reason and basis (required): how you worked out the share (for example the bill split, a usage log, hours of business use)"
        />

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

export function OverrideBusinessUseButton({ data, taxYear }: { data: BusinessUseDialogData; taxYear: 2025 }) {
  const [open, setOpen] = useState(false);
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
      {open ? <BusinessUseDialog data={data} taxYear={taxYear} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
