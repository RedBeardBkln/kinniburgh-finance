import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canRestart, costLine, estimateScopeText, failureSummary, progressLabel, RESTART_BUTTON_LABEL, RESTART_EXPLANATION, taskFailureText } from "@/lib/tax-review/ai-panel";
import { foldProgress, type RunEvent } from "@/lib/tax-review/llm/progress";
import { toAiDto, type AiReviewDto } from "@/lib/tax-review/state";

// The failed-run UX of the AI review panel (ai-review-token-budget): it says plainly what failed and offers ONE button, "Start a new review
// (reuses finished steps)", instead of the old "run the checks again" text. The owner's confirm tick and the new estimate stay in place.

const read = (p: string): string => readFileSync(resolve(__dirname, "../..", p), "utf8").replace(/\r\n/g, "\n");
const panel = read("components/tax/review/ai-review-panel.tsx");

const ev = (key: string, kind: RunEvent["kind"], taskId: string | null, data: unknown, at: number): RunEvent => ({ runId: "r", eventKey: key, kind, taskId, attempt: null, data, createdAt: new Date(at) });

/** The shape of the live failure of 2026-10-05: a1 a2 b1 b2 b3 done, c1 cut off three times at 6,000 (before the retry existed). */
function liveFailure(): AiReviewDto {
  const events: RunEvent[] = [ev("run_started", "run_started", null, { model: "claude-opus-5-5", estimate: null }, 1)];
  ["a1", "a2", "b1", "b2", "b3"].forEach((id, i) => events.push(ev(`done:${id}`, "task_completed", id, { findingCount: 1, usage: { inputTokens: 50_000, outputTokens: 5_000 } }, 10 + i)));
  for (let n = 1; n <= 3; n += 1) {
    events.push(ev(`start:c1:${n}`, "task_started", "c1", {}, 100 + n * 10));
    events.push(ev(`fail:c1:${n}`, "task_failed", "c1", { kind: "max_tokens", detail: "MaxTokens", usage: { inputTokens: 29_161, outputTokens: 6_000 } }, 105 + n * 10));
  }
  return toAiDto(foldProgress(events, 1_000_000));
}

describe("what failed, in plain words", () => {
  it("names the step, says the answer was cut off (also after a retry) and how many steps finished and are kept", () => {
    const ai = liveFailure();
    expect(ai.status).toBe("failed");
    const text = failureSummary(ai);
    expect(text).toMatch(/^Failed: step c1 \(Form text: Form 1040 and Schedules 1, 2, 3\): the answer was cut off/);
    expect(text).toContain("5 of 13 steps finished");
    expect(text).toMatch(/kept/);
    expect(progressLabel(ai)).toBe("Stopped: a step failed (5 of 13 steps completed). The gate stays red.");
  });
  it("other reasons are in words too, with the number of tries", () => {
    const t = (errorKind: string | null, attempts: number) => ({ ...liveFailure().tasks[5]!, errorKind, attempts });
    expect(taskFailureText(t("transient", 3))).toBe("a temporary service error (3 tries)");
    expect(taskFailureText(t("timeout", 1))).toBe("it took too long (1 try)");
    expect(taskFailureText(t("invalid_output", 2))).toBe("the answer was not in the expected format (2 tries)");
    expect(taskFailureText(t("max_tokens", 2))).toMatch(/cut off, also after one retry with a larger limit \(2 tries\)/);
    expect(taskFailureText(t(null, 1))).toBe("an unknown error (1 try)");
  });
  it("no summary when nothing failed", () => {
    expect(failureSummary({ ...liveFailure(), tasks: liveFailure().tasks.map((x) => ({ ...x, state: "completed" as const })) })).toBe("");
  });
});

describe("one button", () => {
  it("is labelled exactly 'Start a new review (reuses finished steps)'", () => {
    expect(RESTART_BUTTON_LABEL).toBe("Start a new review (reuses finished steps)");
  });
  it("is offered for a failed or a cancelled review only (a stale one was made for another return state: nothing of it is reused)", () => {
    const base = liveFailure();
    expect(canRestart({ ...base, status: "failed" })).toBe(true);
    expect(canRestart({ ...base, status: "cancelled" })).toBe(true);
    for (const status of ["not_run", "running", "completed", "stale"] as const) expect(canRestart({ ...base, status }), status).toBe(false);
  });
  it("the explanation says what happens, in owner terms: new checks, copied steps only for the same return / model / questions, a new estimate, nothing sent before confirming", () => {
    expect(RESTART_EXPLANATION).toMatch(/runs the checks again for the current return/);
    expect(RESTART_EXPLANATION).toMatch(/exactly the same/);
    expect(RESTART_EXPLANATION).toMatch(/not charged for them again/);
    expect(RESTART_EXPLANATION).toMatch(/new estimate/);
    expect(RESTART_EXPLANATION).toMatch(/nothing is sent until you confirm/);
    // plain wording: no CPA talk, no claim about the return
    expect(RESTART_EXPLANATION).not.toMatch(/CPA|approved|is correct|audit-proof/i);
  });
});

