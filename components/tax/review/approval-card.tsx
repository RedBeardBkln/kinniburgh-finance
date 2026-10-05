"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approveReturn, withdrawApproval } from "@/actions/tax-return-approval";
import { BUTTON_DANGER, BUTTON_PLAIN, BUTTON_PRIMARY, FIELD } from "@/components/tax/forms/override-parts";
import type { ApprovalDto } from "@/lib/tax-review/state";
import { checkApprovalForm, checkReason, formatNewYork, packageDownloadOutcome, reasonCounter } from "@/lib/tax-review/ui";

// The approval card: the owner's own act. It shows the attestation text VERBATIM (the page passes the server's constant), a tick box,
// the phrase and the full name to type, and the button, which stays off until the gate is green and everything is typed. This is
// a convenience only: the server action recomputes the fingerprint, the gate and the owner's account and refuses anything else. There
// is no way around a red gate here and no waiver. After an approval it offers the final package and a two-step "Withdraw approval"
// (a reason, then "Yes, withdraw it" / "Keep it"; no window.confirm). Busy-state locking like the override dialog.

export function ApprovalCard({
  year,
  attestationText,
  requiredPhrase,
  gateGreen,
  accountAllowed,
  accountReason,
  currentFingerprint12,
  approval,
  notRunNotice,
}: {
  year: 2025;
  attestationText: string;
  requiredPhrase: string;
  gateGreen: boolean;
  accountAllowed: boolean;
  accountReason: string | null;
  currentFingerprint12: string;
  approval: ApprovalDto;
  notRunNotice: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const phraseId = useId();
  const nameId = useId();
  const withdrawId = useId();
  const [checked, setChecked] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; reasons?: string[] } | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [downloading, setDownloading] = useState(false);
  const base = `/api/tax/forms/${year}/pdf`;

  const form = checkApprovalForm({ checked, typedPhrase: phrase, typedName: name, busy, gateGreen, accountAllowed, alreadyApproved: approval.current });
  const withdrawCheck = checkReason(withdrawReason);

  async function approve() {
    if (!form.canApprove) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await approveReturn({ taxYear: year, checked, attestationText, typedPhrase: phrase, typedName: name });
      if (!res.ok) {
        setResult({ ok: false, text: res.error, ...(res.reasons !== undefined ? { reasons: res.reasons } : {}) });
        return;
      }
      setResult({ ok: true, text: "Your approval is recorded for this exact state of the return." });
      setChecked(false);
      setPhrase("");
      setName("");
      startTransition(() => router.refresh());
    } catch {
      setResult({ ok: false, text: "Something went wrong and nothing was saved. Try again." });
    } finally {
      setBusy(false);
    }
  }

  // The final package is fetched (not a plain download link): a refusal is a JSON body, and a link would save that body as a file named like the zip.
  async function downloadFinal() {
    if (downloading) return;
    setDownloading(true);
    setResult(null);
    try {
      const res = await fetch(`${base}?final=1`, { credentials: "same-origin", cache: "no-store" });
      const type = res.headers.get("content-type");
      const asFile = res.ok && type !== null && /zip|octet-stream/i.test(type);
      const outcome = packageDownloadOutcome({ ok: res.ok, status: res.status, contentType: type, disposition: res.headers.get("content-disposition") }, asFile ? null : await res.text());
      if (outcome.kind === "refused") {
        setResult({ ok: false, text: outcome.message });
        startTransition(() => router.refresh()); // the approval may have been revoked: show the current state
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = outcome.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setResult({ ok: false, text: "The download did not work and nothing was saved. Try again." });
    } finally {
      setDownloading(false);
    }
  }

  async function withdraw() {
    if (!withdrawCheck.ok || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await withdrawApproval({ taxYear: year, reason: withdrawReason.trim() });
      if (!res.ok) {
        setResult({ ok: false, text: res.error });
        return;
      }
      setWithdrawing(false);
      setWithdrawReason("");
      setResult({ ok: true, text: "The approval is withdrawn. The clean copies are locked again." });
      startTransition(() => router.refresh());
    } catch {
      setResult({ ok: false, text: "Something went wrong and nothing was changed. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="approval-heading" className="space-y-3 rounded-lg border-2 border-primary/40 p-4" data-testid="review-approval-card">
      <div>
        <h2 id="approval-heading" className="text-base font-semibold">
          Your approval
        </h2>
        <p className="text-xs text-muted-foreground" data-testid="approval-fingerprint-line">
          Current return fingerprint <code className="rounded bg-muted px-1 font-mono">{currentFingerprint12}</code> -{" "}
          {approval.current ? "approved for this state" : approval.inForce ? (approval.revokedReasons !== undefined ? "an approval exists but no longer counts" : `an approval exists for an earlier state (${approval.fingerprint12}): stale`) : "not approved"}
        </p>
      </div>

      {approval.current ? (
        <div className="space-y-2" data-testid="approval-current">
          <p className="rounded-md border border-green-400 bg-green-50 px-3 py-2 text-sm text-green-950">
            Approved by owner{approval.approvedByName !== null ? ` (${approval.approvedByName})` : ""}
            {approval.at !== null ? ` on ${formatNewYork(approval.at)}` : ""}.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void downloadFinal()} disabled={downloading} aria-busy={downloading} className={`${BUTTON_PRIMARY} inline-flex items-center`} data-testid="download-final-package">
              {downloading ? "Preparing..." : "Download the final package (zip)"}
            </button>
            <a href={base} download className={`${BUTTON_PLAIN} inline-flex items-center`}>
              Download the stamped draft packet
            </a>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {approval.inForce ? (
            <p className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid="approval-stale">
              {approval.revokedReasons !== undefined
                ? `Your earlier approval no longer counts and the clean copies are locked: ${approval.revokedReasons.join("; ")}. You can approve again once the checks are green.`
                : "The return changed after your earlier approval, so that approval no longer counts and the clean copies are locked. You can approve the current state once the checks are green."}
            </p>
          ) : null}
          <blockquote className="rounded-md border-l-4 border-primary bg-muted/40 p-3 text-sm" data-testid="attestation-text">
            {attestationText}
          </blockquote>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} disabled={busy} className="mt-1 h-4 w-4" data-testid="attestation-check" />
            <span>I have read the statement above and it is true.</span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor={phraseId} className="text-xs font-medium">
                Type <code className="font-mono">{requiredPhrase}</code>
              </label>
              <input id={phraseId} type="text" value={phrase} onChange={(e) => setPhrase(e.target.value)} disabled={busy} autoComplete="off" className={FIELD} data-testid="attestation-phrase" />
            </div>
            <div className="space-y-1">
              <label htmlFor={nameId} className="text-xs font-medium">
                Your full name
              </label>
              <input id={nameId} type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} autoComplete="off" className={FIELD} data-testid="attestation-name" />
            </div>
          </div>
          {!accountAllowed && accountReason !== null ? <p className="text-xs text-red-800">{accountReason}</p> : null}
          {notRunNotice !== null ? <p className="text-sm font-medium text-amber-950" data-testid="approval-not-run-notice">{notRunNotice}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BUTTON_PRIMARY} onClick={() => void approve()} disabled={!form.canApprove} aria-busy={busy} data-testid="approve-button">
              {busy ? "Saving..." : "Record my approval"}
            </button>
          </div>
          {!form.canApprove && !busy ? (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground" data-testid="approval-blockers">
              {form.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      <p aria-live="polite" className={`min-h-[1.25rem] text-sm ${result === null ? "" : result.ok ? "text-green-800" : "text-red-700"}`} data-testid="approval-result">
        {result?.text}
      </p>
      {result !== null && !result.ok && result.reasons !== undefined && result.reasons.length > 1 ? (
        <ul className="list-disc pl-5 text-xs text-red-700">
          {result.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}

      {approval.inForce ? (
        <div className="border-t pt-3">
          {withdrawing ? (
            <div className="space-y-2" data-testid="withdraw-form">
              <label htmlFor={withdrawId} className="text-xs font-medium">
                Reason for withdrawing (required)
              </label>
              <textarea id={withdrawId} value={withdrawReason} onChange={(e) => setWithdrawReason(e.target.value)} rows={2} disabled={busy} className={FIELD} />
              <p className="flex justify-between text-[11px] text-muted-foreground">
                <span>Do not type Social Security, employer ID or account numbers.</span>
                <span className="tabular-nums">{reasonCounter(withdrawReason)}</span>
              </p>
              {!withdrawCheck.ok && withdrawCheck.error !== null ? <p className="text-xs text-red-700">{withdrawCheck.error}</p> : null}
              <div className="flex flex-wrap gap-2">
                <button type="button" className={BUTTON_DANGER} onClick={() => void withdraw()} disabled={busy || !withdrawCheck.ok} data-testid="withdraw-confirm">
                  {busy ? "Saving..." : "Yes, withdraw it"}
                </button>
                <button
                  type="button"
                  className={BUTTON_PLAIN}
                  onClick={() => {
                    setWithdrawing(false);
                    setWithdrawReason("");
                  }}
                  disabled={busy}
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className={BUTTON_PLAIN} onClick={() => setWithdrawing(true)} disabled={busy} data-testid="withdraw-open">
              Withdraw approval
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}
