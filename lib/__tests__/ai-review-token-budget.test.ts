import { beforeAll, describe, expect, it, vi } from "vitest";
import { LlmTransportError, runStructured } from "@/lib/tax-review/llm/client";
import { CHARS_PER_TOKEN, estimateRun, priceFromEnv, type TaskEstimate } from "@/lib/tax-review/llm/model";
import { eventKeys, foldProgress, MAX_TASK_ATTEMPTS, type RunEvent } from "@/lib/tax-review/llm/progress";
import { estimateAiRun, MemoryRunStore, runAllTasks, runNextTask, startAiRun, type StepDeps } from "@/lib/tax-review/llm/run";
import { escalatedBudget, HARD_CEILING_TOKENS, promptHash, PROMPT_VERSION, RETRY_FACTOR, retryBudget, SYSTEM_PROMPT, taskById, taskContentHash, taskPromptHash, TASKS, type TaskDef } from "@/lib/tax-review/llm/tasks";
import { findingsOutputSchema } from "@/lib/tax-review/llm/schemas";
import { loadSourcePack } from "@/lib/tax-review-sources";
import { finding, MockTransport, ok, richFixture, scriptedTransport, taskOf, type L3Fixture } from "./tax-review-l3-harness";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Token budgets of the AI review passes (ai-review-token-budget): the live run of 2026-10-05 failed task c1 three times with "the answer
// was cut off" at max_tokens 6,000. These tests pin the new budgets against the measured output sizes, the one retry at a larger budget
// (and that a second cut-off, or a budget at the ceiling, is a failure), the capped prompts and the estimate math. Mock transport only.

const FP = "a".repeat(64);
const pack = loadSourcePack();
let fx: L3Fixture;
let clockMs = Date.parse("2026-10-05T12:00:00Z");

beforeAll(async () => {
  fx = await richFixture();
});

async function newRun() {
  clockMs = Date.parse("2026-10-05T12:00:00Z");
  const store = new MemoryRunStore(() => clockMs);
  const estimate = estimateAiRun(fx.payload, pack, priceFromEnv({}), "mock-model", fx.register);
  await startAiRun(store, { runId: "run-1", payload: { json: fx.serialized.json, payload: fx.payload }, model: "mock-model", estimate, pack, ret: fx.pipeline.ret, facts: fx.pipeline.ctx.facts });
  const deps = (transport: MockTransport): StepDeps => ({ store, transport, pack, nowMs: () => clockMs, currentFingerprint: FP, runFingerprint: FP, sleep: async () => undefined, backoffMs: 1 });
  return { store, deps };
}

const cutOff = (maxTokens: number, usageOut = maxTokens) => ({ text: '{"findings": [{"category": "other", "sev', stopReason: "max_tokens", usage: { inputTokens: 29_000, outputTokens: usageOut }, model: "mock-model" });

const task = (id: string): TaskDef => {
  const t = taskById(id);
  if (t === undefined) throw new Error(`no task ${id}`);
  return t;
};

describe("budgets against what the live run measured", () => {
  // output tokens of the finished tasks of the first live run (events of run f0cf4e7c, 2026-10-05): the budget must leave real headroom
  const MEASURED: Record<string, number> = { a1: 5_795, a2: 2_552, b1: 2_797, b2: 5_936, b3: 4_864 };
  it("every measured task has at least 1.6x its largest measured output as budget (reasoning tokens count against max_tokens)", () => {
    for (const [id, out] of Object.entries(MEASURED)) expect(task(id).maxTokens, id).toBeGreaterThanOrEqual(Math.ceil(out * 1.6));
  });
  it("the form-text tasks that were cut off at 6,000 have far more than that, and the retry is larger still", () => {
    for (const id of ["c1", "c2", "c3"]) {
      expect(task(id).maxTokens, id).toBeGreaterThanOrEqual(12_000);
      expect(retryBudget(task(id)), id).toBeGreaterThan(task(id).maxTokens);
    }
    expect(task("c1").maxTokens).toBe(16_000);
  });
  it("expected output is measured for a1-b3 and never above the budget; no budget is above the hard ceiling", () => {
    for (const [id, out] of Object.entries(MEASURED)) expect(Math.abs(task(id).expectedOutputTokens - out), id).toBeLessThanOrEqual(100);
    for (const t of TASKS) {
      expect(t.expectedOutputTokens, t.id).toBeLessThanOrEqual(t.maxTokens);
      expect(t.maxTokens, t.id).toBeLessThanOrEqual(HARD_CEILING_TOKENS);
      expect(retryBudget(t), t.id).toBeLessThanOrEqual(HARD_CEILING_TOKENS);
    }
  });
  it("the ceiling is far below the model's output limit and bounded by what one serverless call can wait for", () => {
    expect(HARD_CEILING_TOKENS).toBeLessThanOrEqual(32_000);
    // 75 tokens a second (the slowest measured) must still finish inside the 280 s request timeout set by the action, with margin
    // (the exact duration check against the action's timeout is in ai-review-review-fixes.test.ts)
    expect(HARD_CEILING_TOKENS / 75).toBeLessThanOrEqual(250);
  });
  it("escalatedBudget: x1.75, bounded by the ceiling, null at the ceiling", () => {
    expect(RETRY_FACTOR).toBe(1.75);
    expect(escalatedBudget(8_000)).toBe(14_000);
    expect(escalatedBudget(10_000)).toBe(17_500);
    expect(escalatedBudget(16_000)).toBe(HARD_CEILING_TOKENS);
    expect(escalatedBudget(HARD_CEILING_TOKENS - 1)).toBe(HARD_CEILING_TOKENS);
    expect(escalatedBudget(HARD_CEILING_TOKENS)).toBeNull();
    expect(escalatedBudget(HARD_CEILING_TOKENS + 5)).toBeNull();
  });
});