describe("the panel source", () => {
  it("offers the button for a failed or cancelled review and no longer tells the owner to 'run the checks again' for those", () => {
    expect(panel).toContain("RESTART_BUTTON_LABEL");
    expect(panel).toContain('data-testid="ai-restart-button"');
    expect(panel).toContain("canRestart(progress)");
    expect(panel).not.toContain("A failed, cancelled or stale AI review is not restarted");
    // the stale case keeps its own explanation (nothing of another return state is reused)
    expect(panel).toContain('data-testid="ai-stale-note"');
    expect(panel).toMatch(/Finished steps of a review of a different return state are never reused/);
  });
  it("the button runs the checks for the current return, then asks for the new estimate; it never starts the review itself", () => {
    const fn = /async function doNewReview\(\) \{[\s\S]*?\n  \}\n/.exec(panel)?.[0] ?? "";
    expect(fn).toContain("runReviewChecks({ taxYear: year })");
    expect(fn).toContain("estimateAiReview({ taxYear: year })");
    expect(fn.indexOf("runReviewChecks")).toBeLessThan(fn.indexOf("estimateAiReview"));
    expect(fn).not.toContain("startAiReview");
    expect(fn).not.toContain("runNextAiTask");
    // the old review's copy in this tab is dropped so the new run is what the page shows
    expect(fn).toContain("setProgress(null)");
    expect(fn).toContain("setKnownRunId(null)");
    // pressing the button twice cannot make two runs
    expect(panel).toMatch(/disabled=\{busy \|\| looping \|\| whyNot !== null \|\| estimate !== null\}/);
  });
  it("the owner's confirm tick, the high-cost tick and the new estimate stay in front of Start", () => {
    expect(panel).toContain('data-testid="ai-understood"');
    expect(panel).toContain('data-testid="ai-accept-cost"');
    expect(panel).toContain('data-testid="ai-estimate"');
    expect(panel).toContain('data-testid="ai-estimate-scope"');
    expect(panel).toContain("startAiReview({ taxYear: year, confirm: true");
    expect(panel).toContain("disabled={busy || !check.canStart}");
    // the estimate is shown for a failed review that is being replaced, not only for a review that was never started
    expect(panel).toContain("(estimate !== null && canRestart(progress))");
  });
  it("the estimate shows the absolute ceiling next to the worst case, and which steps are reused", () => {
    expect(panel).toContain("estimate.maxWithRetryUsd");
    expect(panel).toContain("estimateScopeText(estimate)");
    expect(panel).toContain("(reused from an earlier review)");
  });
});

describe("estimate and cost wording with reuse", () => {
  const e = (requests: number, reusedTaskIds: string[]) => ({ requests, reusedTaskIds, tasks: [] as { id: string; inputTokens: number; outputTokens: number; reused: boolean }[] });
  it("says how many requests will be sent and which steps are reused and therefore not in the estimate", () => {
    expect(estimateScopeText(e(13, []))).toBe("13 requests will be sent.");
    expect(estimateScopeText(e(1, []))).toBe("1 request will be sent.");
    const text = estimateScopeText(e(8, ["a1", "a2", "b1", "b2", "b3"]));
    expect(text).toContain("8 requests will be sent.");
    expect(text).toContain("5 finished steps (a1, a2, b1, b2, b3) are reused from an earlier review of this same return and not sent again");
    expect(text).toContain("not in the estimate");
    expect(estimateScopeText(e(12, ["a1"]))).toContain("1 finished step (a1) is reused");
  });
  it("the cost line of a running review counts reused steps as free", () => {
    const ai: AiReviewDto = { ...liveFailure(), status: "running", reusedCount: 5, inputTokens: 1000, outputTokens: 200, costUsdSoFar: 0.03, estimate: null };
    expect(costLine(ai)).toContain("5 finished steps reused from an earlier review (not sent again, no cost)");
    expect(costLine({ ...ai, reusedCount: 0 })).not.toContain("reused");
  });
});
