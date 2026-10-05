import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateGate, type GateInput } from "@/lib/tax-review/gate";
import { foldProgress, l3GateState, type RunEvent } from "@/lib/tax-review/llm/progress";
import { TASK_IDS } from "@/lib/tax-review/llm/tasks";

// Reuse of finished AI review tasks must not change anything about approval (ai-review-token-budget): the gate, the approver and the
// fingerprint files are not touched, they know nothing about reuse, and a run made of reused tasks is green for L3 only on exactly
// the conditions of a run that sent every task: all 13 tasks have a valid result AND the run is for the current fingerprint.

const read = (p: string): string => readFileSync(resolve(__dirname, "../..", p), "utf8").replace(/\r\n/g, "\n");

describe("the gate, the approver and the fingerprint do not know about reuse", () => {
  for (const file of ["lib/tax-review/gate.ts", "lib/tax-review/approver.ts", "lib/tax-review/fingerprint.ts"]) {
    it(`${file} has no reference to reuse, cut-off retries or the output budgets`, () => {
      const src = read(file);
      expect(src).not.toMatch(/reuse|reused|cutoff|maxTokens|llm\/run|llm\/reuse/i);
    });
  }
  it("approval, attestation and revocation code do not import the reuse modules", () => {
    for (const file of ["lib/tax-review-approval-facts.ts", "lib/tax-review-approval-lookup.ts", "lib/tax-review/gate.ts"]) expect(read(file), file).not.toMatch(/llm\/reuse|tax-review-l3-reuse/);
  });
  it("the reuse code only ADDS: it never writes a disposition, an approval or a finding of another layer", () => {
    const src = read("lib/tax-review/llm/reuse.ts") + read("lib/tax-review-l3-reuse.ts");
    expect(src).not.toMatch(/insertDisposition|insertApproval|approveReturn|acceptFinding|taxReviewApproval|taxReviewFindingDisposition/);
    expect(read("lib/tax-review-l3-reuse.ts")).not.toMatch(/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(|\$executeRaw|\$queryRaw/);
  });
});

describe("L3 for the gate with reused tasks", () => {
  const ev = (key: string, kind: RunEvent["kind"], taskId: string | null, data: unknown, at: number): RunEvent => ({ runId: "r", eventKey: key, kind, taskId, attempt: null, data, createdAt: new Date(at) });
  const events = (completed: readonly string[]): RunEvent[] => [
    ev("run_started", "run_started", null, { model: "m" }, 1),
    ...completed.map((id, i) => ev(`done:${id}`, "task_completed", id, { findingCount: 0, reused: true, usage: { inputTokens: 0, outputTokens: 0 } }, 10 + i)),
  ];
  const input = (progress: ReturnType<typeof foldProgress>, over: Partial<GateInput> = {}): GateInput => ({
    runFingerprint: "a".repeat(64),
    currentFingerprint: "a".repeat(64),
    engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 },
    findings: [],
    dispositions: [],
    l1: { status: "completed" },
    l2: { status: "completed", coverageListed: true },
    l3: l3GateState(progress),
    ...over,
  });

  it("every one of the 13 tasks reused: complete, and the gate is green exactly like a run that sent them", () => {
    const p = foldProgress(events(TASK_IDS), 1000);
    expect(p).toMatchObject({ status: "completed", completedCount: 13, reusedCount: 13 });
    const gate = evaluateGate(input(p));
    expect(gate.items.find((i) => i.id === "l3")?.state).toBe("pass");
    expect(gate.verdict).toBe("passed");
  });
  it("12 of 13 (the adversarial pass missing) is partial and red: a reused result never stands in for a task that has no result", () => {
    const p = foldProgress(events(TASK_IDS.filter((t) => t !== "f1")), 1000);
    expect(p.status).toBe("running");
    expect(p.completedCount).toBe(12);
    const gate = evaluateGate(input(p));
    expect(gate.items.find((i) => i.id === "l3")?.state).toBe("fail");
    expect(gate.verdict).toBe("flagged");
    expect(p.nextTask).toBe("f1");
  });
  it("an event for a task id that is not one of the 13 changes nothing", () => {
    const p = foldProgress([...events(TASK_IDS.filter((t) => t !== "f1")), ev("done:zz", "task_completed", "zz", { reused: true }, 99)], 1000);
    expect(p.completedCount).toBe(12);
    expect(p.status).toBe("running");
  });
  it("complete but for ANOTHER return state (stale fingerprint): the gate is red whatever was reused", () => {
    const p = foldProgress(events(TASK_IDS), 1000);
    const gate = evaluateGate(input(p, { runFingerprint: "a".repeat(64), currentFingerprint: "b".repeat(64) }));
    expect(gate.items.find((i) => i.id === "fingerprint")?.state).toBe("fail");
    expect(gate.verdict).not.toBe("passed");
  });
  it("a cancelled or stale run is red even when every task was reused", () => {
    for (const closing of [ev("cancelled", "cancelled", null, {}, 500), ev("stale", "stale", null, {}, 500)]) {
      const p = foldProgress([...events(TASK_IDS), closing], 1000);
      expect(l3GateState(p).status).toBe("failed");
      expect(evaluateGate(input(p)).verdict).not.toBe("passed");
    }
  });
  it("the AI review items stay owner-only and the model-finding rules stay in the validator: reused rows are L3 findings that gate like any other", () => {
    expect(read("actions/tax-review.ts")).toMatch(/const access = await aiAccess\(user\.id, year\);/);
    expect(read("actions/tax-review.ts")).toContain("owner only: the AI review spends the owner's API credit");
  });
});
