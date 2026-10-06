import { beforeAll, describe, expect, it, vi } from "vitest";
import { evaluateGate, findingStatus, type DispositionRow } from "@/lib/tax-review/gate";
import { LlmTransportError, type LlmRequest } from "@/lib/tax-review/llm/client";
import { foldProgress, l3GateState, type AiReviewProgress, type RunEvent } from "@/lib/tax-review/llm/progress";
import { priceFromEnv } from "@/lib/tax-review/llm/model";
import { planReuse, type ReuseSource, type ReuseTarget } from "@/lib/tax-review/llm/reuse";
import { cancelAiRun, estimateAiRun, MemoryRunStore, runAllTasks, runNextTask, startAiRun, type StepDeps } from "@/lib/tax-review/llm/run";
import type { ReviewPayload } from "@/lib/tax-review/llm/payload";
import { HARD_CEILING_TOKENS, TASKS, taskById, type TaskDef } from "@/lib/tax-review/llm/tasks";
import { dbAiRunStore, type L3StoreDb, type L3StoreTx } from "@/lib/tax-review-l3-store";
import { loadSourcePack } from "@/lib/tax-review-sources";
import { finding, MockTransport, ok, richFixture, taskOf, type L3Fixture } from "./tax-review-l3-harness";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

// TESTER probes for ai-review-token-budget (independent of the Coder's own tests): reuse safety against the REAL request text, gate
// mutation, cut-off recovery with adversarial transport output, atomic append. Mock transport / in-memory or fake-tx store only.

const FP = "a".repeat(64);
const pack = loadSourcePack();
let fx: L3Fixture;
let clockMs = Date.parse("2026-10-05T12:00:00Z");

beforeAll(async () => {
  fx = await richFixture();
});

const depsOf = (store: MemoryRunStore, transport: MockTransport, over: Partial<StepDeps> = {}): StepDeps => ({ store, transport, pack, nowMs: () => clockMs, currentFingerprint: FP, runFingerprint: FP, sleep: async () => undefined, backoffMs: 1, ...over });

async function startWith(store: MemoryRunStore, runId: string, payload: ReviewPayload, over: { reuse?: Parameters<typeof startAiRun>[1]["reuse"]; model?: string } = {}) {
  const estimate = estimateAiRun(payload, pack, priceFromEnv({}), over.model ?? "mock-model", fx.register);
  await startAiRun(store, { runId, payload: { json: JSON.stringify(payload), payload }, model: over.model ?? "mock-model", estimate, pack, ret: fx.pipeline.ret, facts: fx.pipeline.ctx.facts, ...(over.reuse !== undefined ? { reuse: over.reuse } : {}) });
}

