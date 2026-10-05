// Pure logic of the AI review panel on the Final review page (ai-return-reviewer, B5): what the Start button needs, how progress reads,
// and what the step loop does after each server step. Browser-safe (no server imports), so it is unit-tested without a DOM.

import { formatUsd } from "@/lib/tax-review/llm/model";
import type { AiEstimateDto, AiReviewDto } from "@/lib/tax-review/state";

// What the owner ticks "I understand what is sent" against. It must match lib/tax-review/llm/payload.ts: the names of the payers read from the
// documents (employers, payroll companies, banks, lenders, brokerages) are sent as printed unless the server setting TAX_REVIEW_PAYER_NAMES is
// "generic"; everything else listed as removed is removed by scrub.ts / redact.ts. A test builds the real payload and compares (tax-review-send-notice.test.ts).
export const SEND_NOTICE =
  "This sends a redacted summary of the return to Anthropic's API and uses your API credit. "
  + "The names of the payers on your tax documents (employers, payroll companies, banks, lenders and brokerages) ARE sent as they are printed on the document, because they help the review recognise each form. "
  + "The server setting TAX_REVIEW_PAYER_NAMES=generic sends \"Employer A\" and \"Payer B\" instead. "
  + "The household appears only as \"Taxpayer M\" and \"Taxpayer F\". Household names, street addresses, the names of your own business entities, Social Security numbers and account numbers are removed, and employer identification numbers are cut to their last four digits, before anything leaves the app. "
  + "Nothing is sent until you start.";

export interface StartCheck {
  canStart: boolean;
  /** Plain reasons the Start button is disabled (empty when it is enabled). */
  reasons: string[];
}

export function checkStart(estimate: AiEstimateDto | null, state: { understood: boolean; acceptHighCost: boolean }): StartCheck {
  const reasons: string[] = [];
  if (estimate === null) reasons.push("Estimate the cost first.");
  else {
    if (estimate.alreadyStarted) reasons.push("An AI review already exists for this return state: resume it instead.");
    if (!state.understood) reasons.push("Tick the box to confirm what is sent.");
    if (estimate.warn && !state.acceptHighCost) reasons.push(`The estimate is above ${formatUsd(estimate.warnThresholdUsd)}: tick the box to accept it.`);
  }
  return { canStart: reasons.length === 0, reasons };
}

/** Which steps the estimate covers: what will be sent, and what is reused (and therefore not counted). */
export function estimateScopeText(e: Pick<AiEstimateDto, "requests" | "reusedTaskIds" | "tasks">): string {
  const sent = `${e.requests} request${e.requests === 1 ? "" : "s"} will be sent`;
  if (e.reusedTaskIds.length === 0) return `${sent}.`;
  const ids = e.reusedTaskIds.join(", ");
  return `${sent}. ${e.reusedTaskIds.length} finished step${e.reusedTaskIds.length === 1 ? "" : "s"} (${ids}) ${e.reusedTaskIds.length === 1 ? "is" : "are"} reused from an earlier review of this same return and not sent again, so ${e.reusedTaskIds.length === 1 ? "it is" : "they are"} not in the estimate.`;
}

export function priceBasisText(e: Pick<AiEstimateDto, "priceSource" | "inPerMtok" | "outPerMtok">): string {
  return e.priceSource === "env"
    ? `Price assumption from this server's settings: ${formatUsd(e.inPerMtok)} per million input tokens and ${formatUsd(e.outPerMtok)} per million output tokens.`
    : `Price assumption: ${formatUsd(e.inPerMtok)} per million input tokens and ${formatUsd(e.outPerMtok)} per million output tokens. This is a built-in upper-end assumption, not a verified price; set the real rates (TAX_REVIEW_PRICE_IN_PER_MTOK, TAX_REVIEW_PRICE_OUT_PER_MTOK) on the server to make the estimate meaningful. Your hard spending limit is the one you set in your Anthropic account.`;
}

/** The one button of a failed or cancelled AI review (it runs the checks again for the current return, then shows the new estimate). */
export const RESTART_BUTTON_LABEL = "Start a new review (reuses finished steps)";

/** What the owner is told the button does. */
export const RESTART_EXPLANATION =
  "A failed or cancelled review is never continued. The button runs the checks again for the current return and then prepares a new AI review. The steps this review already finished are copied into the new one (only when the return, the model and the questions asked are exactly the same), so you are not charged for them again. You see the new estimate, which counts only the steps that will be sent, and nothing is sent until you confirm it.";