describe("capped prompts", () => {
  const CAPPED = ["c1", "c2", "c3", "d1", "d2", "e1", "e2", "f1"];
  it("the tasks that still have to run say how many findings, how long, and what to do with the rest", () => {
    for (const id of CAPPED) expect(task(id).instruction, id).toMatch(/Length limits/);
    for (const id of ["c1", "c2", "c3", "d1", "d2"]) {
      const i = task(id).instruction;
      expect(i).toMatch(/at most 8 findings/);
      expect(i).toMatch(/report the 7 most important and add ONE final summary finding/);
      expect(i).toMatch(/at most two sentences/);
      expect(i).toMatch(/At most 3 evidence items and at most 1 source/);
    }
    expect(task("e1").instruction).toMatch(/at most 10 findings/);
    expect(task("f1").instruction).toMatch(/at most 10 findings/);
    expect(task("f1").instruction).toMatch(/"challenges": at most 10/);
  });
  it("the system prompt and the prompts of a1, a2, b1, b2, b3 carry no cap text (their finished results stay reusable; see ai-review-reuse.test.ts)", () => {
    for (const id of ["a1", "a2", "b1", "b2", "b3"]) expect(task(id).instruction, id).not.toMatch(/Length limits/);
    expect(SYSTEM_PROMPT).not.toMatch(/Length limits/);
  });
  it("the summary finding the prompt asks for is a valid finding for the validator (low, no evidence)", async () => {
    // the cap text asks for severity "low", category "other", no evidence: it must survive validation like any other finding
    const { deps, store } = await newRun();
    const transport = scriptedTransport((t) => (t === "a1" ? { findings: [finding(fx.payload, { category: "other", severity: "low", form: null, lineKey: null, evidence: [], message: "Three more lines of the same kind look odd on Schedule 1.", recommendedAction: "Compare them with the documents." })] } : undefined));
    await runNextTask("run-1", deps(transport));
    expect((await store.listL3Findings("run-1")).map((f) => f.severity)).toEqual(["low"]);
  });
  it("the prompt hash changes with a budget but the content hash (what is asked) does not", () => {
    const t = task("c1");
    const bigger = { ...t, maxTokens: t.maxTokens + 1 };
    expect(taskPromptHash(bigger)).not.toBe(taskPromptHash(t));
    expect(taskContentHash(bigger)).toBe(taskContentHash(t));
    expect(taskContentHash({ ...t, instruction: `${t.instruction} x` })).not.toBe(taskContentHash(t));
    expect(promptHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(PROMPT_VERSION).toBe("l3-prompts-3"); // ai-payload-fixes: rules added to every request (REVIEW_RULES), instructions unchanged
  });
});

describe("a cut-off answer: one retry at a larger budget, then a failure", () => {
  it("first request cut off, second succeeds at the larger budget: the task completes and the cut-off is not a failure", async () => {
    const { store, deps } = await newRun();
    const t = task("a1");
    const transport = new MockTransport((req, call) => (call === 1 ? cutOff(req.maxTokens) : ok({ findings: [finding(fx.payload, { category: "wrong_amount" })] }, { inputTokens: 29_000, outputTokens: 7_000 })));
    const first = await runNextTask("run-1", deps(transport));
    expect(first).toMatchObject({ status: "ran", task: "a1", ok: false });
    expect(first.status === "ran" && first.progress.tasks.find((x) => x.id === "a1")).toMatchObject({ state: "pending", failures: 0, cutoffRetries: 1, cutoffBudget: t.maxTokens });
    expect(first.progress.status).toBe("running");
    expect(first.progress.nextTask).toBe("a1");
    const failure = store.events.find((e) => e.eventKey === eventKeys.taskFailed("a1", 1));
    expect(failure?.data).toMatchObject({ kind: "max_tokens", retryLarger: true, maxTokensUsed: t.maxTokens, nextMaxTokens: retryBudget(t) });
    const second = await runNextTask("run-1", deps(transport));
    expect(second).toMatchObject({ status: "ran", task: "a1", ok: true });
    expect(transport.calls.map((c) => c.maxTokens)).toEqual([t.maxTokens, retryBudget(t)]);
    const done = store.events.find((e) => e.eventKey === eventKeys.taskDone("a1"));
    expect(done?.data).toMatchObject({ escalated: true, maxTokensUsed: retryBudget(t), findingCount: 1 });
    expect((await store.listL3Findings("run-1")).length).toBe(1);
    const a1 = second.progress.tasks.find((x) => x.id === "a1");
    expect(a1).toMatchObject({ state: "completed", failures: 0, cutoffRetries: 1 });
    // the cut-off attempt cost money and is counted
    expect(a1?.usage).toEqual({ inputTokens: 58_000, outputTokens: t.maxTokens + 7_000 });
    // the next task starts at ITS first budget (the larger one is only for the task that was cut off)
    await runNextTask("run-1", deps(transport));
    expect(transport.calls[2]?.maxTokens).toBe(task("a2").maxTokens);
  });
  it("cut off at the retry too: the task FAILS at once (no third request at the same budget), the run fails closed", async () => {
    const { store, deps } = await newRun();
    const t = task("c1");
    // a1..b3 answer; c1 is always cut off, whatever the budget (the live failure)
    const cutting = new MockTransport((req) => (taskOf(req) === "c1" ? cutOff(req.maxTokens) : ok({ findings: [] })));
    const progress = await runAllTasks("run-1", deps(cutting));
    expect(progress.status).toBe("failed");
    const c1 = progress.tasks.find((x) => x.id === "c1");
    expect(c1).toMatchObject({ state: "failed", failures: 1, cutoffRetries: 1 });
    // exactly two requests for c1: the first budget and ONE retry (the old behaviour was three at the same 6,000)
    expect(cutting.calls.filter((r) => taskOf(r) === "c1").map((r) => r.maxTokens)).toEqual([t.maxTokens, retryBudget(t)]);
    expect(store.events.some((e) => e.eventKey === eventKeys.taskStarted("c1", 3))).toBe(false);
    expect(store.events.find((e) => e.eventKey === eventKeys.taskFailed("c1", 2))?.data).toMatchObject({ kind: "max_tokens", retryLarger: false });
    // nothing after it was sent and a further step does nothing
    expect(cutting.calls.some((r) => ["c2", "c3", "d1", "f1"].includes(taskOf(r)))).toBe(false);
    const callsBefore = cutting.calls.length;
    expect(await runNextTask("run-1", deps(cutting))).toMatchObject({ status: "failed" });
    expect(cutting.calls).toHaveLength(callsBefore);
    // the cost of both attempts is in the usage
    expect(c1?.usage.outputTokens).toBe(t.maxTokens + retryBudget(t));
  });
  it("a budget that is already at the hard ceiling cannot be raised: a cut-off there is a failure without a retry", () => {
    const events: RunEvent[] = [
      { runId: "r", eventKey: "run_started", kind: "run_started", taskId: null, attempt: null, data: { model: "m" }, createdAt: new Date(1) },
      { runId: "r", eventKey: "start:a1:1", kind: "task_started", taskId: "a1", attempt: 1, data: {}, createdAt: new Date(2) },
      // retryLarger false: what runNextTask records when escalatedBudget(budget) is null
      { runId: "r", eventKey: "fail:a1:1", kind: "task_failed", taskId: "a1", attempt: 1, data: { kind: "max_tokens", maxTokensUsed: HARD_CEILING_TOKENS, retryLarger: false, usage: { inputTokens: 1, outputTokens: HARD_CEILING_TOKENS } }, createdAt: new Date(3) },
    ];
    const p = foldProgress(events, 10);
    expect(p.tasks.find((t) => t.id === "a1")).toMatchObject({ state: "failed", failures: 1, cutoffRetries: 0 });
    expect(p.status).toBe("failed");
  });
  it("a failure event from before the retry existed (no retryLarger) ends the task too", () => {
    const events: RunEvent[] = [
      { runId: "r", eventKey: "run_started", kind: "run_started", taskId: null, attempt: null, data: { model: "m" }, createdAt: new Date(1) },
      { runId: "r", eventKey: "fail:c1:1", kind: "task_failed", taskId: "c1", attempt: 1, data: { kind: "max_tokens", usage: { inputTokens: 1, outputTokens: 6000 } }, createdAt: new Date(3) },
    ];
    expect(foldProgress(events, 10).tasks.find((t) => t.id === "c1")?.state).toBe("failed");
  });
  it("a transient error on the retry keeps the larger budget (no second raise) and other tries stay bounded", async () => {
    const { deps } = await newRun();
    let a1Calls = 0;
    const transport = new MockTransport((req) => {
      if (taskOf(req) !== "a1") return ok({ findings: [] });
      a1Calls += 1;
      if (a1Calls === 1) return cutOff(req.maxTokens);
      if (a1Calls <= 4) return new LlmTransportError("transient", 503);
      return ok({ findings: [] });
    });
    const t = task("a1");
    await runNextTask("run-1", deps(transport)); // cut off
    const retried = await runNextTask("run-1", deps(transport)); // three transient failures inside the call, at the larger budget
    expect(retried).toMatchObject({ status: "ran", ok: false });
    expect(transport.calls.map((c) => c.maxTokens).slice(0, 4)).toEqual([t.maxTokens, retryBudget(t), retryBudget(t), retryBudget(t)]);
    const again = await runNextTask("run-1", deps(transport));
    expect(again).toMatchObject({ status: "ran", task: "a1", ok: true });
    expect(transport.calls[4]?.maxTokens).toBe(retryBudget(t));
  });
  it("no request of a whole run ever asks for more than the hard ceiling", async () => {
    const { deps } = await newRun();
    const transport = new MockTransport((req) => cutOff(req.maxTokens));
    await runAllTasks("run-1", deps(transport));
    expect(transport.calls.length).toBeGreaterThan(1);
    for (const c of transport.calls) expect(c.maxTokens).toBeLessThanOrEqual(HARD_CEILING_TOKENS);
  });
  it("runStructured itself still never retries a cut-off at the same budget (the retry is a separate, later step)", async () => {
    let calls = 0;
    const r = await runStructured({
      transport: { send: async () => ((calls += 1), { text: "{", stopReason: "max_tokens", usage: { inputTokens: 5, outputTokens: 9, thinkingTokens: 7 }, model: "m" }) },
      request: { model: "m", system: "s", user: "u", maxTokens: 9 },
      schema: findingsOutputSchema,
    });
    expect(calls).toBe(1);
    expect(r).toMatchObject({ ok: false, kind: "max_tokens", maxTokensUsed: 9, textChars: 1 });
    // the model's reasoning tokens (part of the output tokens) are kept as a diagnostic
    if (!r.ok) expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 9, thinkingTokens: 7 });
  });
  it("the abandoned-attempt bound counts a cut-off retry as its own kind of attempt (it does not eat the three tries)", () => {
    const events: RunEvent[] = [{ runId: "r", eventKey: "run_started", kind: "run_started", taskId: null, attempt: null, data: { model: "m" }, createdAt: new Date(1) }];
    events.push({ runId: "r", eventKey: "start:a1:1", kind: "task_started", taskId: "a1", attempt: 1, data: {}, createdAt: new Date(10) });
    events.push({ runId: "r", eventKey: "fail:a1:1", kind: "task_failed", taskId: "a1", attempt: 1, data: { kind: "max_tokens", maxTokensUsed: 10_000, retryLarger: true, usage: { inputTokens: 1, outputTokens: 1 } }, createdAt: new Date(20) });
    for (let n = 2; n <= MAX_TASK_ATTEMPTS; n += 1) events.push({ runId: "r", eventKey: `start:a1:${n}`, kind: "task_started", taskId: "a1", attempt: n, data: {}, createdAt: new Date(10 * n + 10) });
    const p = foldProgress(events, 10_000_000);
    // 3 starts: one was the answered cut-off, two were abandoned: still within the bound
    expect(p.tasks.find((t) => t.id === "a1")?.state).toBe("pending");
  });
});

