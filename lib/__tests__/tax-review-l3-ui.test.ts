import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canResume, checkStart, costLine, ERROR_KIND_LABEL, newerProgress, nextLoopAction, priceBasisText, progressLabel, SEND_NOTICE, TASK_STATE_LABEL } from "@/lib/tax-review/ai-panel";
import { toAiDto, type AiEstimateDto } from "@/lib/tax-review/state";
import { emptyProgress, foldProgress, type RunEvent } from "@/lib/tax-review/llm/progress";
import { findFinalPackageBannedWording, findOwnerBannedWording } from "@/lib/tax-wording";

// The AI review panel, the register and the info cards on the Final review page (ai-return-reviewer, B5). No jsdom in this repo, so the
// UI is pinned by the pure helpers' unit tests plus source checks; interactive behaviour is checked by hand (checklist in 02-implementation-B.md).

const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const code = (p: string): string => read(p).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
const PANEL = "components/tax/review/ai-review-panel.tsx";

const estimate = (over: Partial<AiEstimateDto> = {}): AiEstimateDto => ({ model: "claude-opus-5-5", inputTokens: 400_000, outputTokens: 30_000, expectedUsd: 8.25, worstCaseUsd: 14.5, warn: false, warnThresholdUsd: 50, priceSource: "default_upper_bound", inPerMtok: 15, outPerMtok: 75, maxWithRetryUsd: 30, payloadBytes: 120_000, requests: 13, reusedTaskIds: [], tasks: [], alreadyStarted: false, runId: "r", ...over });

describe("start check", () => {
  it("needs an estimate, the confirmation of what is sent, and (above $50) a second acknowledgement", () => {
    expect(checkStart(null, { understood: true, acceptHighCost: true })).toEqual({ canStart: false, reasons: ["Estimate the cost first."] });
    expect(checkStart(estimate(), { understood: false, acceptHighCost: false }).canStart).toBe(false);
    expect(checkStart(estimate(), { understood: true, acceptHighCost: false })).toEqual({ canStart: true, reasons: [] });
    const high = estimate({ warn: true, expectedUsd: 61 });
    expect(checkStart(high, { understood: true, acceptHighCost: false }).canStart).toBe(false);
    expect(checkStart(high, { understood: true, acceptHighCost: false }).reasons.join(" ")).toMatch(/\$50\.00/);
    expect(checkStart(high, { understood: true, acceptHighCost: true }).canStart).toBe(true);
  });
  it("an existing AI review cannot be started again", () => {
    expect(checkStart(estimate({ alreadyStarted: true }), { understood: true, acceptHighCost: true }).canStart).toBe(false);
  });
});

