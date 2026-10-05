import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The AI review server actions (actions/tax-review.ts: estimateAiReview, startAiReview, runNextAiTask, getAiReviewStatus, cancelAiReview).
// Mocks sit at the auth / db / loader / store / transport boundary (repo convention); the orchestrator, the gate and the validators are the REAL code.

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const mockDb = vi.hoisted(() => ({ user: { findUnique: vi.fn(), findMany: vi.fn() }, auditLog: { create: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/tax-review-build", () => ({ runReviewForYear: vi.fn(), loadReviewInputs: vi.fn(), currentReturnFingerprint: vi.fn(), loadFormData: vi.fn() }));

const server = vi.hoisted(() => ({ loadReviewContext: vi.fn(), readReviewRecords: vi.fn() }));
vi.mock("@/lib/tax-review-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tax-review-server")>();
  return { ...actual, loadReviewContext: server.loadReviewContext, readReviewRecords: server.readReviewRecords };
});
const store = vi.hoisted(() => ({ listRuns: vi.fn(), insertReviewRun: vi.fn(), insertDisposition: vi.fn(), getRunWithFindings: vi.fn() }));
vi.mock("@/lib/tax-review-store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tax-review-store")>()), ...store }));

const prepare = vi.hoisted(() => ({ prepareAiReview: vi.fn() }));
vi.mock("@/lib/tax-review-l3", () => prepare);

vi.mock("@/lib/tax-review-l3-store", async () => {
  const { MemoryRunStore } = await import("@/lib/tax-review/llm/run");
  const mem = new MemoryRunStore(() => Date.now());
  return { dbAiRunStore: () => mem, __mem: mem };
});

const transportFactory = vi.hoisted(() => ({ createAnthropicTransport: vi.fn() }));
vi.mock("@/lib/tax-review-anthropic", () => transportFactory);

import { cancelAiReview, estimateAiReview, getAiReviewStatus, runNextAiTask, startAiReview } from "@/actions/tax-review";
import * as l3store from "@/lib/tax-review-l3-store";
import { loadSourcePack } from "@/lib/tax-review-sources";
import { estimateAiRun, type MemoryRunStore } from "@/lib/tax-review/llm/run";
import { priceFromEnv } from "@/lib/tax-review/llm/model";
import { emptyProgress } from "@/lib/tax-review/llm/progress";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { ReviewContext, ReviewRecords } from "@/lib/tax-review-server";
import type { RunRowLike } from "@/lib/tax-review/state";
import { richFixture, scriptedTransport, type L3Fixture } from "./tax-review-l3-harness";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const mem = (l3store as unknown as { __mem: MemoryRunStore }).__mem;
const USER = "11111111-1111-4111-8111-111111111111";
const ENTITY = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const FP = "a".repeat(64);
let fx: L3Fixture;

const runRow = (over: Partial<RunRowLike> = {}): RunRowLike => ({ id: RUN, fingerprint: FP, engineVersion: "e1", startedAt: new Date("2026-10-05T10:00:00Z"), startedByName: "Eric Kinniburgh", l1Summary: { status: "completed", counts: {} }, l2Summary: { status: "not_run", coverage: [] }, ...over });
const ctxOf = (over: Partial<ReviewContext> = {}): ReviewContext => ({ year: 2025, entityId: ENTITY, user: { id: USER, name: "Eric Kinniburgh" }, fingerprint: FP, engineVersion: "e1", engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 }, approver: { allowed: true, ownerName: "Eric Kinniburgh", reason: null }, ...over });
const l1Finding = (): Finding => makeFinding({ layer: "L1", check: "L1.x", severity: "medium", area: "tax", message: "A thing to look at.", recommendedAction: "Look at it.", acceptable: true });
const recordsOf = (over: Partial<ReviewRecords> = {}): ReviewRecords => ({ runs: [runRow()], latest: { run: runRow(), findings: [l1Finding()] }, dispositions: [], approvals: [], ai: null, ...over });

function prep(over: { warn?: boolean; fingerprint?: string } = {}) {
  const pack = loadSourcePack();
  const estimate = estimateAiRun(fx.payload, pack, priceFromEnv(over.warn === true ? { TAX_REVIEW_PRICE_IN_PER_MTOK: "900", TAX_REVIEW_PRICE_OUT_PER_MTOK: "4500" } : {}), "mock-model", fx.register);
  return { serialized: fx.serialized, estimate, model: "mock-model", pack, ret: fx.pipeline.ret, facts: fx.pipeline.ctx.facts, register: fx.register, fingerprint: over.fingerprint ?? FP, entityId: ENTITY };
}

beforeAll(async () => {
  fx = await richFixture();
});

beforeEach(() => {
  vi.clearAllMocks();
  mem.events.length = 0;
  mem.findings.length = 0;
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.user.findUnique.mockResolvedValue({ id: USER, name: "Eric Kinniburgh" });
  mockDb.auditLog.create.mockResolvedValue({});
  server.loadReviewContext.mockResolvedValue({ ok: true, ctx: ctxOf() });
  server.readReviewRecords.mockImplementation(async () => recordsOf({ ai: mem.events.length > 0 ? (await import("@/lib/tax-review/llm/progress")).foldProgress(mem.events, Date.now()) : null }));
  store.listRuns.mockResolvedValue([runRow()]);
  prepare.prepareAiReview.mockResolvedValue(prep());
  transportFactory.createAnthropicTransport.mockReturnValue(scriptedTransport(() => undefined));
});

