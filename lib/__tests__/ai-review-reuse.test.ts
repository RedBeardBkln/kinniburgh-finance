import { beforeAll, describe, expect, it, vi } from "vitest";
import { evaluateGate } from "@/lib/tax-review/gate";
import { eventKeys, foldProgress, l3GateState, type RunEvent } from "@/lib/tax-review/llm/progress";
import { estimateWithReuse, LEGACY_PROMPTS_1, NO_REUSE, pickReuseSource, planReuse, reusedFindingProblem, type ReuseSource, type ReuseTarget } from "@/lib/tax-review/llm/reuse";
import { priceFromEnv } from "@/lib/tax-review/llm/model";
import { cancelAiRun, estimateAiRun, MemoryRunStore, runAllTasks, runNextTask, startAiRun, type StepDeps } from "@/lib/tax-review/llm/run";
import { indexPayload, type ReviewPayload } from "@/lib/tax-review/llm/payload";
import { sourcePackDigestInput } from "@/lib/tax-review/llm/sources";
import { retryBudget, SYSTEM_PROMPT, taskById, taskContentHash, TASKS, type TaskDef } from "@/lib/tax-review/llm/tasks";
import { sha256Hex, type Finding } from "@/lib/tax-review/types";
import { loadSourcePack } from "@/lib/tax-review-sources";
import { finding, MockTransport, ok, richFixture, taskOf, type L3Fixture } from "./tax-review-l3-harness";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Reuse of finished AI review tasks (ai-review-token-budget): a new review of the SAME return state, model, prompts and input copies the
// finished tasks of the latest failed / cancelled review instead of paying for them again. Mock transport and in-memory store only.

const FP = "a".repeat(64);
const pack = loadSourcePack();
let fx: L3Fixture;
let clockMs = Date.parse("2026-10-05T12:00:00Z");

beforeAll(async () => {
  fx = await richFixture();
});

const task = (id: string): TaskDef => {
  const t = taskById(id);
  if (t === undefined) throw new Error(`no task ${id}`);
  return t;
};

const cutOff = (maxTokens: number) => ({ text: '{"findings": [{"category": "oth', stopReason: "max_tokens", usage: { inputTokens: 29_000, outputTokens: maxTokens }, model: "mock-model" });

async function startRun(store: MemoryRunStore, runId: string, over: { reuse?: Parameters<typeof startAiRun>[1]["reuse"]; model?: string; estimate?: ReturnType<typeof estimateAiRun> } = {}) {
  const estimate = over.estimate ?? estimateAiRun(fx.payload, pack, priceFromEnv({}), "mock-model", fx.register);
  await startAiRun(store, { runId, payload: { json: fx.serialized.json, payload: fx.payload }, model: over.model ?? "mock-model", estimate, pack, ret: fx.pipeline.ret, facts: fx.pipeline.ctx.facts, ...(over.reuse !== undefined ? { reuse: over.reuse } : {}) });
}

const depsOf = (store: MemoryRunStore, transport: MockTransport, over: Partial<StepDeps> = {}): StepDeps => ({ store, transport, pack, nowMs: () => clockMs, currentFingerprint: FP, runFingerprint: FP, sleep: async () => undefined, backoffMs: 1, ...over });

/** What the model says in a run: a1, a2, b1, b2 each add one finding; every other task finds nothing. c1 is cut off at any budget. */
function answers(failTask: string | null): MockTransport {
  return new MockTransport((req) => {
    // each request takes a few seconds, as it does for real: the stored events and finding rows are seconds apart
    clockMs += 3_000;
    const id = taskOf(req);
    if (id === failTask) return cutOff(req.maxTokens);
    if (id === "a1") return ok({ findings: [finding(fx.payload, { category: "wrong_amount" })] });
    if (id === "a2") return ok({ findings: [finding(fx.payload, { category: "other", message: "Interest on the return should be compared with the 1099 rows." })] });
    if (id === "b1") return ok({ findings: [finding(fx.payload, { category: "wrong_amount", area: "deductions" }, "f1040.11a")] });
    if (id === "b2") return ok({ findings: [finding(fx.payload, { category: "eligibility", area: "deductions", message: "Check the eligibility conditions for the special deduction." }, "f1040.11a")] });
    if (id === "f1") return ok({ findings: [], challenges: [] });
    if (id === "e2") return ok({ entries: [] });
    return ok({ findings: [] });
  });
}