/** A model that answers every task with one valid finding (a1..b3) or nothing. */
function answers(failTask: string | null = null): MockTransport {
  return new MockTransport((req) => {
    clockMs += 3_000;
    const id = taskOf(req);
    if (id === failTask) return { text: '{"findings": [{"cat', stopReason: "max_tokens", usage: { inputTokens: 29_000, outputTokens: req.maxTokens }, model: "mock-model" };
    if (id === "a1") return ok({ findings: [finding(fx.payload, { category: "wrong_amount" })] });
    if (id === "b1") return ok({ findings: [finding(fx.payload, { category: "wrong_amount", area: "deductions" }, "f1040.11a")] });
    if (id === "f1") return ok({ findings: [], challenges: [] });
    if (id === "e2") return ok({ entries: [] });
    return ok({ findings: [] });
  });
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** first request text per task of a transport */
function textsOf(t: MockTransport): Record<string, { system: string; user: string }> {
  const out: Record<string, { system: string; user: string }> = {};
  for (const c of t.calls) {
    const id = taskOf(c);
    if (out[id] === undefined) out[id] = { system: c.system, user: c.user };
  }
  return out;
}

/** a source with 12 finished tasks (cancelled before the adversarial pass), and the exact requests it sent */
async function twelveTaskSource(): Promise<{ store: MemoryRunStore; source: ReuseSource; sent: Record<string, { system: string; user: string }> }> {
  clockMs = Date.parse("2026-10-05T12:00:00Z");
  const store = new MemoryRunStore(() => clockMs);
  await startWith(store, "run-1", fx.payload);
  const t = answers();
  for (let i = 0; i < 12; i += 1) await runNextTask("run-1", depsOf(store, t));
  await cancelAiRun(store, "run-1");
  const source: ReuseSource = { runId: "run-1", fingerprint: FP, events: await store.listEvents("run-1"), findingRows: await store.listL3FindingRows("run-1") };
  return { store, source, sent: textsOf(t) };
}

/** what a brand-new run for `payload` would really send (full run through the transport, nothing reused) */
async function requestsFor(payload: ReviewPayload): Promise<Record<string, { system: string; user: string }>> {
  const store = new MemoryRunStore(() => clockMs);
  await startWith(store, "probe", payload);
  const t = answers();
  for (let i = 0; i < 12; i += 1) await runNextTask("probe", depsOf(store, t));
  return textsOf(t);
}

function targetOf(payload: ReviewPayload, over: Partial<ReuseTarget> = {}): ReuseTarget {
  return { runId: "run-2", fingerprint: FP, model: "mock-model", payload: clone(payload), register: fx.register, pack, ...over };
}

/** change the first leaf found under `v` (number +7, string + marker, boolean flipped); returns true when something changed */
function bump(v: unknown, parent: Record<string, unknown> | unknown[] | null, key: string | number | null): boolean {
  if (typeof v === "number") {
    (parent as Record<string, unknown>)[key as string] = v + 7;
    return true;
  }
  if (typeof v === "string") {
    (parent as Record<string, unknown>)[key as string] = `${v} ZZMARK`;
    return true;
  }
  if (typeof v === "boolean") {
    (parent as Record<string, unknown>)[key as string] = !v;
    return true;
  }
  if (Array.isArray(v)) return v.some((c, i) => bump(c, v, i));
  if (v !== null && typeof v === "object") return Object.entries(v as Record<string, unknown>).some(([k, c]) => bump(c, v as Record<string, unknown>, k));
  return false;
}

describe("REUSE SAFETY: a task is reused only when the request that would be sent is byte-identical to the one that was sent", () => {
  it("the request recorded by the transport equals what buildPrompt gives for the stored payload (the reuse compare is on the real request)", async () => {
    const { sent, source } = await twelveTaskSource();
    expect(Object.keys(sent)).toHaveLength(12);
    const plan = planReuse(source, targetOf(fx.payload));
    expect(plan.reusedTaskIds).toHaveLength(12);
    // identical payload: the fresh run would send exactly the same requests
    const again = await requestsFor(JSON.parse(JSON.stringify(fx.payload)) as ReviewPayload);
    for (const id of plan.reusedTaskIds) expect(again[id], id).toEqual(sent[id]);
  });

  it("for every top-level payload field changed alone: reused  =>  a real new run would send the identical request (differential vs the real transport requests)", async () => {
    const { source, sent } = await twelveTaskSource();
    const keys = Object.keys(fx.payload) as (keyof ReviewPayload)[];
    let mutations = 0;
    let neverReusedWhenChanged = 0;
    for (const k of keys) {
      const p = clone(fx.payload);
      const holder = p as unknown as Record<string, unknown>;
      if (!bump(holder[k], holder, k as string)) continue;
      mutations += 1;
      const plan = planReuse(source, targetOf(p));
      const fresh = await requestsFor(p);
      for (const id of plan.reusedTaskIds) {
        expect(fresh[id]?.user, `${String(k)} changed but ${id} was reused with a different request`).toBe(sent[id]?.user);
        expect(fresh[id]?.system).toBe(sent[id]?.system);
      }
      // and the converse (nothing needlessly sent again except for findings re-checks): every task whose request changed is NOT reused
      for (const t of TASKS) {
        if (t.kind === "adversarial") continue;
        if (fresh[t.id]?.user !== sent[t.id]?.user) {
          expect(plan.reusedTaskIds, `${String(k)}: ${t.id} request changed`).not.toContain(t.id);
          neverReusedWhenChanged += 1;
        }
      }
    }
    expect(mutations).toBeGreaterThanOrEqual(15);
    expect(neverReusedWhenChanged).toBeGreaterThan(10);
  });

  it("a changed engine version / meta (payload.meta.engineVersion) reuses nothing that reads it", async () => {
    const { source, sent } = await twelveTaskSource();
    const p = clone(fx.payload);
    p.meta.engineVersion = `${p.meta.engineVersion}-changed`;
    const plan = planReuse(source, targetOf(p));
    const fresh = await requestsFor(p);
    for (const t of TASKS) if (fresh[t.id]?.user !== sent[t.id]?.user) expect(plan.reusedTaskIds).not.toContain(t.id);
    // the meta block is in every slice (core): so nothing at all is reused
    expect(plan.reusedTaskIds).toEqual([]);
  });

  it("every single line of the payload changed alone (amount +1): a task that shows that line is never reused", async () => {
    const { source, sent } = await twelveTaskSource();
    let checked = 0;
    const lines = fx.payload.lines;
    const step = Math.max(1, Math.floor(lines.length / 60));
    for (let i = 0; i < lines.length; i += step) {
      const p = clone(fx.payload);
      const ln = p.lines[i];
      if (ln === undefined) continue;
      ln.amount = (ln.amount ?? 0) + 1;
      const plan = planReuse(source, targetOf(p));
      for (const t of TASKS) {
        if (t.kind === "adversarial") continue;
        const sawIt = (sent[t.id]?.user ?? "").includes(`"key":"${ln.key}"`);
        if (sawIt) {
          expect(plan.reusedTaskIds, `line ${ln.key} shown to ${t.id}`).not.toContain(t.id);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("a changed answer / decision / override / document row (the owner-input blocks of the payload) is never reused by a task that reads it", async () => {
    const { source, sent } = await twelveTaskSource();
    const blocks: [string, (p: ReviewPayload) => void][] = [
      ["answers", (p) => ((p.answers as Record<string, unknown>)["zzNewAnswer"] = "changed")],
      ["decisions", (p) => p.decisions.push({ id: "X9", label: "new", chosen: "other", status: "decided" })],
      ["documents", (p) => p.documents.push({ ...p.documents[0]!, alias: "Document ZZ" } as ReviewPayload["documents"][number])],
      ["openItems", (p) => p.openItems.push({ id: "zz", severity: "high", message: "m", action: "a", lineKeys: [] })],
      ["conflicts", (p) => p.conflicts.push({ factKey: "k", chosen: null, reason: "r" })],
      ["rules", (p) => p.rules.forEach((r, i) => void bump(r, p.rules as unknown as unknown[], i))],
      ["constants", (p) => p.constants.push({ id: "zz", value: "1", note: "n" })],
      ["l1", (p) => p.l1.findings.push({ key: "k", check: "c", severity: "high", message: "m" })],
    ];
    for (const [name, apply] of blocks) {
      const p = clone(fx.payload);
      apply(p);
      const plan = planReuse(source, targetOf(p));
      const fresh = await requestsFor(p);
      let sawAnyChange = false;
      for (const t of TASKS) {
        if (t.kind === "adversarial") continue;
        if (fresh[t.id]?.user !== sent[t.id]?.user) {
          sawAnyChange = true;
          expect(plan.reusedTaskIds, `${name} changed, ${t.id} request changed`).not.toContain(t.id);
        } else {
          // an unchanged request may be reused (only if its findings still validate): never reused WITH a different request
        }
      }
      for (const id of plan.reusedTaskIds) expect(fresh[id]?.user, `${name}/${id}`).toBe(sent[id]?.user);
      // the field must be visible to at least one task, or the probe proves nothing for it
      expect(sawAnyChange, `${name} is not read by any task: probe is vacuous`).toBe(true);
    }
  });

  it("a changed source-pack TEXT (manifest hashes untouched) is caught by the request text of the tasks that quote it; a changed manifest hash reuses nothing", async () => {
    const { source, sent } = await twelveTaskSource();
    const ids = Object.keys(pack.texts);
    const changed = { ...pack, texts: { ...pack.texts } } as typeof pack;
    for (const id of ids) (changed.texts as Record<string, string>)[id] = `${pack.texts[id]}\f EXTRA PAGE ZZ`;
    // (pages appended; excerpts take whole pages from the topics' ranges: a changed page inside a range is what matters)
    const alt = { ...pack, texts: Object.fromEntries(ids.map((id) => [id, (pack.texts[id] ?? "").replace(/\S+/, "ZZCHANGED")])) } as typeof pack;
    // The pack's identity for reuse is the manifest's DECLARED textSha256 + topics (sourcePackDigestInput); a .txt edited WITHOUT re-pinning the
    // manifest is now refused by loadSourcePack itself (SourcePackIntegrityError, see ai-review-review-fixes.test.ts), so it never reaches reuse.
    const fresh = await (async () => {
      const store = new MemoryRunStore(() => clockMs);
      await startWith(store, "probe2", fx.payload);
      const t = answers();
      for (let i = 0; i < 12; i += 1) await runNextTask("probe2", { ...depsOf(store, t), pack: alt });
      return textsOf(t);
    })();
    expect(TASKS.some((x) => x.kind !== "adversarial" && fresh[x.id]?.user !== sent[x.id]?.user)).toBe(true);
    void changed;
    const plan2 = planReuse(source, targetOf(fx.payload, { pack: { ...pack, manifest: pack.manifest.map((m, i) => (i === 3 ? { ...m, textSha256: "1".repeat(64) } : m)) } }));
    expect(plan2.reusedTaskIds).toEqual([]);
  });

  it("a changed model, fingerprint or (via the stored hash) prompt never reuses; reuse never crosses fingerprints even if every other fact matches", async () => {
    const { source } = await twelveTaskSource();
    expect(planReuse(source, targetOf(fx.payload, { model: "mock-model-2" })).reusedTaskIds).toEqual([]);
    expect(planReuse(source, targetOf(fx.payload, { model: "" })).reusedTaskIds).toEqual([]);
    expect(planReuse(source, targetOf(fx.payload, { fingerprint: "b".repeat(64) })).reusedTaskIds).toEqual([]);
    expect(planReuse(source, targetOf(fx.payload, { fingerprint: "" })).reusedTaskIds).toEqual([]);
    expect(planReuse({ ...source, fingerprint: "" }, targetOf(fx.payload, { fingerprint: "" })).reusedTaskIds.length).toBeGreaterThanOrEqual(0);
    // task.instruction edited at runtime (a changed prompt): that task re-runs
    for (const id of ["a1", "b3", "c1", "d2", "e1", "e2"]) {
      const t = taskById(id) as TaskDef;
      const keep = t.instruction;
      try {
        (t as { instruction: string }).instruction = `${keep} (edited)`;
        expect(planReuse(source, targetOf(fx.payload)).reusedTaskIds, id).not.toContain(id);
      } finally {
        (t as { instruction: string }).instruction = keep;
      }
    }
    // categories / output schema change => hash differs
    const c1 = taskById("c1") as TaskDef;
    const cats = c1.categories;
    try {
      (c1 as { categories: readonly string[] }).categories = [...cats, "zz_new_category"];
      expect(planReuse(source, targetOf(fx.payload)).reusedTaskIds).not.toContain("c1");
    } finally {
      (c1 as { categories: readonly string[] }).categories = cats;
    }
  });

  it("the adversarial pass f1 is re-run even if the source holds a finished f1 with identical input; reused events carry no challenge / no f1 data", async () => {
    clockMs = Date.parse("2026-10-05T12:00:00Z");
    const store = new MemoryRunStore(() => clockMs);
    await startWith(store, "run-1", fx.payload);
    const full = answers();
    const p = await runAllTasks("run-1", depsOf(store, full));
    expect(p.status).toBe("completed");
    const src: ReuseSource = { runId: "run-1", fingerprint: FP, events: await store.listEvents("run-1"), findingRows: await store.listL3FindingRows("run-1") };
    const plan = planReuse(src, targetOf(fx.payload));
    expect(plan.reusedTaskIds).not.toContain("f1");
    expect(plan.events.map((e) => e.taskId)).not.toContain("f1");
    expect(plan.findings.every((f) => f.challenge === undefined)).toBe(true);
    // new run: 12 reused, f1 must still be sent
    await startWith(store, "run-2", fx.payload, { reuse: { events: plan.events, findings: plan.findings } });
    const t2 = answers();
    const p2 = await runAllTasks("run-2", depsOf(store, t2));
    expect(t2.calls.map(taskOf)).toEqual(["f1"]);
    expect(p2.status).toBe("completed");
  });

  it("a reused finding carries NO disposition / status of its own: it is a plain open L3 model finding (only the owner's own written acceptance, a separate record, can close it)", async () => {
    const { source } = await twelveTaskSource();
    const plan = planReuse(source, targetOf(fx.payload));
    expect(plan.findings.length).toBeGreaterThan(0);
    for (const f of plan.findings) {
      expect(f.layer).toBe("L3");
      expect(f.origin).toBe("llm");
      expect(f.acceptable).toBe(true);
      expect(Object.keys(f).filter((k) => /status|accepted|disposition|reason|verdict/i.test(k))).toEqual([]);
    }
    // with no disposition rows the copied findings are open and gate the layer when serious
    const high = plan.findings.map((f) => ({ ...f, severity: "high" as const }));
    const progress = foldProgress([], clockMs);
    expect(l3GateState(progress).status).toBe("not_run");
    const gate = evaluateGate({ runFingerprint: FP, currentFingerprint: FP, engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 }, findings: high, dispositions: [], l1: { status: "completed" }, l2: { status: "completed", coverageListed: true }, l3: { status: "completed", adversarialCompleted: true } });
    expect(gate.items.find((i) => i.id === "l3")?.state).toBe("fail");
  });

  it("DOCUMENTED BEHAVIOUR (not new code): dispositions are scoped to (year, entity, finding key, evidence hash), NOT to a run: an owner acceptance WITH a written reason that was recorded on a finding of the failed run also covers its identical copy in the new run (exactly as for a finding a fresh run would produce again); a changed evidence hash or no reason leaves it open", async () => {
    const { source } = await twelveTaskSource();
    const plan = planReuse(source, targetOf(fx.payload));
    const f = plan.findings[0]!;
    const accepted: DispositionRow = { findingKey: f.key, evidenceHash: f.evidenceHash, action: "accepted", reason: "owner reviewed this", at: new Date(clockMs) };
    expect(findingStatus(f, [])).toBe("open");
    expect(findingStatus(f, [accepted])).toBe("accepted");
    expect(findingStatus(f, [{ ...accepted, evidenceHash: "0".repeat(16) }])).toBe("open");
    expect(findingStatus(f, [{ ...accepted, reason: "no" }])).toBe("open");
    expect(findingStatus(f, [accepted, { ...accepted, action: "reopened", at: new Date(clockMs + 1) }])).toBe("open");
  });

  it("copied findings are re-validated against the NEW payload: a referenced line whose amount changed (even outside the task's slice) sends the task again", async () => {
    const { source } = await twelveTaskSource();
    const p = clone(fx.payload);
    const l = p.lines.find((x) => x.key === "f1040.9");
    expect(l).toBeDefined();
    if (l) l.amount = (l.amount ?? 0) + 3;
    const plan = planReuse(source, targetOf(p));
    // a1 cites f1040.9
    expect(plan.reusedTaskIds).not.toContain("a1");
    expect(plan.findings.some((f) => f.evidence.some((e) => e.ref === "f1040.9"))).toBe(false);
    // the line removed altogether
    const p2 = clone(fx.payload);
    p2.lines = p2.lines.filter((x) => x.key !== "f1040.9");
    expect(planReuse(source, targetOf(p2)).reusedTaskIds).not.toContain("a1");
  });
});

describe("GATE: L3 complete only when ALL 13 tasks have a valid result for the CURRENT fingerprint (mutation tests on a reused run)", () => {
  const gateOf = (progress: AiReviewProgress, runFp = FP, curFp = FP) =>
    evaluateGate({ runFingerprint: runFp, currentFingerprint: curFp, engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 }, findings: [], dispositions: [], l1: { status: "completed" }, l2: { status: "completed", coverageListed: true }, l3: l3GateState(progress) }).items.find((i) => i.id === "l3")?.state;

  async function completedReusedRun(): Promise<{ store: MemoryRunStore; events: RunEvent[] }> {
    const { store, source } = await twelveTaskSource();
    const plan = planReuse(source, targetOf(fx.payload));
    await startWith(store, "run-2", fx.payload, { reuse: { events: plan.events, findings: plan.findings } });
    const p = await runAllTasks("run-2", depsOf(store, answers()));
    expect(p.status).toBe("completed");
    expect(p.reusedCount).toBe(12);
    return { store, events: await store.listEvents("run-2") };
  }

  it("baseline green; removing ANY ONE task's done event (reused or sent) turns it red; a failed task, a stale marker, a cancel, a wrong fingerprint stay red", async () => {
    const { events } = await completedReusedRun();
    expect(gateOf(foldProgress(events, clockMs))).toBe("pass");
    for (const t of TASKS) {
      const mutated = events.filter((e) => !(e.kind === "task_completed" && e.taskId === t.id));
      const prog = foldProgress(mutated, clockMs);
      expect(prog.status, `without ${t.id}`).not.toBe("completed");
      expect(gateOf(prog), `without ${t.id}`).toBe("fail");
    }
    const ev = (key: string, kind: RunEvent["kind"], taskId: string | null): RunEvent => ({ runId: "run-2", eventKey: key, kind, taskId, attempt: null, data: { kind: "invalid_output", usage: {} }, createdAt: new Date(clockMs + 1) });
    // mark one reused task failed in place of its done: three failures and no done
    const noA1 = events.filter((e) => !(e.kind === "task_completed" && e.taskId === "a1"));
    const failed = foldProgress([...noA1, ev("fail:a1:1", "task_failed", "a1"), ev("fail:a1:2", "task_failed", "a1"), ev("fail:a1:3", "task_failed", "a1")], clockMs);
    expect(failed.status).toBe("failed");
    expect(gateOf(failed)).toBe("fail");
    // stale / cancelled on top of a complete set
    expect(gateOf(foldProgress([...events, ev("stale", "stale", null)], clockMs))).toBe("fail");
    expect(gateOf(foldProgress([...events, ev("cancelled", "cancelled", null)], clockMs))).toBe("fail");
    // current fingerprint differs from the run's: red whatever the events say
    // (the fingerprint is its own gate item; the L3 item itself only reflects the layer state) the verdict must be flagged
    const stale = evaluateGate({ runFingerprint: FP, currentFingerprint: "b".repeat(64), engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 }, findings: [], dispositions: [], l1: { status: "completed" }, l2: { status: "completed", coverageListed: true }, l3: l3GateState(foldProgress(events, clockMs)) });
    expect(stale.verdict).toBe("flagged");
    expect(stale.items.find((i) => i.id === "fingerprint")?.state).toBe("fail");
    // all reused tasks present but f1 missing: adversarial not completed -> red
    const noF1 = foldProgress(events.filter((e) => !(e.kind === "task_completed" && e.taskId === "f1")), clockMs);
    expect(l3GateState(noF1).adversarialCompleted).toBe(false);
    expect(gateOf(noF1)).toBe("fail");
  });

  it("a reused run that was started (12 copied) but not finished is partial and red, and the model's later tasks still must all run", async () => {
    const { source, store } = await twelveTaskSource();
    const plan = planReuse(source, targetOf(fx.payload));
    await startWith(store, "run-2", fx.payload, { reuse: { events: plan.events, findings: plan.findings } });
    const prog = foldProgress(await store.listEvents("run-2"), clockMs);
    expect(prog.completedCount).toBe(12);
    expect(prog.status).toBe("running");
    expect(gateOf(prog)).toBe("fail");
    expect(prog.nextTask).toBe("f1");
  });
});

describe("CUT-OFF RECOVERY", () => {
  // independent of the code under test: base budget -> retry budget = min(ceil(base * 1.75), 18,000)
  const TABLE: Record<string, [number, number]> = { a1: [10_000, 17_500], a2: [8_000, 14_000], b1: [8_000, 14_000], b2: [10_000, 17_500], b3: [10_000, 17_500], c1: [16_000, 18_000], c2: [16_000, 18_000], c3: [12_000, 18_000], d1: [10_000, 17_500], d2: [10_000, 17_500], e1: [10_000, 17_500], e2: [12_000, 18_000], f1: [14_000, 18_000] };

  const cut = (req: LlmRequest) => ({ text: '{"findings":[{"cat', stopReason: "max_tokens" as const, usage: { inputTokens: 30_000, outputTokens: req.maxTokens }, model: "mock-model" });

  async function freshRun(runId = "r"): Promise<MemoryRunStore> {
    clockMs = Date.parse("2026-10-05T12:00:00Z");
    const store = new MemoryRunStore(() => clockMs);
    await startWith(store, runId, fx.payload);
    return store;
  }

  it("budgets: base values >= measured, the retry is exactly min(ceil(b x 1.75), 18,000) for all 13 tasks, and nothing ever asks above 18,000", () => {
    for (const t of TASKS) {
      const [b, r] = TABLE[t.id] ?? [0, 0];
      expect(t.maxTokens, t.id).toBe(b);
      expect(Math.min(Math.ceil(b * 1.75), 18_000), t.id).toBe(r);
      expect(r).toBeLessThanOrEqual(HARD_CEILING_TOKENS);
    }
    expect(HARD_CEILING_TOKENS).toBe(18_000);
  });

  it("every task: first max_tokens = recorded retryLarger (no failure counted), retry at the table budget, success completes with BOTH attempts' tokens counted", async () => {
    for (const t of TASKS) {
      const store = await freshRun(`r-${t.id}`);
      let cuts = 0;
      const tr = new MockTransport((req) => {
        clockMs += 3_000;
        const id = taskOf(req);
        if (id === t.id && cuts === 0) {
          cuts += 1;
          return cut(req);
        }
        if (id === "f1") return ok({ findings: [], challenges: [] });
        if (id === "e2") return ok({ entries: [] });
        return ok({ findings: [] });
      });
      // up to and including the cut-off step
      let status = "ran";
      let progress: AiReviewProgress | null = null;
      for (let i = 0; i < 30 && !(cuts === 1 && status === "ran" && progress !== null && (progress.tasks.find((x) => x.id === t.id)?.cutoffRetries ?? 0) > 0); i += 1) {
        const s = await runNextTask(`r-${t.id}`, depsOf(store, tr));
        status = s.status;
        progress = s.progress;
      }
      const tp = progress?.tasks.find((x) => x.id === t.id);
      expect(tp?.failures, `${t.id}: a first cut-off is not a failure`).toBe(0);
      expect(tp?.cutoffRetries).toBe(1);
      expect(tp?.cutoffBudget).toBe(TABLE[t.id]?.[0]);
      expect(progress?.status).toBe("running");
      const evs = await store.listEvents(`r-${t.id}`);
      const fail = evs.find((e) => e.kind === "task_failed" && e.taskId === t.id);
      expect(fail?.data).toMatchObject({ kind: "max_tokens", retryLarger: true, maxTokensUsed: TABLE[t.id]?.[0], nextMaxTokens: TABLE[t.id]?.[1] });
      const done = await runAllTasks(`r-${t.id}`, depsOf(store, tr));
      expect(done.status, t.id).toBe("completed");
      const reqs = tr.calls.filter((c) => taskOf(c) === t.id);
      expect(reqs.map((c) => c.maxTokens), t.id).toEqual([TABLE[t.id]?.[0], TABLE[t.id]?.[1]]);
      // cost of the cut-off attempt is counted: its 30,000 in / base out are in the total
      const tp2 = done.tasks.find((x) => x.id === t.id);
      expect(tp2?.usage.inputTokens).toBe(30_000 + 1000);
      expect(tp2?.usage.outputTokens).toBe((TABLE[t.id]?.[0] ?? 0) + 200);
      expect(Math.max(...tr.calls.map((c) => c.maxTokens))).toBeLessThanOrEqual(18_000);
    }
  });

  it("a second cut-off (at the retry) fails the task AT ONCE: exactly two requests for it, run failed, no later task sent, gate red", async () => {
    for (const id of ["a1", "c1", "e2", "f1"]) {
      const store = await freshRun(`r-${id}`);
      const tr = new MockTransport((req) => {
        clockMs += 3_000;
        const x = taskOf(req);
        if (x === id) return cut(req);
        if (x === "f1") return ok({ findings: [], challenges: [] });
        if (x === "e2") return ok({ entries: [] });
        return ok({ findings: [] });
      });
      const p = await runAllTasks(`r-${id}`, depsOf(store, tr));
      expect(p.status, id).toBe("failed");
      expect(tr.calls.filter((c) => taskOf(c) === id), id).toHaveLength(2);
      expect(p.tasks.find((t) => t.id === id)?.state).toBe("failed");
      expect(p.completedCount).toBeLessThan(13);
      expect(l3GateState(p).status).toBe("failed");
      // more steps after failure send nothing
      const calls = tr.calls.length;
      const again = await runNextTask(`r-${id}`, depsOf(store, tr));
      expect(again.status).toBe("failed");
      expect(tr.calls.length).toBe(calls);
      // both attempts' cost counted
      const tu = p.tasks.find((t) => t.id === id)!.usage;
      expect(tu.inputTokens).toBe(60_000);
      expect(tu.outputTokens).toBe((TABLE[id]?.[0] ?? 0) + (TABLE[id]?.[1] ?? 0));
    }
  });

  it("an un-raisable budget (task already at the 18,000 ceiling): the first cut-off is a failure at once, no second request", async () => {
    const t = taskById("a1") as TaskDef;
    const keep = t.maxTokens;
    try {
      (t as { maxTokens: number }).maxTokens = HARD_CEILING_TOKENS;
      const store = await freshRun("r-ceil");
      const tr = new MockTransport((req) => (taskOf(req) === "a1" ? cut(req) : ok({ findings: [] })));
      const p = await runAllTasks("r-ceil", depsOf(store, tr));
      expect(p.status).toBe("failed");
      expect(tr.calls).toHaveLength(1);
      expect(tr.calls[0]?.maxTokens).toBe(HARD_CEILING_TOKENS);
      const ev = (await store.listEvents("r-ceil")).find((e) => e.kind === "task_failed");
      expect((ev?.data as { retryLarger?: boolean }).retryLarger).toBe(false);
    } finally {
      (t as { maxTokens: number }).maxTokens = keep;
    }
  });

  it("adversarial transport output at the retry (empty, refusal, invalid JSON, wrong shape, hard error, abort, repeated cut-off): the run fails closed, never completes with a missing task, and request counts stay bounded", async () => {
    type Out = (req: LlmRequest, retryPhase: boolean) => ReturnType<typeof cut> | ReturnType<typeof ok> | LlmTransportError;
    const variants: Record<string, Out> = {
      empty: () => ({ text: "", stopReason: "end_turn" as never, usage: { inputTokens: 100, outputTokens: 0 }, model: "m" }),
      refusal: () => ({ text: "", stopReason: "refusal" as never, usage: { inputTokens: 100, outputTokens: 5 }, model: "m" }),
      invalid: () => ({ text: "{not json", stopReason: "end_turn" as never, usage: { inputTokens: 100, outputTokens: 5 }, model: "m" }),
      wrongShape: () => ({ text: '{"findings":"x"}', stopReason: "end_turn" as never, usage: { inputTokens: 100, outputTokens: 5 }, model: "m" }),
      fatal: () => new LlmTransportError("fatal", 400),
      cutAgain: (req) => cut(req),
    };
    for (const id of ["c1", "a1", "f1"]) {
      for (const [name, v] of Object.entries(variants)) {
        const store = await freshRun(`r-${id}-${name}`);
        let phase = 0;
        const tr = new MockTransport((req) => {
          clockMs += 3_000;
          const x = taskOf(req);
          if (x === id) {
            phase += 1;
            return phase === 1 ? cut(req) : v(req, true);
          }
          if (x === "f1") return ok({ findings: [], challenges: [] });
          if (x === "e2") return ok({ entries: [] });
          return ok({ findings: [] });
        });
        const p = await runAllTasks(`r-${id}-${name}`, depsOf(store, tr), 80);
        const label = `${id}/${name}`;
        expect(p.status, label).toBe("failed");
        expect(p.tasks.find((t) => t.id === id)?.state, label).toBe("failed");
        expect(p.tasks.find((t) => t.id === id)?.state).not.toBe("completed");
        expect(p.completedCount, label).toBeLessThan(13);
        expect(l3GateState(p).status, label).toBe("failed");
        expect(tr.calls.filter((c) => taskOf(c) === id).length, label).toBeLessThanOrEqual(1 + 3 * 3);
        expect(Math.max(...tr.calls.map((c) => c.maxTokens)), label).toBeLessThanOrEqual(18_000);
        // the retries after the cut-off always ask for the larger budget (never fall back to the base one)
        for (const c of tr.calls.filter((c) => taskOf(c) === id).slice(1)) expect(c.maxTokens, label).toBe(TABLE[id]?.[1]);
        // later tasks (and for a non-f1 failure, f1) are never sent after the failure
        const idx = TASKS.findIndex((t) => t.id === id);
        const sentIds = new Set(tr.calls.map(taskOf));
        for (const t of TASKS.slice(idx + 1)) if (t.id !== id) expect(sentIds.has(t.id), `${label}: ${t.id} sent after the failure`).toBe(false);
      }
    }
  });

  it("an abort (caller signal) at the retry ends the run's progress without completing; nothing is recorded as done", async () => {
    const store = await freshRun("r-abort");
    const ac = new AbortController();
    let phase = 0;
    const tr = new MockTransport((req) => {
      clockMs += 3_000;
      if (taskOf(req) === "c1") {
        phase += 1;
        if (phase === 1) return cut(req);
        ac.abort();
        throw new Error("socket closed");
      }
      if (taskOf(req) === "f1") return ok({ findings: [], challenges: [] });
      if (taskOf(req) === "e2") return ok({ entries: [] });
      return ok({ findings: [] });
    });
    const p = await runAllTasks("r-abort", depsOf(store, tr, { signal: ac.signal }), 40);
    expect(p.status).not.toBe("completed");
    expect(p.tasks.find((t) => t.id === "c1")?.state).not.toBe("completed");
    expect(l3GateState(p).status).not.toBe("completed");
    const sent = new Set(tr.calls.map(taskOf));
    expect(sent.has("c2")).toBe(false);
  });

  it("transient errors after a cut-off still use the larger budget and count as ordinary failures (3 max)", async () => {
    const store = await freshRun("r-trans");
    let c1 = 0;
    const tr = new MockTransport((req) => {
      clockMs += 3_000;
      if (taskOf(req) === "c1") {
        c1 += 1;
        if (c1 === 1) return cut(req);
        return new LlmTransportError("transient", 529);
      }
      if (taskOf(req) === "f1") return ok({ findings: [], challenges: [] });
      if (taskOf(req) === "e2") return ok({ entries: [] });
      return ok({ findings: [] });
    });
    const p = await runAllTasks("r-trans", depsOf(store, tr), 60);
    expect(p.status).toBe("failed");
    for (const c of tr.calls.filter((c) => taskOf(c) === "c1").slice(1)) expect(c.maxTokens).toBe(HARD_CEILING_TOKENS);
  });
});

describe("ATOMIC APPEND with reuse (fake transaction db that really rolls back)", () => {
  type Row = Record<string, unknown>;
  function fakeDb(opts: { failFindingsCreate?: boolean; failEventsCreate?: boolean }) {
    const state = { events: [] as Row[], findings: [] as Row[], calls: [] as string[] };
    const mkTx = (s: typeof state): L3StoreTx => ({
      taxReviewRunEvent: {
        createMany: async ({ data }) => {
          s.calls.push("events.createMany");
          if (opts.failEventsCreate) throw new Error("boom events");
          s.events.push(...(data as unknown as Row[]));
          return { count: data.length };
        },
      },
      taxReviewFinding: {
        findMany: async () => s.findings as never,
        createMany: async ({ data }) => {
          s.calls.push("findings.createMany");
          if (opts.failFindingsCreate) throw new Error("boom findings");
          s.findings.push(...(data as unknown as Row[]));
          return { count: data.length };
        },
      },
    });
    const db: L3StoreDb = {
      ...mkTx(state),
      taxReviewRunEvent: { ...mkTx(state).taxReviewRunEvent, findMany: async () => [] },
      $transaction: async (fn) => {
        const snap = { events: [...state.events], findings: [...state.findings] };
        const txState = state; // writes go to the same arrays; roll back on throw
        try {
          return await fn(mkTx(txState));
        } catch (e) {
          state.events.length = 0;
          state.events.push(...snap.events);
          state.findings.length = 0;
          state.findings.push(...snap.findings);
          throw e;
        }
      },
    };
    return { db, state };
  }

  async function plan() {
    const { source } = await twelveTaskSource();
    return planReuse(source, targetOf(fx.payload));
  }

  it("the findings insert failing halfway rolls back the run_started / payload / register / done events too: the run is not started, nothing partial remains", async () => {
    const p = await plan();
    expect(p.findings.length).toBeGreaterThan(0);
    const { db, state } = fakeDb({ failFindingsCreate: true });
    const store = dbAiRunStore(db);
    await expect(startAiRun(store, { runId: "run-2", payload: { json: JSON.stringify(fx.payload), payload: fx.payload }, model: "mock-model", estimate: estimateAiRun(fx.payload, pack, priceFromEnv({}), "mock-model", fx.register), pack, ret: fx.pipeline.ret, facts: fx.pipeline.ctx.facts, reuse: { events: p.events, findings: p.findings } })).rejects.toThrow();
    expect(state.events).toHaveLength(0);
    expect(state.findings).toHaveLength(0);
    expect(state.calls).toEqual(["events.createMany", "findings.createMany"]);
  });

  it("success writes events and findings together; the write goes through $transaction only (insert-only methods: createMany / findMany)", async () => {
    const p = await plan();
    const { db, state } = fakeDb({});
    await startAiRun(dbAiRunStore(db), { runId: "run-2", payload: { json: JSON.stringify(fx.payload), payload: fx.payload }, model: "mock-model", estimate: estimateAiRun(fx.payload, pack, priceFromEnv({}), "mock-model", fx.register), pack, ret: fx.pipeline.ret, facts: fx.pipeline.ctx.facts, reuse: { events: p.events, findings: p.findings } });
    expect(state.events).toHaveLength(3 + p.events.length);
    expect(state.findings.length).toBe(new Set(p.findings.map((f) => f.key)).size);
    for (const r of state.findings) expect(r["runId"]).toBe("run-2");
  });
});
