"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { acceptFinding, reopenFinding } from "@/actions/tax-review";
import { BUTTON_PLAIN, BUTTON_PRIMARY, FIELD } from "@/components/tax/forms/override-parts";
import { ModalShell } from "@/components/tax/forms/modal-shell";
import { checkAcceptForm, checkReason, reasonCounter } from "@/lib/tax-review/ui";
import type { FindingDto } from "@/lib/tax-review/state";

// Accept (with a required reason) or reopen ONE finding. Plain language, no window.confirm. Busy-state locking like the override
// dialog: while a request is in flight the buttons, the field, Escape, the backdrop and Close do nothing, so the result text cannot
// be lost; the dialog closes itself on success and the page is refreshed. Only the finding's key and evidence hash are sent (the
// server looks the finding up in the latest checks and refuses one that must be fixed, a stale run and any account but the owner's).

export function DispositionDialog({ finding, mode, year, onClose }: { finding: FindingDto; mode: "accept" | "reopen"; year: 2025; onClose: () => void }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const accept = checkAcceptForm({ reason, busy, acceptable: finding.acceptable });
  const reopenReason = reason.trim() === "" ? { ok: true as const } : checkReason(reason);
  const canSubmit = mode === "accept" ? accept.canAccept : !busy && reopenReason.ok;

  function finish() {
    startTransition(() => router.refresh());
    onClose();
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setResult(null);
    try {
      const ref = { taxYear: year, findingKey: finding.key, evidenceHash: finding.evidenceHash };
      const res = mode === "accept" ? await acceptFinding({ ...ref, reason: reason.trim() }) : await reopenFinding({ ...ref, ...(reason.trim() === "" ? {} : { reason: reason.trim() }) });
      if (!res.ok) {
        setResult(res.error);
        return;
      }
      finish();
    } catch {
      setResult("Something went wrong and nothing was saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title={mode === "accept" ? "Accept this finding" : "Reopen this finding"} onClose={onClose} busy={busy}>
      <div className="space-y-4" data-testid="disposition-dialog">
        <p className="text-sm">{finding.message}</p>
        {mode === "accept" ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
            Accepting means you looked at this and decided it is fine to leave as it is. The reason is kept with your name as part of the return&apos;s record, and it stops counting if the figures behind it change.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">The finding becomes open again. The earlier acceptance and its reason stay in the history.</p>
        )}
        <div className="space-y-1">
          <label htmlFor={reasonId} className="text-xs font-medium">
            {mode === "accept" ? "Why is it fine to leave this as it is? (required)" : "Why are you reopening it? (optional)"}
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            disabled={busy}
            aria-invalid={mode === "accept" ? accept.reasonError !== null : !reopenReason.ok}
            className={FIELD}
          />
          <p className="flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
            <span>A sentence is enough. Do not type Social Security, employer ID or account numbers.</span>
            <span className="tabular-nums">{reasonCounter(reason)}</span>
          </p>
          {mode === "accept" && accept.reasonError !== null ? <p className="text-xs text-red-700">{accept.reasonError}</p> : null}
          {mode === "reopen" && !reopenReason.ok && reopenReason.error !== null ? <p className="text-xs text-red-700">{reopenReason.error}</p> : null}
        </div>
        <p aria-live="polite" className={`min-h-[1.25rem] text-sm ${result === null ? "" : "text-red-700"}`} data-testid="disposition-result">
          {result}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON_PRIMARY} onClick={() => void submit()} disabled={!canSubmit} data-testid="disposition-submit">
            {busy ? "Saving..." : mode === "accept" ? "Accept" : "Reopen"}
          </button>
          <button type="button" className={BUTTON_PLAIN} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
