import { describe, expect, it } from "vitest";
import { foldProgress, type RunEvent } from "@/lib/tax-review/llm/progress";
import { TASK_IDS } from "@/lib/tax-review/llm/tasks";
import type { RegisterEntry } from "@/lib/tax-review/llm/register";
import { buildReviewState, gateInputFor, type RunRowLike } from "@/lib/tax-review/state";
import { makeFinding, type Finding } from "@/lib/tax-review/types";

// How the AI review's state reaches the gate and the page (ai-return-reviewer, B4 / B5): derived from events, never from a client.

const FP = "a".repeat(64);
const ENGINE = { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 };
const APPROVER = { allowed: true, ownerName: "Eric Kinniburgh", reason: null };
const run = (over: Partial<RunRowLike> = {}): RunRowLike => ({ id: "r", fingerprint: FP, engineVersion: "e", startedAt: new Date("2026-10-05T10:00:00Z"), startedByName: "E", l1Summary: { status: "completed", counts: {} }, l2Summary: { status: "completed", coverage: [{ id: "x" }] }, ...over });
const l1 = (): Finding => makeFinding({ layer: "L1", check: "L1.x", severity: "info", area: "process", message: "an information finding", recommendedAction: "nothing to do", acceptable: true });
const l3 = (over: Partial<Parameters<typeof makeFinding>[0]> = {}): Finding => makeFinding({ layer: "L3", check: "L3.income.other", severity: "high", area: "income", message: "Check this line again.", recommendedAction: "Compare with the documents.", acceptable: true, origin: "llm", pass: "income", evidence: [{ ref: "f1040.9", amount: 5, status: "computed" }], ...over });

const ev = (key: string, kind: RunEvent["kind"], taskId: string | null, data: unknown, at: number): RunEvent => ({ runId: "r", eventKey: key, kind, taskId, attempt: null, data, createdAt: new Date(at) });
function allDone(extra: Record<string, unknown> = {}): RunEvent[] {
  const events: RunEvent[] = [ev("run_started", "run_started", null, { model: "m" }, 1)];
  TASK_IDS.forEach((t, i) => {
    events.push(ev(`start:${t}:1`, "task_started", t, {}, 10 + i * 2));
    events.push(ev(`done:${t}`, "task_completed", t, { findingCount: 0, usage: { inputTokens: 10, outputTokens: 1 }, ...(t === "f1" ? { challenges: extra["challenges"] ?? [] } : {}), ...(t === "e2" && extra["register"] !== undefined ? { register: extra["register"] } : {}) }, 11 + i * 2));
  });
  return events;
}
const state = (events: RunEvent[] | null, findings: Finding[] = [l1()], currentFingerprint = FP, register: RegisterEntry[] = []) =>
  buildReviewState({ currentFingerprint, engine: ENGINE, latest: { run: run(), findings }, runs: [run()], dispositions: [], approvals: [], approver: APPROVER, ai: events === null ? null : foldProgress(events, 1_000_000), register });
const item = (s: ReturnType<typeof state>, id: string) => s.gate.items.find((i) => i.id === id);

describe("gateInputFor", () => {
  it("L3 is not_run unless a state derived from events is passed (no waiver, no default)", () => {
    expect(gateInputFor({ run: run(), findings: [], dispositions: [], currentFingerprint: FP, engine: ENGINE }).l3).toEqual({ status: "not_run", adversarialCompleted: false });
    expect(gateInputFor({ run: null, findings: [], dispositions: [], currentFingerprint: FP, engine: ENGINE, l3: { status: "completed", adversarialCompleted: true } }).l3.status).toBe("not_run");
    expect(gateInputFor({ run: run(), findings: [], dispositions: [], currentFingerprint: FP, engine: ENGINE, l3: { status: "completed", adversarialCompleted: true } }).l3).toEqual({ status: "completed", adversarialCompleted: true });
  });
});