/** Plain sentence for the reason a step failed. A cut-off answer says that the larger retry was used too. */
export function taskFailureText(t: AiReviewDto["tasks"][number]): string {
  const why = ERROR_KIND_LABEL[t.errorKind ?? "unknown"] ?? "an error";
  if (t.errorKind === "max_tokens") return `the answer was cut off, also after one retry with a larger limit (${t.attempts} ${t.attempts === 1 ? "try" : "tries"})`;
  return `${why} (${t.attempts} ${t.attempts === 1 ? "try" : "tries"})`;
}

/** What failed, in plain words, for a failed run ("" when no task failed). */
export function failureSummary(ai: AiReviewDto): string {
  const failed = ai.tasks.filter((t) => t.state === "failed");
  if (failed.length === 0) return "";
  const parts = failed.map((t) => `step ${t.id} (${t.title}): ${taskFailureText(t)}`);
  return `Failed: ${parts.join("; ")}. ${ai.completedCount} of ${ai.totalCount} steps finished and are kept in this review's record.`;
}

/** The review ended without finishing and a new one can take over its finished steps. */
export function canRestart(ai: AiReviewDto): boolean {
  return ai.status === "failed" || ai.status === "cancelled";
}

export function progressLabel(ai: AiReviewDto): string {
  if (ai.status === "not_run") return "The AI review has not been run.";
  const n = ai.completedCount;
  const total = ai.totalCount;
  switch (ai.status) {
    case "completed":
      return `Done: all ${total} tasks completed.`;
    case "failed":
      return `Stopped: a step failed (${n} of ${total} steps completed). The gate stays red.`;
    case "cancelled":
      return `Cancelled after ${n} of ${total} tasks. The gate stays red.`;
    case "stale":
      return `Stopped: the return changed after this review started (${n} of ${total} tasks completed). Run the checks again.`;
    default:
      return `Task ${Math.min(n + 1, total)} of ${total}${ai.busy ? " (running)" : ""}.`;
  }
}

export function costLine(ai: AiReviewDto): string {
  const parts: string[] = [`${ai.inputTokens.toLocaleString("en-US")} input and ${ai.outputTokens.toLocaleString("en-US")} output tokens so far`];
  if (ai.costUsdSoFar !== null) parts.push(`about ${formatUsd(ai.costUsdSoFar)} at the price assumption`);
  if (ai.reusedCount > 0) parts.push(`${ai.reusedCount} finished step${ai.reusedCount === 1 ? "" : "s"} reused from an earlier review (not sent again, no cost)`);
  if (ai.estimate !== null) parts.push(`estimate was ${formatUsd(ai.estimate.expectedUsd)} (up to ${formatUsd(ai.estimate.worstCaseUsd)})`);
  return parts.join("; ");
}

/** What the page's step loop does after a server step: keep going, wait a moment and look again, or stop. */
export function nextLoopAction(step: string): "continue" | "wait" | "stop" {
  switch (step) {
    case "ran":
    case "task_failed":
      return "continue";
    case "busy":
      return "wait";
    default:
      return "stop";
  }
}

const TERMINAL: readonly AiReviewDto["status"][] = ["completed", "failed", "cancelled", "stale"];

/**
 * The progress to show when the page has a server-rendered copy (`server`, refreshed with the page) and this tab has its own, newer one
 * (`local`, from the last action result): whichever is further along. The server copy wins when the page was refreshed after the action.
 */
export function newerProgress(server: AiReviewDto, local: AiReviewDto | null): AiReviewDto {
  if (local === null) return server;
  if (local.completedCount !== server.completedCount) return local.completedCount > server.completedCount ? local : server;
  if (server.status === "not_run" && local.status !== "not_run") return local;
  if (local.status !== server.status && TERMINAL.includes(local.status) && !TERMINAL.includes(server.status)) return local;
  return local.inputTokens + local.outputTokens > server.inputTokens + server.outputTokens ? local : server;
}

/** The run is worth resuming from this tab: started, not finished, not stopped. */
export function canResume(ai: AiReviewDto): boolean {
  return ai.status === "running";
}

export const TASK_STATE_LABEL: Readonly<Record<AiReviewDto["tasks"][number]["state"], string>> = {
  pending: "waiting",
  running: "running",
  completed: "done",
  failed: "failed",
};

export const ERROR_KIND_LABEL: Readonly<Record<string, string>> = {
  transient: "a temporary service error",
  max_tokens: "the answer was cut off",
  refusal: "the model declined",
  invalid_output: "the answer was not in the expected format",
  aborted: "it was cancelled",
  timeout: "it took too long",
  fatal: "the request was refused",
  unknown: "an unknown error",
};