/** The first run: a1 a2 b1 b2 b3 finish (4 findings), c1 is cut off twice (the live failure) and the run fails closed. */
async function failedSourceStore(): Promise<MemoryRunStore> {
  clockMs = Date.parse("2026-10-05T12:00:00Z");
  const store = new MemoryRunStore(() => clockMs);
  await startRun(store, "run-1");
  const progress = await runAllTasks("run-1", depsOf(store, answers("c1")));
  expect(progress.status).toBe("failed");
  expect(progress.completedCount).toBe(5);
  return store;
}

async function sourceOf(store: MemoryRunStore, runId: string, over: Partial<ReuseSource> = {}): Promise<ReuseSource> {
  return { runId, fingerprint: FP, events: await store.listEvents(runId), findingRows: await store.listL3FindingRows(runId), ...over };
}

function targetOf(over: Partial<ReuseTarget> = {}): ReuseTarget {
  return { runId: "run-2", fingerprint: FP, model: "mock-model", payload: JSON.parse(fx.serialized.json) as ReviewPayload, register: fx.register, pack, ...over };
}

const reasons = (plan: ReturnType<typeof planReuse>): Record<string, string | null> => Object.fromEntries(plan.decisions.map((d) => [d.taskId, d.reason]));

function gateOf(progress: ReturnType<typeof foldProgress>, findings: Finding[] = []) {
  return evaluateGate({ runFingerprint: FP, currentFingerprint: FP, engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 }, findings, dispositions: [], l1: { status: "completed" }, l2: { status: "completed", coverageListed: true }, l3: l3GateState(progress) });
}

