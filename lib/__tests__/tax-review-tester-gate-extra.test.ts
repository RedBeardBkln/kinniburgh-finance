import { describe, expect, it } from "vitest";
import { l3GateState, foldProgress, type RunEvent } from "@/lib/tax-review/llm/progress";
import { insertApproval, type ReviewStoreDb } from "@/lib/tax-review-store";
import { TASK_IDS } from "@/lib/tax-review/llm/tasks";
import { evaluateGate, type GateInput } from "@/lib/tax-review/gate";

// TESTER (reviewer-all): tests added after mutation-testing the approval gate found conditions no test pinned.

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const ev = (kind: RunEvent["kind"], eventKey: string, taskId: string | null, n: number, data: unknown = {}): RunEvent => ({ runId: "r", eventKey, kind, taskId, attempt: null, data, createdAt: new Date(NOW + n * 1000) });

describe("tester: the AI-review state is believed only when EVERY task completed", () => {
  it("f1 (adversarial) completed while the other tasks are pending (forged / reordered events): not completed, red", () => {
    const events = [ev("run_started", "run_started", null, 0, { model: "m" }), ev("task_started", "start:f1:1", "f1", 1), ev("task_completed", "done:f1", "f1", 2, { findingCount: 0, rejected: [] })];
    const p = foldProgress(events, NOW + 60_000);
    expect(p.status).toBe("running");
    const g = l3GateState(p);
    expect(g.status).not.toBe("completed");
    expect(g.adversarialCompleted).toBe(true); // the flag alone is not enough; the layer state must also be completed
    // and the gate item is red for it
    const gate = evaluateGate({ ...baseGate(), l3: g });
    expect(gate.items.find((i) => i.id === "l3")?.state).toBe("fail");
    expect(gate.verdict).toBe("flagged");
  });

  it("every task but one completed: running, red", () => {
    const events: RunEvent[] = [ev("run_started", "run_started", null, 0, { model: "m" })];
    TASK_IDS.slice(1).forEach((t, i) => events.push(ev("task_completed", `done:${t}`, t, i + 1, { findingCount: 0, rejected: [] })));
    const p = foldProgress(events, NOW + 60_000);
    expect(p.completedCount).toBe(TASK_IDS.length - 1);
    expect(l3GateState(p).status).toBe("partial");
  });

  it("all tasks completed: completed (control)", () => {
    const events: RunEvent[] = [ev("run_started", "run_started", null, 0, { model: "m" })];
    TASK_IDS.forEach((t, i) => events.push(ev("task_completed", `done:${t}`, t, i + 1, { findingCount: 0, rejected: [] })));
    const p = foldProgress(events, NOW + 60_000);
    expect(l3GateState(p)).toEqual({ status: "completed", adversarialCompleted: true });
    // a later cancel / stale event turns it red again
    for (const kind of ["cancelled", "stale"] as const) {
      const q = foldProgress([...events, ev(kind, kind, null, 99)], NOW + 60_000);
      expect(l3GateState(q).status).toBe("failed");
    }
  });
});

function baseGate(): GateInput {
  return {
    runFingerprint: "a".repeat(64),
    currentFingerprint: "a".repeat(64),
    engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 },
    findings: [],
    dispositions: [],
    l1: { status: "completed" },
    l2: { status: "completed", coverageListed: true },
    l3: { status: "completed", adversarialCompleted: true },
  };
}

describe("tester: the store refuses an approval for a gate that is not passed (defence in depth below the action)", () => {
  const base = { taxYear: 2025, entityId: "e", kind: "approved" as const, runId: "r", fingerprint: "b".repeat(64), attestationVersion: "v1", attestationTextHash: "c".repeat(64), typedConfirmationHash: "d".repeat(64), reason: null, approvedById: "u", approvedByName: "Eric" };
  const store = (): ReviewStoreDb => ({ taxReturnApproval: { create: async () => ({ id: "x" }) } }) as unknown as ReviewStoreDb;

  it("refuses verdict flagged / missing / null / not an object, and an approval without the attestation hashes", async () => {
    for (const snap of [{ verdict: "flagged" }, {}, null, "passed", 1, { verdict: "PASSED" }, { verdict: ["passed"] }]) {
      await expect(insertApproval({ ...base, verdictSnapshot: snap }, store()), JSON.stringify(snap)).rejects.toThrow();
    }
    await expect(insertApproval({ ...base, verdictSnapshot: { verdict: "passed" }, attestationTextHash: null }, store())).rejects.toThrow();
    await expect(insertApproval({ ...base, verdictSnapshot: { verdict: "passed" }, typedConfirmationHash: null }, store())).rejects.toThrow();
    await expect(insertApproval({ ...base, verdictSnapshot: { verdict: "passed" }, fingerprint: "xyz" }, store())).rejects.toThrow();
    await expect(insertApproval({ ...base, verdictSnapshot: { verdict: "passed" } }, store())).resolves.toEqual({ id: "x" });
  });

  it("a withdrawal needs a reason of 3..500 characters and no identifier-shaped text", async () => {
    const w = { ...base, kind: "withdrawn" as const, verdictSnapshot: {}, attestationVersion: null, attestationTextHash: null, typedConfirmationHash: null };
    await expect(insertApproval({ ...w, reason: "" }, store())).rejects.toThrow();
    await expect(insertApproval({ ...w, reason: "ab" }, store())).rejects.toThrow();
    await expect(insertApproval({ ...w, reason: "x".repeat(501) }, store())).rejects.toThrow();
    await expect(insertApproval({ ...w, reason: "ssn 123-45-6789" }, store())).rejects.toThrow();
    await expect(insertApproval({ ...w, reason: "Starting over." }, store())).resolves.toEqual({ id: "x" });
  });
});

// ── L3 findings with the same key in one run: what the store keeps ───────────────────────────────────────────
import { MemoryRunStore } from "@/lib/tax-review/llm/run";
import { makeFinding } from "@/lib/tax-review/types";

describe("tester: two L3 findings with the same key (same pass, category and line) in one run", () => {
  it("OBSERVATION: the first one stored wins; a later, more serious one with the same key is silently skipped", async () => {
    const base = { layer: "L3" as const, check: "L3.income.other", area: "income" as const, lineKey: "f1040.9" as const, ruleTag: "f1040.9", evidence: [], citation: { sources: [], sourceStatus: "not_applicable" as const }, recommendedAction: "Look at it.", acceptable: true, origin: "llm" as const, pass: "income" as const };
    const low = makeFinding({ ...base, severity: "low", message: "A minor note about the wages line." });
    const high = makeFinding({ ...base, severity: "high", message: "Something serious about the wages line." });
    expect(high.key).toBe(low.key); // same key: severity and message are not part of it
    const store = new MemoryRunStore(() => 0);
    await store.append("r", [{ runId: "r", eventKey: "done:a1", kind: "task_completed", taskId: "a1", attempt: 1, data: {} }], [low]);
    await store.append("r", [{ runId: "r", eventKey: "done:a2", kind: "task_completed", taskId: "a2", attempt: 1, data: {} }], [high]);
    const kept = await store.listL3Findings();
    expect(kept).toHaveLength(1);
    expect(kept[0]?.severity).toBe("low"); // the more serious finding of the second task never reaches the gate
  });
});