describe("price basis", () => {
  it("says plainly when the price is an assumption and where the real spending limit lives", () => {
    expect(priceBasisText(estimate())).toMatch(/not a verified price/);
    expect(priceBasisText(estimate())).toMatch(/hard spending limit is the one you set in your Anthropic account/);
    expect(priceBasisText(estimate({ priceSource: "env", inPerMtok: 5, outPerMtok: 25 }))).toMatch(/from this server's settings/);
  });
});

describe("progress text", () => {
  const ev = (key: string, kind: RunEvent["kind"], taskId: string | null, data: unknown, at: number): RunEvent => ({ runId: "r", eventKey: key, kind, taskId, attempt: null, data, createdAt: new Date(at) });
  const started = ev("run_started", "run_started", null, { model: "m", estimate: { expectedUsd: 8.25, worstCaseUsd: 14.5, price: { source: "default_upper_bound", inPerMtok: 15, outPerMtok: 75 }, warn: false, warnThresholdUsd: 50, inputTokens: 1, outputTokens: 1, model: "m", tasks: [] } }, 1);
  it("reads for every state without claiming the return is right", () => {
    expect(progressLabel(toAiDto(emptyProgress()))).toBe("The AI review has not been run.");
    const running = toAiDto(foldProgress([started, ev("start:a1:1", "task_started", "a1", {}, 5), ev("done:a1", "task_completed", "a1", { findingCount: 2, usage: { inputTokens: 1000, outputTokens: 100 } }, 6)], 7));
    expect(progressLabel(running)).toBe("Task 2 of 13.");
    expect(running.completedCount).toBe(1);
    expect(canResume(running)).toBe(true);
    const cancelled = toAiDto(foldProgress([started, ev("cancelled", "cancelled", null, {}, 3)], 4));
    expect(progressLabel(cancelled)).toMatch(/Cancelled.*gate stays red/);
    const stale = toAiDto(foldProgress([started, ev("stale", "stale", null, {}, 3)], 4));
    expect(progressLabel(stale)).toMatch(/Run the checks again/);
    expect(canResume(stale)).toBe(false);
    for (const s of [progressLabel(running), progressLabel(cancelled), progressLabel(stale)]) expect(s).not.toMatch(/correct|approved|passed/i);
  });
  it("shows tokens and cost so far next to the estimate", () => {
    const dto = toAiDto(foldProgress([started, ev("start:a1:1", "task_started", "a1", {}, 5), ev("done:a1", "task_completed", "a1", { findingCount: 0, usage: { inputTokens: 200_000, outputTokens: 20_000 } }, 6)], 7));
    expect(costLine(dto)).toBe("200,000 input and 20,000 output tokens so far; about $4.50 at the price assumption; estimate was $8.25 (up to $14.50)");
  });
  it("the loop continues after a step or a failed task, waits when another tab is running, and stops on anything else", () => {
    expect(nextLoopAction("ran")).toBe("continue");
    expect(nextLoopAction("task_failed")).toBe("continue");
    expect(nextLoopAction("busy")).toBe("wait");
    for (const s of ["done", "stale", "cancelled", "failed", "not_started", "something else"]) expect(nextLoopAction(s)).toBe("stop");
  });
  it("shows whichever copy is further along: this tab's last action result or the refreshed page", () => {
    const dto = (events: RunEvent[], now = 100) => toAiDto(foldProgress(events, now));
    const done = (t: string, at: number) => [ev(`start:${t}:1`, "task_started", t, {}, at), ev(`done:${t}`, "task_completed", t, { findingCount: 0, usage: { inputTokens: 5, outputTokens: 1 } }, at + 1)];
    const none = dto([]);
    const justStarted = dto([started]);
    const one = dto([started, ...done("a1", 5)]);
    const two = dto([started, ...done("a1", 5), ...done("a2", 8)]);
    expect(newerProgress(none, null)).toBe(none);
    expect(newerProgress(none, justStarted)).toBe(justStarted);
    expect(newerProgress(one, two)).toBe(two);
    expect(newerProgress(two, one)).toBe(two);
    const stale = dto([started, ...done("a1", 5), ev("stale", "stale", null, {}, 20)]);
    expect(newerProgress(one, stale)).toBe(stale);
    expect(newerProgress(stale, one)).toBe(stale);
    expect(newerProgress(one, one)).toBe(one);
  });
  it("labels exist for every task state and every failure kind", () => {
    expect(Object.keys(TASK_STATE_LABEL).sort()).toEqual(["completed", "failed", "pending", "running"]);
    for (const k of ["transient", "max_tokens", "refusal", "invalid_output", "aborted", "timeout", "fatal", "unknown"]) expect(ERROR_KIND_LABEL[k]).toBeTruthy();
  });
});

describe("wording of the new surfaces", () => {
  it("passes the owner-wording scan (no CPA outside the honesty statements, no certification claims) and the final-package ban does not apply to the working page", () => {
    const strings = [SEND_NOTICE, priceBasisText(estimate()), progressLabel(toAiDto(emptyProgress())), ...Object.values(ERROR_KIND_LABEL), ...Object.values(TASK_STATE_LABEL)];
    for (const s of strings) expect(findOwnerBannedWording(s), s).toEqual([]);
    expect(findFinalPackageBannedWording("Prepared by Eric Kinniburgh (self-prepared)")).toEqual([]);
  });
  it("the notice says what is removed before anything is sent and that nothing is sent until the owner starts", () => {
    expect(SEND_NOTICE).toMatch(/Taxpayer M/);
    expect(SEND_NOTICE).toMatch(/Taxpayer F/);
    expect(SEND_NOTICE).toMatch(/Household names, street addresses, the names of your own business entities, Social Security numbers and account numbers are removed/); // payer names are covered by tax-review-send-notice.test.ts
    expect(SEND_NOTICE).toMatch(/Nothing is sent until you start/);
  });
});

describe("panel source checks", () => {
  const src = read(PANEL);
  it("is a client component that estimates before it starts, and starts only through the checked button", () => {
    expect(src.startsWith('"use client";')).toBe(true);
    expect(src.indexOf("estimateAiReview(")).toBeGreaterThan(-1);
    expect(src.indexOf("estimateAiReview(")).toBeLessThan(src.indexOf("startAiReview("));
    expect(src).toContain("check.canStart");
    expect(src).toContain("confirm: true");
    expect(src).toContain("disabled={busy || !check.canStart}");
  });
  it("shows the estimate with the price basis, a high-cost warning and the send notice before the start button", () => {
    for (const needle of ["ai-estimate", "ai-price-basis", "ai-high-cost", "SEND_NOTICE", "ai-understood", "ai-accept-cost"]) expect(src).toContain(needle);
    expect(src.indexOf("SEND_NOTICE")).toBeLessThan(src.indexOf("ai-start-button"));
  });
  it("offers resume and cancel, announces progress in a live region, and has a labelled progress bar", () => {
    for (const needle of ["ai-resume-button", "ai-cancel-button", 'aria-live="polite"', 'role="progressbar"', "runNextAiTask(", "cancelAiReview("]) expect(src).toContain(needle);
  });
  it("sends no fingerprint and no gate state, never shows a model's text, and imports nothing server-only", () => {
    const c = code(PANEL);
    expect(c).not.toMatch(/\b(runFingerprint|currentFingerprint|fingerprint|verdict)\s*:/);
    expect(c).not.toMatch(/window\.confirm|\bconfirm\s*\(|window\.alert|\balert\s*\(/);
    expect(c).not.toMatch(/@\/lib\/db|tax-review-l3|tax-review-anthropic|@anthropic-ai|tax-review-sources/);
    expect(c).not.toMatch(/waiv|approve anyway|skip the (check|review)/i);
  });
  it("the register and the info cards are server components with no client state", () => {
    for (const f of ["components/tax/review/register-table.tsx", "components/tax/review/info-cards.tsx"]) expect(read(f), f).not.toMatch(/"use client"/);
    expect(code("components/tax/review/register-table.tsx")).toMatch(/not quantified/);
  });
  it("the page puts the AI panel after the run controls, the register before the honesty panel, and the info cards last", () => {
    const page = read("app/tax/forms/[year]/final-review/page.tsx");
    const order = ["<RunControls", "<AiReviewPanel", "<FindingsTable", "<RegisterTable", "<HonestyPanel", "<ApprovalCard", "<RunHistory", "<ByHandChecklist", "<InfoCards"].map((n) => page.indexOf(n));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page).toContain("export const maxDuration = 300");
    expect(page).toContain("verifyCards(loadSourcePack())");
  });
});
