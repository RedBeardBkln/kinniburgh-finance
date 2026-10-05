import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The read-only lookup of the run to reuse from (lib/tax-review-l3-reuse.ts): newest earlier run of the SAME fingerprint whose AI review failed
// or was cancelled, never the target run itself, bounded look-back, and any read failure means "reuse nothing".

vi.mock("@/lib/db", () => ({ db: {} }));
const storeMock = vi.hoisted(() => ({ listRunsForFingerprint: vi.fn() }));
vi.mock("@/lib/tax-review-store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tax-review-store")>()), ...storeMock }));

import { loadReusePlan, type ReuseLookup } from "@/lib/tax-review-l3-reuse";
import { priceFromEnv } from "@/lib/tax-review/llm/model";
import { cancelAiRun, estimateAiRun, MemoryRunStore, runAllTasks, runNextTask, startAiRun, type StepDeps } from "@/lib/tax-review/llm/run";
import { loadSourcePack } from "@/lib/tax-review-sources";
import { finding, MockTransport, ok, richFixture, taskOf, type L3Fixture } from "./tax-review-l3-harness";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const FP = "a".repeat(64);
const pack = loadSourcePack();
let fx: L3Fixture;
let clockMs = Date.parse("2026-10-05T12:00:00Z");
let store: MemoryRunStore;

beforeAll(async () => {
  fx = await richFixture();
});

beforeEach(() => {
  clockMs = Date.parse("2026-10-05T12:00:00Z");
  store = new MemoryRunStore(() => clockMs);
  storeMock.listRunsForFingerprint.mockReset();
});

const lookup = (over: Partial<ReuseLookup> = {}): ReuseLookup => ({ entityId: "ent", fingerprint: FP, model: "mock-model", payloadJson: fx.serialized.json, register: fx.register, pack, ...over });
const row = (id: string, fingerprint = FP) => ({ id, taxYear: 2025, entityId: "ent", fingerprint, engineVersion: "e", startedById: null, startedByName: "x", startedAt: new Date(), config: {}, l1Summary: {}, l2Summary: {} });
const deps = (transport: MockTransport): StepDeps => ({ store, transport, pack, nowMs: () => clockMs, currentFingerprint: FP, runFingerprint: FP, sleep: async () => undefined, backoffMs: 1 });

async function start(runId: string) {
  await startAiRun(store, { runId, payload: { json: fx.serialized.json, payload: fx.payload }, model: "mock-model", estimate: estimateAiRun(fx.payload, pack, priceFromEnv({}), "mock-model", fx.register), pack, ret: fx.pipeline.ret, facts: fx.pipeline.ctx.facts });
}

const transport = (failTask: string | null) =>
  new MockTransport((req) => {
    clockMs += 3_000;
    const id = taskOf(req);
    if (id === failTask) return { text: "{", stopReason: "max_tokens", usage: { inputTokens: 1, outputTokens: req.maxTokens }, model: "mock-model" };
    if (id === "a1") return ok({ findings: [finding(fx.payload, { category: "wrong_amount" })] });
    if (id === "f1") return ok({ findings: [], challenges: [] });
    if (id === "e2") return ok({ entries: [] });
    return ok({ findings: [] });
  });

/** A review that failed at `failTask` after finishing every task before it. */
async function failedRun(runId: string, failTask = "c1") {
  await start(runId);
  await runAllTasks(runId, deps(transport(failTask)));
}