describe("estimate math", () => {
  const price = { inPerMtok: 10, outPerMtok: 100, source: "env" as const };
  const row = (taskId: string, over: Partial<TaskEstimate> = {}): TaskEstimate => ({ taskId, inputTokens: 1_000_000, outputTokens: 10_000, maxOutputTokens: 20_000, retryOutputTokens: 30_000, reused: false, ...over });
  it("expected = what will be sent; worst = every full first budget; ceiling = also one cut-off and retry per task (input paid twice)", () => {
    const e = estimateRun([row("a1"), row("a2")], price, "m");
    expect(e.requests).toBe(2);
    expect(e.inputTokens).toBe(2_000_000);
    expect(e.outputTokens).toBe(20_000);
    expect(e.expectedUsd).toBeCloseTo(20 + 2, 6);
    expect(e.worstCaseUsd).toBeCloseTo(20 + 4, 6);
    // ceiling: input 2 x 2,000,000 at $10/M = $40; output (20,000 + 30,000) x 2 at $100/M = $10
    expect(e.maxWithRetryUsd).toBeCloseTo(40 + 10, 6);
    expect(e.maxWithRetryUsd).toBeGreaterThan(e.worstCaseUsd);
    expect(e.reusedTaskIds).toEqual([]);
  });
  it("a reused task is not counted anywhere and is listed", () => {
    const e = estimateRun([row("a1", { reused: true, inputTokens: 0, outputTokens: 0, maxOutputTokens: 0, retryOutputTokens: 0 }), row("a2")], price, "m");
    expect(e.requests).toBe(1);
    expect(e.reusedTaskIds).toEqual(["a1"]);
    expect(e.inputTokens).toBe(1_000_000);
    expect(e.expectedUsd).toBeCloseTo(10 + 1, 6);
    expect(e.worstCaseUsd).toBeCloseTo(10 + 2, 6);
    expect(e.maxWithRetryUsd).toBeCloseTo(20 + 5, 6);
  });
  it("a task whose budget is at the ceiling has no retry: its input is paid once in the ceiling", () => {
    const e = estimateRun([row("a1", { retryOutputTokens: 0 })], price, "m");
    expect(e.maxWithRetryUsd).toBeCloseTo(e.worstCaseUsd, 6);
  });
  it("the $50 warning looks at the worst case (no retry), not at the expectation", () => {
    expect(estimateRun([row("a1", { inputTokens: 6_000_000 })], price, "m").warn).toBe(true);
    expect(estimateRun([row("a1")], price, "m").warn).toBe(false);
  });
  it("the full run on the fixture: 13 requests, calibrated input, expected from the per-task expectations, worst and ceiling ordered", () => {
    const e = estimateAiRun(fx.payload, pack, priceFromEnv({}), "mock-model", fx.register);
    expect(e.requests).toBe(13);
    expect(e.tasks.map((t) => t.maxOutputTokens)).toEqual(TASKS.map((t) => t.maxTokens));
    expect(e.tasks.map((t) => t.retryOutputTokens)).toEqual(TASKS.map((t) => retryBudget(t)));
    expect(e.outputTokens).toBe(TASKS.reduce((n, t) => n + t.expectedOutputTokens, 0));
    expect(e.expectedUsd).toBeLessThan(e.worstCaseUsd);
    expect(e.worstCaseUsd).toBeLessThan(e.maxWithRetryUsd ?? 0);
    expect(e.warn).toBe(e.worstCaseUsd > 50);
  });
  it("the characters-per-token figure is the calibrated one (the 3.5 it replaced under-counted the live input by about 35%)", () => {
    expect(CHARS_PER_TOKEN).toBe(2.4);
    // measured on the live run: a1 est 37,402 at 3.5 vs actual 50,832 input tokens
    const chars = 37_402 * 3.5;
    expect(chars / CHARS_PER_TOKEN).toBeGreaterThanOrEqual(50_832 * 0.95);
    expect(chars / CHARS_PER_TOKEN).toBeLessThanOrEqual(50_832 * 1.15);
  });
});
