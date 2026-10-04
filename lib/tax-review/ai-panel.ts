// Pure logic of the AI review panel on the Final review page (ai-return-reviewer, B5): what the Start button needs, how progress reads,
// and what the step loop does after each server step. Browser-safe (no server imports), so it is unit-tested without a DOM.

import { formatUsd } from "@/lib/tax-review/llm/model";
import type { AiEstimateDto, AiReviewDto } from "@/lib/tax-review/state";

export const SEND_NOTICE =
  "This sends a redacted summary of the return to Anthropic's API and uses your API credit. The household appears only as \"Taxpayer M\" and \"Taxpayer F\"; names, street addresses, business names, employer ids and account numbers are removed before anything leaves the app. Nothing is sent until you start.";

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

export function priceBasisText(e: Pick<AiEstimateDto, "priceSource" | "inPerMtok" | "outPerMtok">): string {
  return e.priceSource === "env"
    ? `Price assumption from this server's settings: ${formatUsd(e.inPerMtok)} per million input tokens and ${formatUsd(e.outPerMtok)} per million output tokens.`
    : `Price assumption: ${formatUsd(e.inPerMtok)} per million input tokens and ${formatUsd(e.outPerMtok)} per million output tokens. This is a built-in upper-end assumption, not a verified price; set the real rates (TAX_REVIEW_PRICE_IN_PER_MTOK, TAX_REVIEW_PRICE_OUT_PER_MTOK) on the server to make the estimate meaningful. Your hard spending limit is the one you set in your Anthropic account.`;
}

export function progressLabel(ai: AiReviewDto): string {
  if (ai.status === "not_run") return "The AI review has not been run.";
  const n = ai.completedCount;
  const total = ai.totalCount;
  switch (ai.status) {
    case "completed":
      return `Done: all ${total} tasks completed.`;
    case "failed":
      return `Stopped: a task failed after its retries (${n} of ${total} tasks completed). The gate stays red.`;
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
