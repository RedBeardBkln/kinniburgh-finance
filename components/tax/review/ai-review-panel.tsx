"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelAiReview, estimateAiReview, runNextAiTask, startAiReview } from "@/actions/tax-review";
import { BUTTON_PLAIN, BUTTON_PRIMARY } from "@/components/tax/forms/override-parts";
import { canResume, checkStart, costLine, ERROR_KIND_LABEL, newerProgress, nextLoopAction, priceBasisText, progressLabel, SEND_NOTICE, TASK_STATE_LABEL } from "@/lib/tax-review/ai-panel";
import { formatUsd } from "@/lib/tax-review/llm/model";
import type { AiEstimateDto, AiReviewDto } from "@/lib/tax-review/state";

// The AI review passes on the Final review page: estimate the cost, confirm, start, watch progress, resume or cancel.
// Nothing is sent until the owner has seen the estimate and confirmed (a second, explicit acknowledgement above $50). The page keeps
// calling the server one task at a time (each call fits a serverless time limit; a failed task is retried by the server). The server
// recomputes the return fingerprint on every step: if the return changed, the review stops as stale. Only counts, task states, tokens
// and the estimate come back here, never the payload or any model text. The panel never says the return is right: the gate does its
// own arithmetic.

const WAIT_MS = 4000;

