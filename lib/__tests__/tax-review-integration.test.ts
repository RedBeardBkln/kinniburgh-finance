import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// INTEGRATION of the reviewer's three layers (ai-return-reviewer, reviewer-all): L1 + L2 (the deterministic run the action stores), the AI
// review passes (L3, run through the real orchestrator and the real events store), the dispositions and the gate, all read back through
// the REAL store functions and the REAL state builder. Only the boundaries are replaced: the session, the database (an in-memory fake with
// the exact delegate calls the stores make, including the unique (runId, eventKey) rule and transaction rollback), the return loaders
// (the pipelines are the harness's synthetic returns, not Eric's) and the model transport (scripted, no live call).
//
// What this pins: once L2 and the AI passes have COMPLETED for the CURRENT fingerprint and every gating finding is dispositioned, the
// gate is PASSED and canApproveNow is true (the all-green path); and each way of not getting there leaves it red.

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ── in-memory database: exactly the calls the review stores make ──────────────────────────────────────────
const fake = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const t = { run: [] as Row[], finding: [] as Row[], disposition: [] as Row[], approval: [] as Row[], event: [] as Row[] };
  let n = 0;
  const id = (): string => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`;
  // far in the past and strictly increasing: orders rows, and never falls inside the "same run within 15 s" window
  const stamp = (): Date => new Date(Date.UTC(2026, 0, 1) + n * 1000);
  const dupErr = (): Error => Object.assign(new Error("unique constraint"), { code: "P2002" });
  const db = {
    taxReviewRun: {
      create: async ({ data }: { data: Row }) => {
        const row = { ...data, id: id(), startedAt: stamp() };
        t.run.push(row);
        return row;
      },
      findMany: async ({ where, take }: { where: { taxYear: number; entityId: string }; take?: number }) =>
        t.run
          .filter((r) => r["taxYear"] === where.taxYear && r["entityId"] === where.entityId)
          .slice()
          .reverse()
          .slice(0, take ?? 100),
      findFirst: async ({ where }: { where: { id: string; entityId?: string } }) => t.run.find((r) => r["id"] === where.id && (where.entityId === undefined || r["entityId"] === where.entityId)) ?? null,
    },
    taxReviewFinding: {
      createMany: async ({ data }: { data: Row[] }) => {
        for (const d of data) t.finding.push({ ...d, id: id(), createdAt: stamp() });
        return { count: data.length };
      },
      findMany: async ({ where, select }: { where: { runId: string; layer?: string }; select?: { key: true } }) => {
        const rows = t.finding.filter((f) => f["runId"] === where.runId && (where.layer === undefined || f["layer"] === where.layer));
        return select !== undefined ? rows.map((r) => ({ key: r["key"] })) : rows;
      },
    },
    taxReviewFindingDisposition: {
      create: async ({ data }: { data: Row }) => {
        const row = { ...data, id: id(), at: stamp() };
        t.disposition.push(row);
        return row;
      },
      findMany: async ({ where }: { where: { taxYear: number; entityId: string } }) => t.disposition.filter((r) => r["taxYear"] === where.taxYear && r["entityId"] === where.entityId),
    },
    taxReturnApproval: {
      create: async ({ data }: { data: Row }) => {
        const row = { ...data, id: id(), at: stamp() };
        t.approval.push(row);
        return row;
      },
      findMany: async ({ where }: { where: { taxYear: number; entityId: string } }) => t.approval.filter((r) => r["taxYear"] === where.taxYear && r["entityId"] === where.entityId),
    },
    taxReviewRunEvent: {
      createMany: async ({ data }: { data: Row[] }) => {
        const seen = new Set(t.event.map((e) => `${String(e["runId"])}|${String(e["eventKey"])}`));
        for (const d of data) {
          const k = `${String(d["runId"])}|${String(d["eventKey"])}`;
          if (seen.has(k)) throw dupErr();
          seen.add(k);
        }
        for (const d of data) t.event.push({ ...d, id: id(), createdAt: stamp() });
        return { count: data.length };
      },
      findMany: async ({ where }: { where: { runId: string } }) => t.event.filter((e) => e["runId"] === where.runId),
    },
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const before = { run: t.run.length, finding: t.finding.length, event: t.event.length };
      try {
        return await fn(db);
      } catch (err) {
        t.run.length = before.run;
        t.finding.length = before.finding;
        t.event.length = before.event;
        throw err;
      }
    },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  const reset = (): void => {
    for (const k of Object.keys(t) as (keyof typeof t)[]) t[k].length = 0;
  };
  return { db, tables: t, reset };
});
vi.mock("@/lib/db", () => ({ db: fake.db }));

const build = vi.hoisted(() => ({ runReviewForYear: vi.fn(), loadReviewInputs: vi.fn(), currentReturnFingerprint: vi.fn(), loadFormData: vi.fn() }));
vi.mock("@/lib/tax-review-build", () => build);

const server = vi.hoisted(() => ({ loadReviewContext: vi.fn() }));
vi.mock("@/lib/tax-review-server", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tax-review-server")>()), loadReviewContext: server.loadReviewContext }));

const prepare = vi.hoisted(() => ({ prepareAiReview: vi.fn() }));
vi.mock("@/lib/tax-review-l3", () => prepare);

const transportFactory = vi.hoisted(() => ({ createAnthropicTransport: vi.fn() }));
vi.mock("@/lib/tax-review-anthropic", () => transportFactory);

import { acceptFinding, cancelAiReview, estimateAiReview, getFinalReviewState, runNextAiTask, runReviewChecks, startAiReview } from "@/actions/tax-review";
import { engineGateState, unresolvedChoicesCheck } from "@/lib/tax-review/l1/engine-state";
import { runL1, type L1Result } from "@/lib/tax-review/l1/run-l1";
import { bindFiles, readPacketFiles } from "@/lib/tax-review/l1/pdf-read";
import { l2SummaryOf, L2_VERSION, runL2, type L2Result } from "@/lib/tax-review/l2";
import { LlmTransportError } from "@/lib/tax-review/llm/client";
import { buildOutgoingJson, isSafeOutgoing } from "@/lib/tax-review/redact";
import { insertReviewRun } from "@/lib/tax-review-store";
import { priceFromEnv } from "@/lib/tax-review/llm/model";
import { buildReviewPayload, serializePayload } from "@/lib/tax-review/llm/payload";
import { buildRegister } from "@/lib/tax-review/llm/register";
import { estimateAiRun } from "@/lib/tax-review/llm/run";
import { loadSourcePack } from "@/lib/tax-review-sources";
import type { GateEngineState } from "@/lib/tax-review/gate";
import type { ReviewStateDto } from "@/lib/tax-review/state";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { ReviewContext } from "@/lib/tax-review-server";
import { buildPipeline, cleanScenario, type Pipeline } from "./tax-review-harness";
import { finding as aiFinding, MockTransport, PEOPLE, SCRUB, scriptedTransport } from "./tax-review-l3-harness";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const USER = "11111111-1111-4111-8111-111111111111";
const ENTITY = "22222222-2222-4222-8222-222222222222";
const FP = "a".repeat(64);
const FP_NEXT = "b".repeat(64);
const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");

// ── worlds: real L1 + L2 over the harness's synthetic returns ─────────────────────────────────────────────

interface World {
  pipeline: Pipeline;
  l1: L1Result;
  l2: L2Result;
}

async function worldOf(p: Pipeline): Promise<World> {
  return { pipeline: p, l1: await runL1(p.ctx), l2: runL2({ ret: p.ctx.ret, effective: p.ctx.effective, facts: p.ctx.facts }) };
}

let clean: World;
let blocked: World; // the engine's taxable income is $25 off the recalculation: two acceptable L2 blockers
let prep: unknown; // what prepareAiReview returns (the redacted payload of the clean return)

beforeAll(async () => {
  clean = await worldOf(await buildPipeline(cleanScenario()));
  blocked = await worldOf(
    await buildPipeline(cleanScenario(), {
      mutateRet: (ret) => {
        const line = ret.lines["f1040.15"];
        if (line === undefined || line.amount === null) throw new Error("no taxable income");
        line.amount += 25;
        const head = ret.headline.federal.taxableIncome;
        if (head.amount !== null) head.amount += 25;
      },
    })
  );
  const p = clean.pipeline;
  const bindings = bindFiles(p.ctx, await readPacketFiles(p.ctx.packet.files));
  const payload = buildReviewPayload(
    {
      ret: p.ret,
      view: p.ctx.view,
      facts: p.ctx.facts,
      documents: (p.ctx.raw?.documents ?? []).map((d) => ({ id: d.id, docType: d.docType, taxYear: d.taxYear, verified: d.verified, extractionStatus: d.extractionStatus, subjectType: d.subjectType, subjectUserId: d.subjectUserId })),
      bindings,
      l1Findings: clean.l1.findings,
      entityLabels: SCRUB.entities.map((e) => e.label),
    },
    PEOPLE
  );
  const serialized = serializePayload(payload, PEOPLE, SCRUB);
  const pack = loadSourcePack();
  const register = buildRegister({ ret: p.ret, facts: p.ctx.facts });
  prep = { serialized, estimate: estimateAiRun(serialized.payload, pack, priceFromEnv({}), "mock-model", register), model: "mock-model", pack, ret: p.ret, facts: p.ctx.facts, register, fingerprint: FP, entityId: ENTITY };
});

afterAll(() => {
  fake.reset();
});

// ── what runReviewForYear returns for a world ─────────────────────────────────────────────────────────────

function resultOf(w: World, over: { l2?: L2Result; extraFindings?: Finding[]; l2Summary?: unknown } = {}) {
  const l2 = over.l2 ?? w.l2;
  return {
    entityId: ENTITY,
    fingerprint: { fingerprint: FP, parts: {} },
    engineVersion: "ty-integration",
    l1: w.l1,
    l2,
    // exactly what lib/tax-review-build.ts returns: L1 and L2 together
    findings: [...w.l1.findings, ...l2.findings, ...(over.extraFindings ?? [])],
    engine: engineGateState(w.pipeline.ctx),
    config: { fingerprintVersion: 2, fingerprintParts: {}, l1Version: 1, l2Version: L2_VERSION, mode: "draft" },
    l1Summary: { ...w.l1.summary, status: w.l1.status },
    l2Summary: over.l2Summary ?? l2SummaryOf(l2),
  };
}

function ctxOf(w: World, over: Partial<ReviewContext> = {}): ReviewContext {
  return {
    year: 2025,
    entityId: ENTITY,
    user: { id: USER, name: "Eric Sample" },
    fingerprint: FP,
    engineVersion: "ty-integration",
    engine: engineGateState(w.pipeline.ctx),
    approver: { allowed: true, ownerName: "Eric Sample", reason: null },
    ...over,
  };
}

let currentCtx: ReviewContext;
let transport: MockTransport;

function setCtx(w: World, over: Partial<ReviewContext> = {}): void {
  currentCtx = ctxOf(w, over);
  server.loadReviewContext.mockImplementation(async () => ({ ok: true, ctx: currentCtx }));
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.reset();
  authMock.mockResolvedValue({ user: { id: USER } });
  fake.db.user.findUnique.mockResolvedValue({ id: USER, name: "Eric Sample" });
  fake.db.auditLog.create.mockResolvedValue({});
  prepare.prepareAiReview.mockImplementation(async () => prep);
  transport = scriptedTransport(() => undefined);
  transportFactory.createAnthropicTransport.mockImplementation(() => transport);
  setCtx(clean);
});

// ── drivers (the same actions the page calls) ─────────────────────────────────────────────────────────────

async function runChecks(w: World, over: Parameters<typeof resultOf>[1] = {}): Promise<string> {
  build.runReviewForYear.mockResolvedValue(resultOf(w, over));
  const r = await runReviewChecks({ taxYear: 2025 });
  if (!r.ok) throw new Error(`runReviewChecks failed: ${r.error}`);
  return r.runId;
}

/** estimate -> confirm -> start -> one task per call until the review stops being "running". */
async function runAi(runId: string, maxSteps = 40): Promise<string> {
  const est = await estimateAiReview({ taxYear: 2025 });
  if (!est.ok) throw new Error(`estimate failed: ${est.error}`);
  const start = await startAiReview({ taxYear: 2025, confirm: true });
  if (!start.ok) throw new Error(`start failed: ${start.error}`);
  return stepAi(runId, maxSteps);
}

async function stepAi(runId: string, maxSteps: number): Promise<string> {
  let last = "";
  for (let i = 0; i < maxSteps; i += 1) {
    const r = await runNextAiTask({ taxYear: 2025, runId });
    if (!r.ok) throw new Error(`step failed: ${r.error}`);
    last = r.ai.status;
    if (r.ai.status !== "running") break;
  }
  return last;
}

async function state(): Promise<ReviewStateDto> {
  const r = await getFinalReviewState({ taxYear: 2025 });
  if (!r.ok) throw new Error(`state failed: ${r.error}`);
  return r.state;
}

const item = (s: ReviewStateDto, id: string) => s.gate.items.find((i) => i.id === id);
const redItems = (s: ReviewStateDto): string[] => s.gate.items.filter((i) => i.state !== "pass").map((i) => i.id);

/** Accepts every open gating finding that may be accepted, as the owner would (a written reason each). Returns how many. */
async function acceptGating(s: ReviewStateDto, only: (f: ReviewStateDto["findings"][number]) => boolean = () => true): Promise<number> {
  let n = 0;
  for (const f of s.findings.filter((x) => x.gating && x.acceptable && only(x))) {
    const r = await acceptFinding({ taxYear: 2025, findingKey: f.key, evidenceHash: f.evidenceHash, reason: "Looked at it and the return stands as it is." });
    if (!r.ok) throw new Error(`accept failed: ${r.error}`);
    n += 1;
  }
  return n;
}

/** The L3 transport that makes one law claim without a verifiable source: stored as an unverified finding capped at medium (still gating). */
function lawClaimTransport(): MockTransport {
  const payload = (prep as { serialized: { payload: Parameters<typeof aiFinding>[0] } }).serialized.payload;
  return scriptedTransport((task) => (task === "a1" ? { findings: [aiFinding(payload, { severity: "high", legalClaim: true, sources: [], category: "other", message: "The rule for this line may have changed for 2025." })] } : undefined));
}

// ── the all-green path ─────────────────────────────────────────────────────────────────────────────────────

describe("all green: L1 + L2 stored, AI passes completed for the current fingerprint, nothing open", () => {
  it("the deterministic run stores the L1 AND the L2 findings, and its summary carries the L2 status and coverage to the gate", async () => {
    const runId = await runChecks(clean);
    const l2Rows = fake.tables.finding.filter((f) => f["runId"] === runId && f["layer"] === "L2");
    expect(l2Rows.length).toBeGreaterThan(0); // at least the L2.coverage information finding
    expect(fake.tables.finding.some((f) => f["layer"] === "L1")).toBe(true);
    const row = fake.tables.run[0] as { l2Summary: { status: string; coverage: unknown[]; mismatchCount: number } };
    expect(row.l2Summary.status).toBe("completed");
    expect(row.l2Summary.coverage.length).toBeGreaterThan(5);
    expect(row.l2Summary.mismatchCount).toBe(0);
  });

  it("before the AI passes: L1 and L2 are green, the AI item is red, approval is impossible and the page says why", async () => {
    await runChecks(clean);
    const s = await state();
    expect(item(s, "l1")?.state).toBe("pass");
    expect(item(s, "l2")?.state).toBe("pass");
    expect(item(s, "l3")?.state).toBe("not_run");
    expect(s.gate.verdict).toBe("flagged");
    expect(s.canApproveNow).toBe(false);
    expect(s.notRunNotice).not.toBeNull();
  });

  it("after the AI passes complete: every item passes, the verdict is PASSED and canApproveNow is true", async () => {
    const runId = await runChecks(clean);
    expect(await runAi(runId)).toBe("completed");
    expect(transport.calls).toHaveLength(13);
    const s = await state();
    expect(redItems(s)).toEqual([]);
    expect(s.gate.verdict).toBe("passed");
    expect(s.totals.gatingOpen).toBe(0);
    expect(s.notRunNotice).toBeNull();
    expect(s.ai.status).toBe("completed");
    expect(s.runIsStale).toBe(false);
    expect(s.findings.some((f) => f.layer === "L2")).toBe(true);
    expect(s.canApproveNow).toBe(true);
  });

  it("it is the owner's account that can approve: with the same green gate, another account gets canApproveNow = false", async () => {
    const runId = await runChecks(clean);
    await runAi(runId);
    setCtx(clean, { approver: { allowed: false, ownerName: "Eric Sample", reason: "Only the owner's own account can approve the return or accept a finding." } });
    const s = await state();
    expect(s.gate.verdict).toBe("passed");
    expect(s.canApproveNow).toBe(false);
    expect(s.approver.allowed).toBe(false);
  });
});

// ── each red path ─────────────────────────────────────────────────────────────────────────────────────────

describe("red: each missing or failing input keeps the gate flagged", () => {
  it("L2 not run (the recalculation could not run): red, even when the AI passes completed", async () => {
    const notRun = runL2(); // the Phase A call shape: not_run
    expect(notRun.status).toBe("not_run");
    const runId = await runChecks(clean, { l2: notRun });
    await runAi(runId);
    const s = await state();
    expect(item(s, "l2")?.state).not.toBe("pass");
    expect(item(s, "l3")?.state).toBe("pass");
    expect(s.gate.verdict).toBe("flagged");
    expect(s.canApproveNow).toBe(false);
  });

  it("L2 'completed' with no coverage list is not believed", async () => {
    const runId = await runChecks(clean, { l2Summary: { ...l2SummaryOf(clean.l2), coverage: [] } });
    await runAi(runId);
    const s = await state();
    expect(item(s, "l2")?.state).not.toBe("pass");
    expect(s.canApproveNow).toBe(false);
  });

  it("L3 not run: red, with the plain notice", async () => {
    await runChecks(clean);
    const s = await state();
    expect(item(s, "l3")?.state).toBe("not_run");
    expect(redItems(s)).toEqual(["l3", "verdict"]);
    expect(s.canApproveNow).toBe(false);
  });

  it("L3 failed (a task fails every try): the run fails closed, red", async () => {
    transport = scriptedTransport((task) => (task === "b1" ? new LlmTransportError("fatal", 400) : undefined));
    const runId = await runChecks(clean);
    expect(await runAi(runId)).toBe("failed");
    const s = await state();
    expect(s.ai.status).toBe("failed");
    expect(item(s, "l3")?.state).toBe("fail");
    expect(s.canApproveNow).toBe(false);
  });

  it("L3 started but unfinished (tab closed): red until it is resumed and completes, then green", async () => {
    const runId = await runChecks(clean);
    await estimateAiReview({ taxYear: 2025 });
    const started = await startAiReview({ taxYear: 2025, confirm: true });
    expect(started.ok).toBe(true);
    await stepAi(runId, 3);
    let s = await state();
    expect(s.ai.status).toBe("running");
    expect(item(s, "l3")?.state).toBe("fail");
    expect(s.canApproveNow).toBe(false);
    await stepAi(runId, 40);
    s = await state();
    expect(s.ai.status).toBe("completed");
    expect(s.canApproveNow).toBe(true);
  });

  it("L3 cancelled: red", async () => {
    const runId = await runChecks(clean);
    await estimateAiReview({ taxYear: 2025 });
    await startAiReview({ taxYear: 2025, confirm: true });
    await stepAi(runId, 2);
    const c = await cancelAiReview({ taxYear: 2025, runId });
    expect(c.ok).toBe(true);
    const s = await state();
    expect(s.ai.status).toBe("cancelled");
    expect(item(s, "l3")?.state).toBe("fail");
    expect(s.canApproveNow).toBe(false);
  });

  it("stale fingerprint: the return changed after the run. Everything bound to the old return is red and nothing can be decided or sent", async () => {
    const runId = await runChecks(clean);
    await runAi(runId);
    expect((await state()).canApproveNow).toBe(true);
    // the owner edits something: the live fingerprint is no longer the run's
    setCtx(clean, { fingerprint: FP_NEXT });
    const s = await state();
    expect(s.runIsStale).toBe(true);
    expect(item(s, "fingerprint")?.state).toBe("fail");
    expect(s.gate.verdict).toBe("flagged");
    expect(s.canApproveNow).toBe(false);
    // no AI review can attach to a run of the old return, and no finding can be decided on it
    const callsBefore = transport.calls.length;
    const preparedBefore = prepare.prepareAiReview.mock.calls.length;
    const est = await estimateAiReview({ taxYear: 2025 });
    expect(est.ok).toBe(false);
    expect(prepare.prepareAiReview.mock.calls.length).toBe(preparedBefore); // refused before anything was prepared
    expect(transport.calls).toHaveLength(callsBefore);
    const f = s.findings[0];
    if (f !== undefined) expect((await acceptFinding({ taxYear: 2025, findingKey: f.key, evidenceHash: f.evidenceHash, reason: "Looked at it and the return stands as it is." })).ok).toBe(false);
  });

  it("the return changes in the middle of the AI review: the review is marked stale, nothing more is sent, red", async () => {
    const runId = await runChecks(clean);
    await estimateAiReview({ taxYear: 2025 });
    await startAiReview({ taxYear: 2025, confirm: true });
    await stepAi(runId, 2);
    const sent = transport.calls.length;
    setCtx(clean, { fingerprint: FP_NEXT });
    const r = await runNextAiTask({ taxYear: 2025, runId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ai.status).toBe("stale");
    expect(transport.calls).toHaveLength(sent);
    expect(fake.tables.event.some((e) => e["kind"] === "stale")).toBe(true);
  });

  it("an open blocker (an L2 mismatch: the engine's taxable income is $25 off the recalculation) is red; accepting each with a written reason turns it green", async () => {
    const runId = await runChecks(clean, { l2: blocked.l2 });
    await runAi(runId);
    let s = await state();
    const blockers = s.findings.filter((f) => f.layer === "L2" && f.severity === "blocker");
    expect(blockers).toHaveLength(2);
    expect(blockers.every((f) => f.gating && f.acceptable)).toBe(true);
    expect(item(s, "l2")?.state).toBe("fail");
    expect(item(s, "l3")?.state).toBe("pass");
    expect(s.canApproveNow).toBe(false);
    // the owner's own account only: another account cannot accept them
    setCtx(clean, { approver: { allowed: false, ownerName: "Eric Sample", reason: "Only the owner's own account can approve the return or accept a finding." } });
    const b = blockers[0];
    expect(b).toBeDefined();
    if (b !== undefined) expect((await acceptFinding({ taxYear: 2025, findingKey: b.key, evidenceHash: b.evidenceHash, reason: "Looked at it and the return stands as it is." })).ok).toBe(false);
    setCtx(clean);
    expect(await acceptGating(s)).toBe(2);
    s = await state();
    expect(item(s, "l2")?.state).toBe("pass");
    expect(s.gate.verdict).toBe("passed");
    expect(s.canApproveNow).toBe(true);
  });

  it("an open high finding that may be accepted gates until accepted; a blocker that must be fixed (not acceptable) can never be accepted", async () => {
    const high = makeFinding({ layer: "L1", check: "L1.C1.test-high", severity: "high", area: "income", message: "A document total is not on the return.", recommendedAction: "Check it.", acceptable: true });
    const fixMe = makeFinding({ layer: "L1", check: "L1.B1.test-blocker", severity: "blocker", area: "forms", message: "A printed amount differs from the computed one.", recommendedAction: "Fix the return.", acceptable: false });
    const runId = await runChecks(clean, { extraFindings: [high, fixMe] });
    await runAi(runId);
    let s = await state();
    expect(item(s, "l1")?.state).toBe("fail");
    expect(s.canApproveNow).toBe(false);
    expect(await acceptGating(s)).toBe(1); // only the acceptable high
    const refused = await acceptFinding({ taxYear: 2025, findingKey: fixMe.key, evidenceHash: fixMe.evidenceHash, reason: "Looked at it and the return stands as it is." });
    expect(refused.ok).toBe(false);
    s = await state();
    expect(s.gate.verdict).toBe("flagged");
    expect(s.findings.find((f) => f.key === fixMe.key)?.status).toBe("open");
    expect(s.canApproveNow).toBe(false);
  });

  it("an unverified law finding from the AI (no source the code can check) is capped at medium, still gates, and clears only when accepted with a reason", async () => {
    transport = lawClaimTransport();
    const runId = await runChecks(clean);
    expect(await runAi(runId)).toBe("completed");
    let s = await state();
    const law = s.findings.filter((f) => f.layer === "L3");
    expect(law).toHaveLength(1);
    expect(law[0]?.severity).toBe("medium");
    expect(law[0]?.citation.sourceStatus).toBe("unverified");
    expect(law[0]?.gating).toBe(true);
    expect(item(s, "l3")?.state).toBe("fail");
    expect(s.ai.status).toBe("completed"); // the review finished; the finding is what is open
    expect(s.canApproveNow).toBe(false);
    expect(await acceptGating(s)).toBe(1);
    s = await state();
    expect(s.findings.find((f) => f.layer === "L3")?.status).toBe("accepted");
    expect(s.gate.verdict).toBe("passed");
    expect(s.canApproveNow).toBe(true);
  });

  it("a decision still at its default alternative (undecided X5 / X1) gates until the owner records it or accepts the default with a reason", async () => {
    const view = structuredClone(clean.pipeline.ctx.view);
    view.decisions = [
      { id: "X1", label: "Home office method", chosen: "simplified", status: "default_undecided", effectNote: "In force: simplified." },
      { id: "X5", label: "Property tax on the second property", chosen: "itemize", status: "default_undecided", effectNote: "In force: itemized." },
    ];
    const defaults = await unresolvedChoicesCheck.run({ ...clean.pipeline.ctx, view });
    expect(defaults.filter((f) => f.check === "L1.D2.decision")).toHaveLength(2);
    const runId = await runChecks(clean, { extraFindings: defaults });
    await runAi(runId);
    let s = await state();
    const decisions = s.findings.filter((f) => f.check.startsWith("L1.D2.decision"));
    expect(decisions).toHaveLength(2);
    expect(decisions.every((f) => f.severity === "medium" && f.acceptable && f.gating && f.status === "open")).toBe(true);
    expect(item(s, "l1")?.state).toBe("fail");
    expect(s.canApproveNow).toBe(false);
    // accepting the DEFAULTS only (with a reason) clears exactly those findings
    expect(await acceptGating(s, (f) => f.check.startsWith("L1.D2.decision"))).toBe(decisions.length);
    s = await state();
    expect(s.findings.filter((f) => f.check.startsWith("L1.D2.decision")).every((f) => f.status === "accepted" && !f.gating)).toBe(true);
    expect(s.gate.verdict).toBe("passed");
    expect(s.canApproveNow).toBe(true);
  });

  it("a line override in force is red even with every layer complete", async () => {
    const effective = clean.pipeline.ctx.effective;
    if (effective === null) throw new Error("no effective return");
    const withOverride = { ...effective, applied: { ...effective.applied, lines: [...effective.applied.lines, {} as (typeof effective.applied.lines)[number]] } };
    const engine = engineGateState({ view: clean.pipeline.ctx.view, effective: withOverride });
    expect(engine.lineOverrideCount).toBe(1);
    const runId = await runChecks(clean);
    await runAi(runId);
    setCtx(clean, { engine });
    const s = await state();
    expect(item(s, "engine")?.state).toBe("fail");
    expect(s.gate.verdict).toBe("flagged");
    expect(s.canApproveNow).toBe(false);
  });

  it("a blocking engine item (the return is not complete) is red even with every layer complete", async () => {
    const runId = await runChecks(clean);
    await runAi(runId);
    const engine: GateEngineState = { complete: false, blockingItemCount: 2, lineOverrideCount: 0, staleOverrideCount: 0 };
    setCtx(clean, { engine });
    const s = await state();
    expect(item(s, "engine")?.state).toBe("fail");
    expect(s.canApproveNow).toBe(false);
  });
});

// ── the L3 model call and the AI panel are owner-only, like accepting a finding and approving ────────────────

describe("owner only: the AI review spends the owner's API credit", () => {
  const notOwner = { approver: { allowed: false, ownerName: "Eric Sample", reason: "Only the owner's own account can approve the return or accept a finding." } };

  it("another account cannot estimate, start, step or cancel; nothing is prepared, no model client is made, no event is written", async () => {
    const runId = await runChecks(clean);
    setCtx(clean, notOwner);
    expect((await estimateAiReview({ taxYear: 2025 })).ok).toBe(false);
    expect((await startAiReview({ taxYear: 2025, confirm: true })).ok).toBe(false);
    expect((await runNextAiTask({ taxYear: 2025, runId })).ok).toBe(false);
    expect((await cancelAiReview({ taxYear: 2025, runId })).ok).toBe(false);
    expect(prepare.prepareAiReview).not.toHaveBeenCalled();
    expect(transportFactory.createAnthropicTransport).not.toHaveBeenCalled();
    expect(transport.calls).toHaveLength(0);
    expect(fake.tables.event).toHaveLength(0);
  });

  it("the owner started it: another account that steps the same run still cannot send anything", async () => {
    const runId = await runChecks(clean);
    await estimateAiReview({ taxYear: 2025 });
    await startAiReview({ taxYear: 2025, confirm: true });
    const events = fake.tables.event.length;
    setCtx(clean, notOwner);
    expect((await runNextAiTask({ taxYear: 2025, runId })).ok).toBe(false);
    expect(transport.calls).toHaveLength(0);
    expect(fake.tables.event).toHaveLength(events);
  });

  it("every action that reaches the model or writes an AI event passes through the owner check first (source pin)", () => {
    const src = read("actions/tax-review.ts");
    for (const name of ["estimateAiReview", "startAiReview", "runNextAiTask", "cancelAiReview"]) {
      const body = src.slice(src.indexOf(`export async function ${name}`));
      const end = body.indexOf("\nexport async function ", 10);
      const fn = end === -1 ? body : body.slice(0, end);
      expect(fn.includes("await aiAccess("), `${name} must call aiAccess`).toBe(true);
      const accessAt = fn.indexOf("await aiAccess(");
      for (const risky of ["createAnthropicTransport(", "prepareAiReview(", "startAiRun(", "cancelAiRun(", "runNextTask("]) {
        const at = fn.indexOf(risky);
        if (at !== -1) expect(at, `${name}: ${risky} must come after aiAccess`).toBeGreaterThan(accessAt);
      }
    }
    // aiAccess itself is the owner rule used by accept / reopen / approve
    expect(src).toMatch(/if \(!loaded\.ctx\.approver\.allowed\) return/);
  });

  it("the panel greys out every control that would call the server when the account is not the owner's (source pin)", () => {
    const panel = read("components/tax/review/ai-review-panel.tsx");
    for (const testId of ["ai-estimate-button", "ai-resume-button", "ai-cancel-button"]) {
      const tag = panel.slice(panel.lastIndexOf("<button", panel.indexOf(`data-testid="${testId}"`)), panel.indexOf(`data-testid="${testId}"`));
      expect(tag, `${testId} must be disabled with whyNot`).toMatch(/disabled=\{[^}]*whyNot !== null/);
    }
    // Start only exists after an estimate, which only the owner can get
    expect(panel).toMatch(/data-testid="ai-start-button"/);
    const page = read("app/tax/forms/[year]/final-review/page.tsx");
    expect(page).toMatch(/whyNot=\{state\.approver\.allowed \? null : state\.approver\.reason\}/);
  });
});

// ── what the run stores about itself: real digests ────────────────────────────────────────────────────────

describe("the run's own stored text holds real digests", () => {
  /** A genuine sha-256 hex digest that happens to contain a 9-digit run (about 4 in 10 do): found by the live read-only run, which a fixture of "aaaa..." never showed. */
  function digestWithNineDigits(seed: string): string {
    for (let i = 0; ; i += 1) {
      const h = createHash("sha256").update(`${seed}-${i}`).digest("hex");
      if (/\d{9}/.test(h)) return h;
    }
  }

  it("a 64-hex digest is not an identifier even when it holds a 9-digit run; an SSN-shaped text next to it is still refused", () => {
    const d = digestWithNineDigits("fp");
    expect(isSafeOutgoing(d)).toBe(true);
    expect(isSafeOutgoing(JSON.stringify({ a: d, b: digestWithNineDigits("fp2") }))).toBe(true);
    expect(isSafeOutgoing(`${d} and 123-45-6789`)).toBe(false);
    expect(isSafeOutgoing(`${d} and 123456789`)).toBe(false);
    expect(isSafeOutgoing("123456789abc")).toBe(false); // a number glued to hex letters is still a number
  });

  it("a finding key (16 hex) that holds a 9-digit run can be sent as the value of a key field of the payload, and only there", () => {
    let key = "";
    for (let i = 0; key === ""; i += 1) {
      const h = createHash("sha256").update(`key-${i}`).digest("hex").slice(0, 16);
      if (/\d{9}/.test(h) && /[a-f]/.test(h)) key = h;
    }
    const people = [{ userId: "u1", name: "Eric Sample" }];
    const out = buildOutgoingJson({ l1: { findings: [{ key, check: "L1.X", severity: "medium", message: "A thing." }] } }, people, "test payload");
    expect(out).toContain(key); // what is sent is the real key: the model refers to a finding by it
    expect(() => buildOutgoingJson({ note: key }, people, "test payload")).toThrow(/refused/);
    expect(() => buildOutgoingJson({ message: `see ${key}` }, people, "test payload")).toThrow(/refused/);
    expect(() => buildOutgoingJson({ key: `${key}0` }, people, "test payload")).toThrow(/refused/);
    expect(() => buildOutgoingJson({ key: "123456789" }, people, "test payload")).toThrow(/refused/);
  });

  it("the run row accepts a config whose fingerprint parts are such digests (it would otherwise refuse every real run)", async () => {
    const parts: Record<string, string> = {};
    for (const k of ["engine", "view", "answers", "header", "facts", "documents", "questionnaires", "overrides", "decisions"]) parts[k] = digestWithNineDigits(k);
    const stored = await insertReviewRun({ taxYear: 2025, entityId: ENTITY, fingerprint: digestWithNineDigits("whole"), engineVersion: "ty-integration", startedById: null, startedByName: "Eric Sample", config: { fingerprintVersion: 2, fingerprintParts: parts, mode: "draft" }, l1Summary: { status: "completed" }, l2Summary: { status: "completed", coverage: [] }, findings: [] });
    expect(stored.findingCount).toBe(0);
  });
});