describe("loadReusePlan", () => {
  it("asks only for runs of this return state (year, entity, fingerprint) and picks the newest failed one", async () => {
    await failedRun("old-failed", "c1");
    await failedRun("newer-failed", "c2");
    storeMock.listRunsForFingerprint.mockResolvedValue([row("target"), row("newer-failed"), row("old-failed")]);
    await start("target");
    const plan = await loadReusePlan(lookup(), 2025, "target", store, clockMs);
    expect(storeMock.listRunsForFingerprint).toHaveBeenCalledWith(2025, "ent", FP);
    expect(plan.sourceRunId).toBe("newer-failed");
    // the newest failed run got one task further (c1 finished before c2 failed)
    expect(plan.reusedTaskIds).toEqual(["a1", "a2", "b1", "b2", "b3", "c1"]);
  });
  it("never the target run itself, and a finished or running review is skipped", async () => {
    await failedRun("failed", "c1");
    await start("running-one");
    await runNextTask("running-one", deps(transport(null)));
    await start("target");
    storeMock.listRunsForFingerprint.mockResolvedValue([row("target"), row("running-one"), row("failed")]);
    const plan = await loadReusePlan(lookup(), 2025, "target", store, clockMs);
    expect(plan.sourceRunId).toBe("failed");
    // with only the target and the running review there is nothing to reuse
    storeMock.listRunsForFingerprint.mockResolvedValue([row("target"), row("running-one")]);
    expect((await loadReusePlan(lookup(), 2025, "target", store, clockMs)).reusedTaskIds).toEqual([]);
  });
  it("a cancelled review is a source", async () => {
    await start("cancelled-one");
    for (let i = 0; i < 2; i += 1) await runNextTask("cancelled-one", deps(transport(null)));
    await cancelAiRun(store, "cancelled-one");
    storeMock.listRunsForFingerprint.mockResolvedValue([row("target"), row("cancelled-one")]);
    expect((await loadReusePlan(lookup(), 2025, "target", store, clockMs)).reusedTaskIds).toEqual(["a1", "a2"]);
  });
  it("a run of another fingerprint that slipped into the list is still refused by the plan (defence in depth)", async () => {
    await failedRun("failed", "c1");
    storeMock.listRunsForFingerprint.mockResolvedValue([row("target"), row("failed", "b".repeat(64))]);
    const plan = await loadReusePlan(lookup(), 2025, "target", store, clockMs);
    expect(plan.reusedTaskIds).toEqual([]);
    expect(plan.decisions.every((d) => d.reason === "fingerprint_differs")).toBe(true);
  });
  it("only the 10 newest earlier runs are looked at", async () => {
    await failedRun("old-failed", "c1");
    const filler = Array.from({ length: 10 }, (_, i) => row(`empty-${i}`));
    storeMock.listRunsForFingerprint.mockResolvedValue([row("target"), ...filler, row("old-failed")]);
    expect((await loadReusePlan(lookup(), 2025, "target", store, clockMs)).reusedTaskIds).toEqual([]);
    storeMock.listRunsForFingerprint.mockResolvedValue([row("target"), ...filler.slice(0, 9), row("old-failed")]);
    expect((await loadReusePlan(lookup(), 2025, "target", store, clockMs)).reusedTaskIds.length).toBe(5);
  });
  it("another model or another payload: nothing is reused", async () => {
    await failedRun("failed", "c1");
    storeMock.listRunsForFingerprint.mockResolvedValue([row("target"), row("failed")]);
    expect((await loadReusePlan(lookup({ model: "other" }), 2025, "target", store, clockMs)).reusedTaskIds).toEqual([]);
    const changed = JSON.parse(fx.serialized.json) as { income: Record<string, unknown> };
    changed.income["interest"] = [{ changed: true }];
    const plan = await loadReusePlan(lookup({ payloadJson: JSON.stringify(changed) }), 2025, "target", store, clockMs);
    expect(plan.decisions.find((d) => d.taskId === "a1")?.reason).toBe("input_differs");
  });
  it("a read failure means 'reuse nothing' and logs only the error class", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    storeMock.listRunsForFingerprint.mockRejectedValue(new TypeError("secret payload text 123-45-6789"));
    const plan = await loadReusePlan(lookup(), 2025, "target", store, clockMs);
    expect(plan.reusedTaskIds).toEqual([]);
    expect(plan.sourceRunId).toBeNull();
    expect(JSON.stringify(spy.mock.calls)).toMatch(/TypeError/);
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret|123-45/);
    spy.mockRestore();
  });
  it("writes nothing: the store only gets reads", async () => {
    await failedRun("failed", "c1");
    const append = vi.spyOn(store, "append");
    storeMock.listRunsForFingerprint.mockResolvedValue([row("target"), row("failed")]);
    await loadReusePlan(lookup(), 2025, "target", store, clockMs);
    expect(append).not.toHaveBeenCalled();
  });
});