describe("a new review of the same return reuses the finished tasks of the failed one", () => {
  it("sends only the tasks that are not finished, copies the five results and their findings, costs nothing for them, and completes", async () => {
    const store = await failedSourceStore();
    const original = await store.listL3Findings("run-1");
    expect(original).toHaveLength(4);
    const eventsBefore = (await store.listEvents("run-1")).length;

    const plan = planReuse(await sourceOf(store, "run-1"), targetOf());
    expect(plan.sourceRunId).toBe("run-1");
    expect(plan.reusedTaskIds).toEqual(["a1", "a2", "b1", "b2", "b3"]);
    expect(reasons(plan)).toMatchObject({ a1: null, b3: null, c1: "not_finished", c2: "not_finished", f1: "adversarial_pass" });
    expect(plan.findings.map((f) => f.key).sort()).toEqual(original.map((f) => f.key).sort());

    await startRun(store, "run-2", { reuse: { events: plan.events, findings: plan.findings } });
    const afterStart = foldProgress(await store.listEvents("run-2"), clockMs);
    expect(afterStart).toMatchObject({ status: "running", completedCount: 5, reusedCount: 5, nextTask: "c1" });
    expect(afterStart.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

    const transport = answers(null);
    const progress = await runAllTasks("run-2", depsOf(store, transport));
    // only the other eight tasks were sent; none of the five reused ones
    expect(transport.calls.map(taskOf)).toEqual(["c1", "c2", "c3", "d1", "d2", "e1", "e2", "f1"]);
    expect(progress).toMatchObject({ status: "completed", completedCount: 13, reusedCount: 5 });
    // usage and cost are only what this run really sent: 8 requests of (1000 in, 200 out)
    expect(progress.usage).toEqual({ inputTokens: 8_000, outputTokens: 1_600 });
    expect(progress.tasks.filter((t) => t.reused).map((t) => t.id)).toEqual(["a1", "a2", "b1", "b2", "b3"]);
    expect(progress.tasks.find((t) => t.id === "a1")).toMatchObject({ findingCount: 1, attempts: 0, state: "completed" });
    // the findings of the reused tasks are rows of the NEW run, same keys and evidence hashes, and the old run is untouched
    const copied = await store.listL3Findings("run-2");
    expect(copied.map((f) => f.key).sort()).toEqual(original.map((f) => f.key).sort());
    expect(copied.map((f) => f.evidenceHash).sort()).toEqual(original.map((f) => f.evidenceHash).sort());
    expect(await store.listL3Findings("run-1")).toEqual(original);
    expect((await store.listEvents("run-1")).length).toBe(eventsBefore);
    const rows1 = await store.listL3FindingRows("run-1");
    const rows2 = await store.listL3FindingRows("run-2");
    expect(rows2.every((r) => !rows1.some((o) => o.finding === r.finding))).toBe(true);
    // the model can still only ADD findings: every copied row is a model finding the owner can accept, nothing else
    expect(copied.every((f) => f.layer === "L3" && f.origin === "llm" && f.acceptable)).toBe(true);
  });
  it("the copied event says it is reused, where from, and what it cost the earlier run", async () => {
    const store = await failedSourceStore();
    const plan = planReuse(await sourceOf(store, "run-1"), targetOf());
    const a1 = plan.events.find((e) => e.taskId === "a1");
    expect(a1).toMatchObject({ runId: "run-2", eventKey: eventKeys.taskDone("a1"), kind: "task_completed" });
    expect(a1?.data).toMatchObject({ reused: true, reusedFromRunId: "run-1", usage: { inputTokens: 0, outputTokens: 0 }, originalUsage: { inputTokens: 1000, outputTokens: 200 }, findingCount: 1 });
    expect((a1?.data as { contentHash: string }).contentHash).toBe(taskContentHash(task("a1")));
  });
  it("a cancelled review is a source too (the three tasks it finished are reused)", async () => {
    clockMs = Date.parse("2026-10-05T12:00:00Z");
    const store = new MemoryRunStore(() => clockMs);
    await startRun(store, "run-1");
    const t = answers(null);
    for (let i = 0; i < 3; i += 1) await runNextTask("run-1", depsOf(store, t));
    await cancelAiRun(store, "run-1");
    expect(foldProgress(await store.listEvents("run-1"), clockMs).status).toBe("cancelled");
    expect(pickReuseSource([{ runId: "run-1", events: await store.listEvents("run-1") }], clockMs)).toBe("run-1");
    expect(planReuse(await sourceOf(store, "run-1"), targetOf()).reusedTaskIds).toEqual(["a1", "a2", "b1"]);
  });
  it("chains: a review that reused tasks and failed again is itself a source for the next one", async () => {
    const store = await failedSourceStore();
    const plan = planReuse(await sourceOf(store, "run-1"), targetOf());
    await startRun(store, "run-2", { reuse: { events: plan.events, findings: plan.findings } });
    // run-2 gets further (c1, c2 and c3 finish) and then d1 is cut off twice
    const t2 = answers("d1");
    const p2 = await runAllTasks("run-2", depsOf(store, t2));
    expect(p2.status).toBe("failed");
    expect(p2.completedCount).toBe(8);
    const plan3 = planReuse(await sourceOf(store, "run-2"), targetOf({ runId: "run-3" }));
    expect(plan3.reusedTaskIds).toEqual(["a1", "a2", "b1", "b2", "b3", "c1", "c2", "c3"]);
    // the findings of the five copied tasks come along through run-2's own rows
    expect(plan3.findings.map((f) => f.key).sort()).toEqual((await store.listL3Findings("run-2")).map((f) => f.key).sort());
  });
});

describe("never reused when anything that decided the result differs", () => {
  it("a different return state (fingerprint)", async () => {
    const store = await failedSourceStore();
    const plan = planReuse(await sourceOf(store, "run-1"), targetOf({ fingerprint: "b".repeat(64) }));
    expect(plan.reusedTaskIds).toEqual([]);
    expect(plan.events).toEqual([]);
    expect(plan.findings).toEqual([]);
    expect(Object.values(reasons(plan)).every((r) => r === "fingerprint_differs")).toBe(true);
  });
  it("a different model", async () => {
    const store = await failedSourceStore();
    const plan = planReuse(await sourceOf(store, "run-1"), targetOf({ model: "another-model" }));
    expect(plan.reusedTaskIds).toEqual([]);
    expect(Object.values(reasons(plan)).every((r) => r === "model_differs")).toBe(true);
  });
  it("a different source pack", async () => {
    const store = await failedSourceStore();
    const other = { ...pack, manifest: pack.manifest.map((s, i) => (i === 0 ? { ...s, textSha256: "0".repeat(64) } : s)) };
    expect(sha256Hex(sourcePackDigestInput(other))).not.toBe(sha256Hex(sourcePackDigestInput(pack)));
    const plan = planReuse(await sourceOf(store, "run-1"), targetOf({ pack: other }));
    expect(plan.reusedTaskIds).toEqual([]);
    expect(Object.values(reasons(plan)).every((r) => r === "source_pack_differs")).toBe(true);
  });
  it("a different prompt: a task whose text changed since the earlier run is sent again, the others are still reused", async () => {
    const store = await failedSourceStore();
    const t = task("a1");
    const original = t.instruction;
    try {
      (t as { instruction: string }).instruction = `${original} Also look at the tip income.`;
      const plan = planReuse(await sourceOf(store, "run-1"), targetOf());
      expect(reasons(plan).a1).toBe("prompt_differs");
      expect(plan.reusedTaskIds).toEqual(["a2", "b1", "b2", "b3"]);
    } finally {
      (t as { instruction: string }).instruction = original;
    }
    expect(planReuse(await sourceOf(store, "run-1"), targetOf()).reusedTaskIds).toContain("a1");
  });
  it("a different system prompt changes every content hash: nothing is reused", async () => {
    const store = await failedSourceStore();
    const source = await sourceOf(store, "run-1");
    // the earlier run stored hashes made under another system prompt
    const tampered = source.events.map((e) => (e.kind === "task_completed" ? { ...e, data: { ...(e.data as object), contentHash: sha256Hex(`other|${e.taskId}`) } } : e));
    const plan = planReuse({ ...source, events: tampered }, targetOf());
    expect(plan.reusedTaskIds).toEqual([]);
    expect(reasons(plan).a1).toBe("prompt_differs");
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });
  it("a different input: only the tasks whose slice of the payload changed are sent again", async () => {
    const store = await failedSourceStore();
    const payload = structuredClone(fx.payload);
    const income = payload.income as Record<string, unknown>;
    // a1 and a2 read income.interest; b1, b2 and b3 do not
    income["interest"] = [...(Array.isArray(income["interest"]) ? (income["interest"] as unknown[]) : []), { changed: true }];
    const plan = planReuse(await sourceOf(store, "run-1"), targetOf({ payload }));
    expect(reasons(plan)).toMatchObject({ a1: "input_differs", a2: "input_differs", b1: null, b2: null, b3: null });
    expect(plan.reusedTaskIds).toEqual(["b1", "b2", "b3"]);
    // only the findings of the tasks that are reused travel with them
    expect(plan.findings.every((f) => f.pass === "deductions")).toBe(true);
  });
  it("the earlier run's payload is missing: nothing is reused", async () => {
    const store = await failedSourceStore();
    const source = await sourceOf(store, "run-1");
    const plan = planReuse({ ...source, events: source.events.filter((e) => e.kind !== "payload") }, targetOf());
    expect(plan.reusedTaskIds).toEqual([]);
    expect(Object.values(reasons(plan)).every((r) => r === "earlier_payload_missing")).toBe(true);
  });
  it("no earlier review at all", () => {
    const plan = planReuse(null, targetOf());
    expect(plan.reusedTaskIds).toEqual([]);
    expect(Object.values(reasons(plan)).every((r) => r === "no_earlier_review")).toBe(true);
    expect(NO_REUSE.events).toEqual([]);
  });
  it("the adversarial pass is never copied, even from a source that finished it", async () => {
    clockMs = Date.parse("2026-10-05T12:00:00Z");
    const store = new MemoryRunStore(() => clockMs);
    await startRun(store, "run-1");
    await runAllTasks("run-1", depsOf(store, answers(null)));
    const plan = planReuse(await sourceOf(store, "run-1"), targetOf());
    expect(reasons(plan).f1).toBe("adversarial_pass");
    expect(plan.reusedTaskIds).not.toContain("f1");
    expect(plan.reusedTaskIds).toHaveLength(12);
  });
});

describe("which earlier review is the source", () => {
  const ev = (key: string, kind: RunEvent["kind"], taskId: string | null, data: unknown, at: number): RunEvent => ({ runId: "r", eventKey: key, kind, taskId, attempt: null, data, createdAt: new Date(at) });
  const started = (): RunEvent => ev("run_started", "run_started", null, { model: "m" }, 1);
  it("the newest failed or cancelled review of the list; completed, running and never-started ones are skipped", () => {
    const failed = [started(), ev("fail:a1:1", "task_failed", "a1", { kind: "max_tokens", usage: {} }, 5)];
    const cancelled = [started(), ev("cancelled", "cancelled", null, {}, 5)];
    const running = [started()];
    const none: RunEvent[] = [];
    const candidates = [
      { runId: "never", events: none },
      { runId: "running", events: running },
      { runId: "cancelled", events: cancelled },
      { runId: "failed", events: failed },
    ];
    expect(pickReuseSource(candidates, 10)).toBe("cancelled");
    expect(pickReuseSource(candidates.filter((c) => c.runId !== "cancelled"), 10)).toBe("failed");
    expect(pickReuseSource([candidates[0]!, candidates[1]!], 10)).toBeNull();
  });
  it("a finished review is not a source", async () => {
    clockMs = Date.parse("2026-10-05T12:00:00Z");
    const store = new MemoryRunStore(() => clockMs);
    await startRun(store, "run-1");
    await runAllTasks("run-1", depsOf(store, answers(null)));
    expect(pickReuseSource([{ runId: "run-1", events: await store.listEvents("run-1") }], clockMs)).toBeNull();
  });
});

describe("reviews stored before the content hash and the finding keys were recorded (l3-prompts-1)", () => {
  /** What the first live run stored: the run's prompt hash, per-task promptHash = sha256(task|run hash), no contentHash, no findingKeys. */
  async function legacyStore(): Promise<{ store: MemoryRunStore; source: ReuseSource }> {
    const store = await failedSourceStore();
    const source = await sourceOf(store, "run-1");
    const events = source.events.map((e): RunEvent => {
      if (e.kind === "run_started") return { ...e, data: { ...(e.data as object), promptHash: LEGACY_PROMPTS_1.runPromptHash } };
      if (e.kind === "task_completed") {
        const { contentHash: _c, findingKeys: _k, ...rest } = e.data as Record<string, unknown>;
        void _c;
        void _k;
        return { ...e, data: { ...rest, promptHash: sha256Hex(`${e.taskId}|${LEGACY_PROMPTS_1.runPromptHash}`) } };
      }
      return e;
    });
    return { store, source: { ...source, events } };
  }
  it("the text of a1, a2, b1, b2, b3 is exactly what l3-prompts-1 sent (the pinned hashes still match)", () => {
    for (const [id, hash] of Object.entries(LEGACY_PROMPTS_1.contentHashes)) expect(taskContentHash(task(id)), id).toBe(hash);
    expect(Object.keys(LEGACY_PROMPTS_1.contentHashes)).toEqual(["a1", "a2", "b1", "b2", "b3"]);
  });
  it("their finished tasks are reused: findings are attributed to the task whose done event they follow, and the counts agree", async () => {
    const { source } = await legacyStore();
    const plan = planReuse(source, targetOf());
    expect(plan.reusedTaskIds).toEqual(["a1", "a2", "b1", "b2", "b3"]);
    expect(plan.decisions.filter((d) => d.reused).map((d) => d.findingCount)).toEqual([1, 1, 1, 1, 0]);
  });
  it("a task whose finding count cannot be matched is sent again", async () => {
    const { source } = await legacyStore();
    const events = source.events.map((e) => (e.eventKey === eventKeys.taskDone("b1") ? { ...e, data: { ...(e.data as object), findingCount: 2 } } : e));
    const plan = planReuse({ ...source, events }, targetOf());
    expect(reasons(plan).b1).toBe("findings_missing");
    expect(plan.reusedTaskIds).toEqual(["a1", "a2", "b2", "b3"]);
  });
  it("a run with another prompt hash, or a task event with a hash that is not that run's, is not reused", async () => {
    const { source } = await legacyStore();
    const otherRun = source.events.map((e) => (e.kind === "run_started" ? { ...e, data: { ...(e.data as object), promptHash: "f".repeat(64) } } : e));
    expect(planReuse({ ...source, events: otherRun }, targetOf()).reusedTaskIds).toEqual([]);
    const otherTask = source.events.map((e) => (e.eventKey === eventKeys.taskDone("a2") ? { ...e, data: { ...(e.data as object), promptHash: "e".repeat(64) } } : e));
    const plan = planReuse({ ...source, events: otherTask }, targetOf());
    expect(reasons(plan).a2).toBe("prompt_differs");
    expect(plan.reusedTaskIds).toEqual(["a1", "b1", "b2", "b3"]);
  });
  it("a task of a legacy run that is not in the pinned list (its text may have changed) is never reused", async () => {
    const { source } = await legacyStore();
    const events = source.events.concat([{ runId: "run-1", eventKey: eventKeys.taskDone("c1"), kind: "task_completed", taskId: "c1", attempt: 1, data: { findingCount: 0, promptHash: sha256Hex(`c1|${LEGACY_PROMPTS_1.runPromptHash}`), usage: { inputTokens: 1, outputTokens: 1 } }, createdAt: new Date(clockMs + 99_000) }]);
    expect(reasons(planReuse({ ...source, events }, targetOf())).c1).toBe("prompt_differs");
  });
});

describe("the copied findings pass the code checks again against the NEW payload", () => {
  async function rowsWith(change: (f: Finding) => Finding, which: string): Promise<{ source: ReuseSource }> {
    const store = await failedSourceStore();
    const source = await sourceOf(store, "run-1");
    const findingRows = source.findingRows.map((r) => (r.finding.check.endsWith(which) ? { ...r, finding: change(r.finding) } : r));
    return { source: { ...source, findingRows } };
  }
  it("an evidence amount that no longer equals the payload's: that task is sent again", async () => {
    const { source } = await rowsWith((f) => ({ ...f, evidence: f.evidence.map((e) => ({ ...e, amount: (e.amount ?? 0) + 1 })) }), "income.wrong_amount");
    const plan = planReuse(source, targetOf());
    expect(reasons(plan).a1).toBe("findings_invalid");
    expect(plan.reusedTaskIds).toEqual(["a2", "b1", "b2", "b3"]);
    expect(plan.findings.some((f) => f.check === "L3.income.wrong_amount")).toBe(false);
  });
  it("a finding on a line the new payload does not have", async () => {
    const { source } = await rowsWith((f) => ({ ...f, lineKey: "f1040.999" as Finding["lineKey"] }), "income.wrong_amount");
    expect(reasons(planReuse(source, targetOf())).a1).toBe("findings_invalid");
  });
  it("a finding that is not an acceptable model finding, or carries another layer, origin or pass", async () => {
    const t1 = task("a1");
    const index = indexPayload(JSON.parse(fx.serialized.json) as ReviewPayload);
    const store = await failedSourceStore();
    const good = (await store.listL3FindingRows("run-1")).find((r) => r.finding.check === "L3.income.wrong_amount")?.finding;
    if (good === undefined) throw new Error("no finding");
    expect(reusedFindingProblem(good, t1, index)).toBeNull();
    expect(reusedFindingProblem({ ...good, acceptable: false }, t1, index)).toBe("layer_origin_acceptable");
    expect(reusedFindingProblem({ ...good, origin: "deterministic" }, t1, index)).toBe("layer_origin_acceptable");
    expect(reusedFindingProblem({ ...good, layer: "L1" }, t1, index)).toBe("layer_origin_acceptable");
    expect(reusedFindingProblem({ ...good, pass: "deductions" }, t1, index)).toBe("pass");
    expect(reusedFindingProblem({ ...good, challenge: "a note" }, t1, index)).toBe("challenge");
    expect(reusedFindingProblem({ ...good, message: "Call 123-45-6789 about it." }, t1, index)).toBe("identifier_text");
  });
  it("a finding key a task lists that the earlier run does not hold: sent again", async () => {
    const store = await failedSourceStore();
    const source = await sourceOf(store, "run-1");
    const events = source.events.map((e) => (e.eventKey === eventKeys.taskDone("a1") ? { ...e, data: { ...(e.data as object), findingKeys: ["0123456789abcdef"] } } : e));
    expect(reasons(planReuse({ ...source, events }, targetOf())).a1).toBe("findings_missing");
  });
});

describe("insert-only and gate rules", () => {
  it("planning never changes the earlier run (its events and rows are frozen in this test)", async () => {
    const store = await failedSourceStore();
    const source = await sourceOf(store, "run-1");
    const deepFreeze = <T>(v: T): T => {
      if (v !== null && typeof v === "object") {
        Object.freeze(v);
        for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
      }
      return v;
    };
    deepFreeze(source);
    expect(() => planReuse(source, targetOf())).not.toThrow();
  });
  it("starting the new run with reused results is one atomic append and idempotent: a second start writes nothing", async () => {
    const store = await failedSourceStore();
    const plan = planReuse(await sourceOf(store, "run-1"), targetOf());
    await startRun(store, "run-2", { reuse: { events: plan.events, findings: plan.findings } });
    const events = (await store.listEvents("run-2")).length;
    const rows = (await store.listL3FindingRows("run-2")).length;
    expect(events).toBe(3 + 5);
    expect(rows).toBe(4);
    await startRun(store, "run-2", { reuse: { events: plan.events, findings: plan.findings } });
    expect((await store.listEvents("run-2")).length).toBe(events);
    expect((await store.listL3FindingRows("run-2")).length).toBe(rows);
  });
  it("L3 is complete for the gate only when ALL 13 tasks have a valid result: five reused tasks are 'partial', and a stale fingerprint stops the new run", async () => {
    const store = await failedSourceStore();
    const plan = planReuse(await sourceOf(store, "run-1"), targetOf());
    await startRun(store, "run-2", { reuse: { events: plan.events, findings: plan.findings } });
    const partial = foldProgress(await store.listEvents("run-2"), clockMs);
    expect(l3GateState(partial).status).toBe("partial");
    expect(gateOf(partial).items.find((i) => i.id === "l3")?.state).toBe("fail");
    // the return changed since: nothing is sent, the run is stale, the gate stays red
    const idle = answers(null);
    const stale = await runNextTask("run-2", depsOf(store, idle, { currentFingerprint: "c".repeat(64), runFingerprint: FP }));
    expect(stale.status).toBe("stale");
    expect(idle.calls).toHaveLength(0);
    expect(gateOf(foldProgress(await store.listEvents("run-2"), clockMs)).items.find((i) => i.id === "l3")?.state).toBe("fail");
    // a complete run with reused tasks is green with no findings open: the code decides, as for a run that sent everything
    const store2 = await failedSourceStore();
    const plan2 = planReuse(await sourceOf(store2, "run-1"), targetOf());
    await startRun(store2, "run-2", { reuse: { events: plan2.events, findings: [] } });
    const done = await runAllTasks("run-2", depsOf(store2, answers(null)));
    expect(done.status).toBe("completed");
    expect(gateOf(done).items.find((i) => i.id === "l3")?.state).toBe("pass");
    // and with the copied findings open (an unverified high one would block too), the gate sees them as findings of the run
    const openHigh = (await store2.listL3Findings("run-1")).map((f) => ({ ...f, severity: "high" as const }));
    expect(gateOf(done, openHigh).items.find((i) => i.id === "l3")?.state).toBe("fail");
  });
});

describe("the estimate with reuse counts only the tasks that will be sent", () => {
  it("13 requests without reuse; 8 with five reused; the reused ones cost nothing and are listed", async () => {
    const store = await failedSourceStore();
    const plan = planReuse(await sourceOf(store, "run-1"), targetOf());
    const full = estimateAiRun(fx.payload, pack, priceFromEnv({}), "mock-model", fx.register);
    const prep = { serialized: { payload: fx.payload }, pack, estimate: full, model: "mock-model", register: fx.register };
    const withReuse = estimateWithReuse(prep, plan);
    expect(full.requests).toBe(13);
    expect(withReuse.requests).toBe(8);
    expect(withReuse.reusedTaskIds).toEqual(["a1", "a2", "b1", "b2", "b3"]);
    const sent = TASKS.filter((t) => !["a1", "a2", "b1", "b2", "b3"].includes(t.id));
    expect(withReuse.outputTokens).toBe(sent.reduce((n, t) => n + t.expectedOutputTokens, 0));
    const reusedRows = withReuse.tasks.filter((t) => t.reused);
    expect(reusedRows).toHaveLength(5);
    expect(reusedRows.every((t) => t.inputTokens === 0 && t.outputTokens === 0 && t.maxOutputTokens === 0 && t.retryOutputTokens === 0)).toBe(true);
    // totals are the sum over the tasks that are sent, and equal the full estimate minus the five
    expect(withReuse.inputTokens).toBe(full.tasks.filter((t) => sent.some((s) => s.id === t.taskId)).reduce((n, t) => n + t.inputTokens, 0));
    expect(withReuse.expectedUsd).toBeLessThan(full.expectedUsd);
    expect(withReuse.worstCaseUsd).toBeLessThan(full.worstCaseUsd);
    expect(withReuse.maxWithRetryUsd ?? 0).toBeLessThan(full.maxWithRetryUsd ?? 0);
    expect(withReuse.worstCaseUsd).toBeCloseTo(
      full.tasks.filter((t) => sent.some((s) => s.id === t.taskId)).reduce((n, t) => n + (t.inputTokens / 1e6) * 15 + (t.maxOutputTokens / 1e6) * 75, 0),
      6
    );
    expect(sent.map((t) => retryBudget(t))).toEqual(withReuse.tasks.filter((t) => !t.reused).map((t) => t.retryOutputTokens));
    // nothing reused: the full estimate comes back unchanged
    expect(estimateWithReuse(prep, NO_REUSE)).toBe(full);
  });
  it("the estimate stored with the run says which steps are reused", async () => {
    const store = await failedSourceStore();
    const plan = planReuse(await sourceOf(store, "run-1"), targetOf());
    const estimate = estimateWithReuse({ serialized: { payload: fx.payload }, pack, estimate: estimateAiRun(fx.payload, pack, priceFromEnv({}), "mock-model", fx.register), model: "mock-model", register: fx.register }, plan);
    await startRun(store, "run-2", { estimate, reuse: { events: plan.events, findings: plan.findings } });
    const p = foldProgress(await store.listEvents("run-2"), clockMs);
    expect(p.estimate?.reusedTaskIds).toEqual(["a1", "a2", "b1", "b2", "b3"]);
    expect(p.estimate?.requests).toBe(8);
  });
});