const read = (p: string): string => readFileSync(resolve(__dirname, "../..", p), "utf8").replace(/\r\n/g, "\n");

describe("estimate: nothing is sent and nothing is written", () => {
  it("returns the per-task token estimate and cost, makes no model call, writes no event and no audit row, and leaks no payload", async () => {
    const r = await estimateAiReview({ taxYear: 2025 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.estimate.tasks).toHaveLength(13);
    expect(r.estimate.expectedUsd).toBeGreaterThan(0);
    expect(r.estimate.worstCaseUsd).toBeGreaterThanOrEqual(r.estimate.expectedUsd);
    expect(r.estimate.warnThresholdUsd).toBe(50);
    expect(r.estimate.runId).toBe(RUN);
    expect(r.estimate.alreadyStarted).toBe(false);
    expect(transportFactory.createAnthropicTransport).not.toHaveBeenCalled();
    expect(mem.events).toHaveLength(0);
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toMatch(/Taxpayer M|"json"|facts|payload"/);
  });
  it("only the owner's own account may ask (it spends the owner's API credit)", async () => {
    server.loadReviewContext.mockResolvedValue({ ok: true, ctx: ctxOf({ approver: { allowed: false, ownerName: "Eric Kinniburgh", reason: "Only the owner's own account can approve the return or accept a finding." } }) });
    const r = await estimateAiReview({ taxYear: 2025 });
    expect(r.ok).toBe(false);
    expect(prepare.prepareAiReview).not.toHaveBeenCalled();
  });
  it("needs a run of the checks for the CURRENT return", async () => {
    server.readReviewRecords.mockResolvedValue(recordsOf({ latest: null, runs: [] }));
    expect((await estimateAiReview({ taxYear: 2025 })).ok).toBe(false);
    server.readReviewRecords.mockResolvedValue(recordsOf({ latest: { run: runRow({ fingerprint: "b".repeat(64) }), findings: [] } }));
    const stale = await estimateAiReview({ taxYear: 2025 });
    expect(stale).toMatchObject({ ok: false });
    expect(prepare.prepareAiReview).not.toHaveBeenCalled();
  });
  it("a payload built for another fingerprint than the live one is refused", async () => {
    prepare.prepareAiReview.mockResolvedValue(prep({ fingerprint: "c".repeat(64) }));
    expect(await estimateAiReview({ taxYear: 2025 })).toMatchObject({ ok: false });
  });
  it("a payload the redaction guard refused is reported plainly and nothing is sent", async () => {
    prepare.prepareAiReview.mockResolvedValue({ error: "The review payload was refused because it still contained something that looks like a taxpayer number or an account number. Nothing was sent." });
    const r = await estimateAiReview({ taxYear: 2025 });
    expect(r).toMatchObject({ ok: false });
    expect(transportFactory.createAnthropicTransport).not.toHaveBeenCalled();
  });
});

describe("start: only after the owner confirms the estimate", () => {
  it("refuses without confirm and ignores any client-supplied fingerprint or gate state (strict input)", async () => {
    expect(await startAiReview({ taxYear: 2025 } as never)).toMatchObject({ ok: false });
    expect(await startAiReview({ taxYear: 2025, confirm: false } as never)).toMatchObject({ ok: false });
    expect(await startAiReview({ taxYear: 2025, confirm: true, fingerprint: "x", verdict: "passed" } as never)).toMatchObject({ ok: false });
    expect(await startAiReview({ taxYear: 2024, confirm: true } as never)).toMatchObject({ ok: false });
    expect(mem.events).toHaveLength(0);
  });
  it("starts once: records the config, the redacted payload and the register, writes an audit row with ids and counts only", async () => {
    const r = await startAiReview({ taxYear: 2025, confirm: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reused).toBe(false);
    expect(r.ai.status).toBe("running");
    expect(r.ai.totalCount).toBe(13);
    expect(mem.events.map((e) => e.eventKey)).toEqual(["run_started", "payload", "register"]);
    const audit = mockDb.auditLog.create.mock.calls[0]?.[0]?.data as { changeType: string; after: Record<string, unknown> };
    expect(audit.changeType).toBe("tax_review_ai_started");
    expect(Object.keys(audit.after).sort().join(",")).toBe("estimatedUsd,fingerprint,model,runId,started,tasks,taxYear");
    expect(JSON.stringify(audit)).not.toMatch(/Taxpayer|message|json/);
  });
  it("a second start returns the existing review without writing anything again", async () => {
    await startAiReview({ taxYear: 2025, confirm: true });
    const n = mem.events.length;
    const again = await startAiReview({ taxYear: 2025, confirm: true });
    expect(again).toMatchObject({ ok: true, reused: true });
    expect(mem.events).toHaveLength(n);
  });
  it("above the warning threshold it needs a second, explicit acknowledgement", async () => {
    prepare.prepareAiReview.mockResolvedValue(prep({ warn: true }));
    const without = await startAiReview({ taxYear: 2025, confirm: true });
    expect(without).toMatchObject({ ok: false });
    expect(without.ok === false && without.error).toMatch(/\$50/);
    expect(mem.events).toHaveLength(0);
    expect(await startAiReview({ taxYear: 2025, confirm: true, acknowledgeHighCost: true })).toMatchObject({ ok: true, reused: false });
  });
  it("only the owner's account can start", async () => {
    server.loadReviewContext.mockResolvedValue({ ok: true, ctx: ctxOf({ approver: { allowed: false, ownerName: "Eric Kinniburgh", reason: null } }) });
    expect(await startAiReview({ taxYear: 2025, confirm: true })).toMatchObject({ ok: false });
    expect(mem.events).toHaveLength(0);
  });
});

describe("steps, status, cancel", () => {
  it("runNextAiTask runs one task with the fingerprint recomputed on the server, and returns progress without any model text", async () => {
    await startAiReview({ taxYear: 2025, confirm: true });
    const t = scriptedTransport((task) => (task === "a1" ? { findings: [{ nonsense: true }] } : undefined));
    transportFactory.createAnthropicTransport.mockReturnValue(t);
    const r = await runNextAiTask({ taxYear: 2025, runId: RUN });
    expect(r).toMatchObject({ ok: true, step: "ran" });
    if (!r.ok) return;
    expect(r.ai.completedCount).toBe(1);
    expect(t.calls).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/Taxpayer|nonsense/);
  });
  it("a changed return marks the review stale and sends nothing", async () => {
    await startAiReview({ taxYear: 2025, confirm: true });
    server.loadReviewContext.mockResolvedValue({ ok: true, ctx: ctxOf({ fingerprint: "d".repeat(64) }) });
    const t = scriptedTransport(() => undefined);
    transportFactory.createAnthropicTransport.mockReturnValue(t);
    const r = await runNextAiTask({ taxYear: 2025, runId: RUN });
    expect(r).toMatchObject({ ok: true, step: "stale" });
    expect(t.calls).toHaveLength(0);
  });
  it("no API key is a plain message, not a crash", async () => {
    await startAiReview({ taxYear: 2025, confirm: true });
    transportFactory.createAnthropicTransport.mockImplementation(() => {
      throw new Error("no key");
    });
    const r = await runNextAiTask({ taxYear: 2025, runId: RUN });
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.error).toMatch(/not configured/);
  });
  it("a run of another return, a non-uuid id and extra input keys are refused", async () => {
    store.listRuns.mockResolvedValue([]);
    expect(await runNextAiTask({ taxYear: 2025, runId: RUN })).toMatchObject({ ok: false });
    expect(await runNextAiTask({ taxYear: 2025, runId: "nope" })).toMatchObject({ ok: false });
    expect(await runNextAiTask({ taxYear: 2025, runId: RUN, fingerprint: "a".repeat(64) } as never)).toMatchObject({ ok: false });
  });
  it("getAiReviewStatus returns the folded progress; cancel appends a cancelled event and the state says so", async () => {
    await startAiReview({ taxYear: 2025, confirm: true });
    const s = await getAiReviewStatus({ taxYear: 2025, runId: RUN });
    expect(s).toMatchObject({ ok: true });
    const c = await cancelAiReview({ taxYear: 2025, runId: RUN });
    expect(c).toMatchObject({ ok: true });
    if (c.ok) expect(c.ai.status).toBe("cancelled");
    const audit = mockDb.auditLog.create.mock.calls.map((x) => (x[0] as { data: { changeType: string } }).data.changeType);
    expect(audit).toContain("tax_review_ai_cancelled");
  });
});

describe("source checks", () => {
  const src = read("actions/tax-review.ts");
  it("every new export starts with requireAuth and is async", () => {
    for (const name of ["estimateAiReview", "startAiReview", "runNextAiTask", "getAiReviewStatus", "cancelAiReview"]) {
      const start = src.indexOf(`export async function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      const at = src.indexOf("const user = await requireAuth();", start);
      // nothing between the one-line signature and the auth call
      expect(src.slice(start, at).split("\n").length, name).toBe(2);
    }
  });
  it("the actions never pass a client-supplied fingerprint to the orchestrator and import no model SDK directly", () => {
    expect(src).toContain("currentFingerprint: access.ctx.fingerprint");
    expect(src).not.toMatch(/from "@anthropic-ai/);
    expect(src).not.toMatch(/input\.fingerprint|parsed\.data\.fingerprint/);
  });
  it("the progress shape the client gets has no payload and no model output field", () => {
    const state = read("lib/tax-review/state.ts");
    const dto = /export interface AiReviewDto \{[\s\S]*?\n\}/.exec(state)?.[0] ?? "";
    expect(dto).not.toMatch(/payload|json|message|response|promptText/i);
    expect(emptyProgress().status).toBe("not_run");
  });
});