export function AiReviewPanel({ year, hasCurrentRun, runId, ai, whyNot }: { year: 2025; hasCurrentRun: boolean; runId: string | null; ai: AiReviewDto; whyNot: string | null }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const resultId = useId();
  // the page's server-rendered copy (refreshed with the page) or this tab's newer one from the last action result, whichever is further along
  const [local, setProgress] = useState<AiReviewDto | null>(null);
  const progress = newerProgress(ai, local);
  const [estimate, setEstimate] = useState<AiEstimateDto | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [acceptHighCost, setAcceptHighCost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [looping, setLooping] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const stopRef = useRef(false);
  const [knownRunId, setKnownRunId] = useState<string | null>(null);
  const activeRunId = knownRunId ?? estimate?.runId ?? runId;

  // leaving the page stops the loop (the review can be resumed later)
  useEffect(
    () => () => {
      stopRef.current = true;
    },
    []
  );

  const check = checkStart(estimate, { understood, acceptHighCost });

  async function loop(id: string) {
    stopRef.current = false;
    setLooping(true);
    try {
      for (let guard = 0; guard < 80 && !stopRef.current; guard += 1) {
        const res = await runNextAiTask({ taxYear: year, runId: id });
        if (!res.ok) {
          setMessage({ ok: false, text: res.error });
          return;
        }
        setProgress(res.ai);
        const action = nextLoopAction(res.step);
        if (action === "stop") break;
        if (action === "wait") await new Promise((r) => setTimeout(r, WAIT_MS));
      }
    } catch {
      setMessage({ ok: false, text: "Something went wrong while running the review. It can be resumed." });
    } finally {
      setLooping(false);
      startTransition(() => router.refresh());
    }
  }

  async function doEstimate() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await estimateAiReview({ taxYear: year });
      if (!res.ok) {
        setMessage({ ok: false, text: res.error });
        return;
      }
      setEstimate(res.estimate);
      setUnderstood(false);
      setAcceptHighCost(false);
    } catch {
      setMessage({ ok: false, text: "The estimate could not be prepared. Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function doStart() {
    if (busy || !check.canStart || estimate === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await startAiReview({ taxYear: year, confirm: true, ...(estimate.warn ? { acknowledgeHighCost: acceptHighCost } : {}) });
      if (!res.ok) {
        setMessage({ ok: false, text: res.error });
        return;
      }
      setProgress(res.ai);
      setKnownRunId(res.runId);
      setEstimate(null);
      setBusy(false);
      await loop(res.runId);
    } catch {
      setMessage({ ok: false, text: "The AI review could not be started. Nothing was sent." });
    } finally {
      setBusy(false);
    }
  }

  async function doCancel(id: string) {
    stopRef.current = true;
    try {
      const res = await cancelAiReview({ taxYear: year, runId: id });
      if (!res.ok) setMessage({ ok: false, text: res.error });
      else {
        setProgress(res.ai);
        setMessage({ ok: true, text: "The AI review was cancelled. The gate treats it as not run." });
      }
    } catch {
      setMessage({ ok: false, text: "The cancellation could not be saved. Try again." });
    } finally {
      startTransition(() => router.refresh());
    }
  }

  const resumeId = activeRunId ?? null;
  const started = progress.status !== "not_run";

  return (
    <section aria-labelledby="ai-heading" className="space-y-3 rounded-lg border p-4" data-testid="ai-review-panel">
      <div>
        <h2 id="ai-heading" className="text-base font-semibold">
          AI review passes
        </h2>
        <p className="text-sm text-muted-foreground">
          Thirteen small AI requests read the computed return and the printed forms: income completeness, deductions and credits, the forms line by line, Connecticut, audit risk and the judgments register, then an adversarial pass over the others. The AI can only add
          findings; every legal claim is checked by code against the pinned IRS and Connecticut text or shown as unverified; the gate and the verdict are computed by code.
        </p>
      </div>

      {whyNot !== null ? <p className="text-sm text-muted-foreground">{whyNot}</p> : null}

      {started ? (
        <div className="space-y-2" data-testid="ai-progress">
          <p className="text-sm font-medium" data-testid="ai-progress-label">
            {progressLabel(progress)}
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={progress.totalCount} aria-valuenow={progress.completedCount} aria-label="AI review progress">
            <div className="h-full bg-primary transition-all" style={{ width: `${Math.round((progress.completedCount / Math.max(1, progress.totalCount)) * 100)}%` }} />
          </div>
          <p className="text-xs text-muted-foreground" data-testid="ai-cost-line">
            {costLine(progress)}
          </p>
          <ul className="grid gap-1 text-xs sm:grid-cols-2" data-testid="ai-task-list">
            {progress.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-baseline gap-x-2 rounded border px-2 py-1" data-state={t.state}>
                <span className="font-mono text-[11px] uppercase">{t.id}</span>
                <span className="min-w-0 flex-1">{t.title}</span>
                <span className={t.state === "failed" ? "font-medium text-red-800" : t.state === "completed" ? "text-green-800" : "text-muted-foreground"}>
                  {TASK_STATE_LABEL[t.state]}
                  {t.state === "completed" ? ` - ${t.findingCount} finding${t.findingCount === 1 ? "" : "s"}${t.rejectedCount > 0 ? `, ${t.rejectedCount} set aside` : ""}${t.unverifiedCount > 0 ? `, ${t.unverifiedCount} unverified` : ""}` : ""}
                  {t.failures > 0 && t.state !== "completed" ? ` (${t.failures} failed: ${ERROR_KIND_LABEL[t.errorKind ?? "unknown"] ?? "an error"})` : ""}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            {canResume(progress) && !looping && resumeId !== null ? (
              <button type="button" className={BUTTON_PRIMARY} onClick={() => void loop(resumeId)} disabled={whyNot !== null} data-testid="ai-resume-button">
                Resume
              </button>
            ) : null}
            {canResume(progress) && resumeId !== null ? (
              <button type="button" className={BUTTON_PLAIN} onClick={() => void doCancel(resumeId)} disabled={whyNot !== null} data-testid="ai-cancel-button">
                Cancel the AI review
              </button>
            ) : null}
            {looping ? <span className="text-xs text-muted-foreground">Running. Keep this page open; you can resume later if you close it.</span> : null}
          </div>
        </div>
      ) : null}

      {started && (progress.status === "failed" || progress.status === "cancelled" || progress.status === "stale") ? (
        <p className="text-xs text-muted-foreground" data-testid="ai-restart-note">
          A failed, cancelled or stale AI review is not restarted: run the checks again (above) and start a new AI review for that run.
        </p>
      ) : null}

      {!started ? (
        <div className="space-y-3">
          {hasCurrentRun ? (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={BUTTON_PRIMARY} onClick={() => void doEstimate()} disabled={busy || looping || whyNot !== null} aria-busy={busy} data-testid="ai-estimate-button">
                {busy && estimate === null ? "Preparing the estimate..." : "Estimate the cost"}
              </button>
              <span className="text-xs text-muted-foreground">Nothing is sent when you estimate.</span>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Run the checks for the current return first; the AI review attaches to them.</p>
          )}

          {estimate !== null ? (
            <div className="space-y-2 rounded-md border border-slate-300 bg-slate-50 p-3 text-sm" data-testid="ai-estimate">
              <p className="font-medium">
                Estimated cost: about {formatUsd(estimate.expectedUsd)} (up to {formatUsd(estimate.worstCaseUsd)} if every answer uses its full length)
              </p>
              <p className="text-xs">
                {estimate.tasks.length} requests, about {estimate.inputTokens.toLocaleString("en-US")} input and {estimate.outputTokens.toLocaleString("en-US")} output tokens, model <code className="font-mono">{estimate.model}</code>. The redacted summary that would be sent is{" "}
                {(estimate.payloadBytes / 1024).toFixed(0)} KB.
              </p>
              <p className="text-xs text-muted-foreground" data-testid="ai-price-basis">
                {priceBasisText(estimate)}
              </p>
              {estimate.warn ? (
                <p className="rounded border border-amber-400 bg-amber-50 p-2 text-xs font-medium text-amber-950" role="alert" data-testid="ai-high-cost">
                  This estimate is above {formatUsd(estimate.warnThresholdUsd)}. The app does not cap spending; your hard limit is the one you set in your Anthropic account.
                </p>
              ) : null}
              <p className="text-xs">{SEND_NOTICE}</p>
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} data-testid="ai-understood" />
                <span>I understand what is sent and that it uses my API credit.</span>
              </label>
              {estimate.warn ? (
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" checked={acceptHighCost} onChange={(e) => setAcceptHighCost(e.target.checked)} data-testid="ai-accept-cost" />
                  <span>I accept an estimated cost above {formatUsd(estimate.warnThresholdUsd)}.</span>
                </label>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className={BUTTON_PRIMARY} onClick={() => void doStart()} disabled={busy || !check.canStart} data-testid="ai-start-button">
                  Start the AI review
                </button>
                <button type="button" className={BUTTON_PLAIN} onClick={() => setEstimate(null)} disabled={busy}>
                  Not now
                </button>
              </div>
              {check.reasons.length > 0 ? (
                <ul className="list-disc pl-5 text-xs text-muted-foreground" data-testid="ai-start-reasons">
                  {check.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <p id={resultId} aria-live="polite" className={`min-h-[1.25rem] text-sm ${message === null ? "" : message.ok ? "text-green-800" : "text-red-700"}`} data-testid="ai-message">
        {message?.text}
      </p>
    </section>
  );
}