describe("buildReviewState with an AI review", () => {
  it("no events: not run, gate red, approval impossible", () => {
    const s = state(null);
    expect(item(s, "l3")?.state).toBe("not_run");
    expect(s.ai.status).toBe("not_run");
    expect(s.gate.verdict).toBe("flagged");
    expect(s.canApproveNow).toBe(false);
  });
  it("a finished review with no open L3 finding makes the L3 item green; L2 is the other layer the stub run leaves red or green on its own", () => {
    const s = state(allDone());
    expect(item(s, "l3")?.state).toBe("pass");
    expect(s.ai).toMatchObject({ status: "completed", completedCount: 13, totalCount: 13 });
    expect(s.gate.verdict).toBe("passed");
  });
  it("an open L3 high finding keeps the gate red even when every task completed", () => {
    const s = state(allDone(), [l1(), l3()]);
    expect(item(s, "l3")?.state).toBe("fail");
    expect(s.gate.verdict).toBe("flagged");
    expect(s.totals.gatingOpen).toBe(1);
  });
  it("a partial, failed, cancelled or stale review is red", () => {
    const partial = allDone().slice(0, 9);
    expect(item(state(partial), "l3")?.state).toBe("fail");
    const cancelled = [...allDone(), ev("cancelled", "cancelled", null, {}, 999)];
    expect(item(state(cancelled), "l3")?.state).toBe("fail");
    const stale = [...allDone(), ev("stale", "stale", null, {}, 999)];
    expect(item(state(stale), "l3")?.state).toBe("fail");
    // the adversarial pass missing is red even if the rest completed
    const noAdversarial = allDone().filter((e) => e.taskId !== "f1");
    expect(item(state(noAdversarial), "l3")?.state).toBe("fail");
  });
  it("a review for an older return fails the fingerprint item whatever its tasks say", () => {
    const s = state(allDone(), [l1()], "b".repeat(64));
    expect(item(s, "fingerprint")?.state).toBe("fail");
    expect(s.gate.verdict).toBe("flagged");
  });
  it("the adversarial note is attached to the finding it names and changes nothing about it", () => {
    const f = l3();
    const s = state(allDone({ challenges: [{ findingKey: f.key, note: "The line was already checked against the W-2." }] }), [l1(), f]);
    const dto = s.findings.find((x) => x.key === f.key);
    expect(dto?.challenge).toBe("The line was already checked against the W-2.");
    expect(dto?.status).toBe("open");
    expect(dto?.gating).toBe(true);
    expect(s.findings.find((x) => x.layer === "L1")?.challenge ?? null).toBeNull();
  });
  it("the register is the narrated one when task e2 completed, else the engine's own; the page DTO is JSON-safe", () => {
    const entry = (text: string, narrated: boolean): RegisterEntry => ({ id: "decision:X1", topic: "t", origin: "decision", recommendedPosition: text, alternative: null, rationale: null, sources: [], dollarImpact: { amountDollars: null, note: "not quantified" }, whoDecides: "Eric", status: "undecided", narrated, where: "w" });
    const plain = state(null, [l1()], FP, [entry("engine text", false)]);
    expect(plain.register[0]?.recommendedPosition).toBe("engine text");
    expect(plain.registerNarrated).toBe(false);
    const narrated = state(allDone({ register: [entry("narrated text", true)] }), [l1()], FP, [entry("engine text", false)]);
    expect(narrated.register[0]?.recommendedPosition).toBe("narrated text");
    expect(narrated.registerNarrated).toBe(true);
    expect(JSON.parse(JSON.stringify(narrated))).toEqual(narrated);
  });
  it("the client DTO has task states, tokens and the estimate but no payload, prompt or model text", () => {
    const s = state(allDone());
    expect(Object.keys(s.ai).sort()).toEqual(["busy", "completedCount", "costUsdSoFar", "estimate", "inputTokens", "model", "nextTask", "outputTokens", "promptVersion", "status", "tasks", "totalCount"]);
    expect(Object.keys(s.ai.tasks[0] ?? {}).sort()).toEqual(["attempts", "errorKind", "failures", "findingCount", "id", "inputTokens", "outputTokens", "pass", "rejectedCount", "state", "title", "unverifiedCount"]);
  });
});
