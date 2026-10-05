import { readdirSync, readFileSync } from "node:fs";
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

import { approveReturn, withdrawApproval } from "@/actions/tax-return-approval";
import { makeApprovalLookup } from "@/lib/tax-review-approval-lookup";
import { dbAiRunStore } from "@/lib/tax-review-l3-store";
import type { ReviewStoreDb } from "@/lib/tax-review-store";
import { ATTESTATION_V2_TEXT, attestationTextHash, TYPED_PHRASE } from "@/lib/tax-review/gate";
import { acceptFinding, cancelAiReview, estimateAiReview, getFinalReviewState, reopenFinding, runNextAiTask, runReviewChecks, startAiReview } from "@/actions/tax-review";
import { engineGateState } from "@/lib/tax-review/l1/engine-state";
import { runL1, type L1Result } from "@/lib/tax-review/l1/run-l1";
import { bindFiles, readPacketFiles } from "@/lib/tax-review/l1/pdf-read";
import { l2SummaryOf, L2_VERSION, runL2, type L2Result } from "@/lib/tax-review/l2";
import { priceFromEnv } from "@/lib/tax-review/llm/model";
import { buildReviewPayload, serializePayload } from "@/lib/tax-review/llm/payload";
import { buildRegister } from "@/lib/tax-review/llm/register";
import { estimateAiRun } from "@/lib/tax-review/llm/run";
import { loadSourcePack } from "@/lib/tax-review-sources";
import type { ReviewStateDto } from "@/lib/tax-review/state";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { ReviewContext } from "@/lib/tax-review-server";
import { buildPipeline, cleanScenario, type Pipeline } from "./tax-review-harness";
import { MockTransport, PEOPLE, SCRUB, scriptedTransport } from "./tax-review-l3-harness";

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



// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// TESTER (reviewer-all): can approveReturn succeed, or a clean copy be released, with a red input?
// Own scenarios against the REAL actions + the REAL approval lookup over the in-memory DB above.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

const OWNER_INPUT = { taxYear: 2025 as const, checked: true, attestationText: ATTESTATION_V2_TEXT, typedPhrase: TYPED_PHRASE, typedName: "Eric Sample" };
const lookup = () => makeApprovalLookup({ resolveEntityId: async () => ENTITY, store: fake.db as unknown as ReviewStoreDb });
const approvals = () => fake.tables.approval as { kind: string; fingerprint: string }[];

async function greenRun(): Promise<string> {
  const runId = await runChecks(clean);
  expect(await runAi(runId)).toBe("completed");
  expect((await state()).canApproveNow).toBe(true);
  return runId;
}

async function expectRefused(input: Parameters<typeof approveReturn>[0] = OWNER_INPUT): Promise<void> {
  const before = approvals().length;
  const r = await approveReturn(input);
  expect(r.ok, "approveReturn must be refused").toBe(false);
  expect(approvals().length).toBe(before);
  expect(await lookup().currentApproval(currentCtx.fingerprint)).toBe(false);
}


// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// TESTER (final): approval revocation scenarios of my own. After EVERY step the page state and the routes' lookup must agree.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

const REASON = "Looked at it and the return stands as it is.";
const accept = async (f: { key: string; evidenceHash: string }) => acceptFinding({ taxYear: 2025, findingKey: f.key, evidenceHash: f.evidenceHash, reason: REASON });
const reopen = async (f: { key: string; evidenceHash: string }) => reopenFinding({ taxYear: 2025, findingKey: f.key, evidenceHash: f.evidenceHash });
/** like runChecks, but the stored run is bound to the CURRENT context fingerprint (the shared helper pins FP). */
async function runChecksFp(w: World, over: Parameters<typeof resultOf>[1] = {}): Promise<string> {
  build.runReviewForYear.mockResolvedValue({ ...resultOf(w, over), fingerprint: { fingerprint: currentCtx.fingerprint, parts: {} } });
  const r = await runReviewChecks({ taxYear: 2025 });
  if (!r.ok) throw new Error(`runReviewChecks failed: ${r.error}`);
  return r.runId;
}
const oldRuns = (): void => {
  for (const r of fake.tables.run as { startedAt: Date }[]) r.startedAt = new Date(Date.UTC(2020, 0, 1));
};
async function agree(label: string, fp: string = currentCtx.fingerprint): Promise<boolean> {
  const page = (await state()).approval.current;
  const route = await lookup().currentApproval(fp);
  expect(page, `page and routes disagree after: ${label}`).toBe(route);
  return route;
}

async function approvedWithBlockers(): Promise<{ runId: string; blockers: { key: string; evidenceHash: string }[] }> {
  const runId = await runChecks(clean, { l2: blocked.l2 });
  expect(await runAi(runId)).toBe("completed");
  const blockers = (await state()).findings.filter((f) => f.gating && f.acceptable);
  expect(blockers.length).toBeGreaterThanOrEqual(2);
  for (const b of blockers) expect((await accept(b)).ok).toBe(true);
  expect((await approveReturn(OWNER_INPUT)).ok).toBe(true);
  expect(await agree("approved")).toBe(true);
  return { runId, blockers };
}

describe("tester(final): approval revocation, page and routes always agree", () => {
  it("sequence: approve, reopen, accept again (not restored), re-approve, withdraw, nothing revives a withdrawn approval", async () => {
    const { blockers } = await approvedWithBlockers();
    expect((await reopen(blockers[1]!)).ok).toBe(true);
    expect(await agree("reopen")).toBe(false);
    expect((await accept(blockers[1]!)).ok).toBe(true);
    expect(await agree("accept after reopen")).toBe(false);
    expect((await state()).gate.verdict).toBe("passed");
    expect((await approveReturn(OWNER_INPUT)).ok).toBe(true);
    expect(await agree("re-approved")).toBe(true);
    expect((await withdrawApproval({ taxYear: 2025, reason: "Withdrawing to look again." })).ok).toBe(true);
    expect(await agree("withdrawn")).toBe(false);
    expect((await reopen(blockers[0]!)).ok).toBe(true);
    expect(await agree("reopen after withdrawal")).toBe(false);
    expect((await accept(blockers[0]!)).ok).toBe(true);
    expect(await agree("accept after withdrawal")).toBe(false);
    expect(approvals().map((a) => a.kind)).toEqual(["approved", "approved", "withdrawn"]);
  });

  it("a reopened finding then a refused re-approval (gate red) leaves the lookup false and adds no row", async () => {
    const { blockers } = await approvedWithBlockers();
    await reopen(blockers[0]!);
    expect(await lookup().currentApproval(FP)).toBe(false);
    expect(await lookup().approvedAt?.(FP)).toBeNull();
    expect((await approveReturn(OWNER_INPUT)).ok).toBe(false);
    expect(approvals()).toHaveLength(1);
    expect(await agree("failed re-approval")).toBe(false);
  });

  it("an approval for ANOTHER fingerprint: not current for this one; other-fingerprint runs and cancellations do not revoke the approved one", async () => {
    await approvedWithBlockers();
    setCtx(clean, { fingerprint: FP_NEXT });
    oldRuns();
    const next = await runChecksFp(clean, { l2: blocked.l2 });
    expect(await agree("new fingerprint, run exists", FP_NEXT)).toBe(false);
    expect((await state()).approval.inForce).toBe(true);
    await estimateAiReview({ taxYear: 2025 });
    await startAiReview({ taxYear: 2025, confirm: true });
    await stepAi(next, 1);
    await cancelAiReview({ taxYear: 2025, runId: next });
    expect(await lookup().currentApproval(FP_NEXT)).toBe(false);
    setCtx(clean);
    expect(await agree("back to the approved fingerprint")).toBe(true);
    expect(await lookup().currentApproval("c".repeat(64))).toBe(false);
  });

  it("a withdrawn approval stays withdrawn when its fingerprint is current again", async () => {
    await approvedWithBlockers();
    expect((await withdrawApproval({ taxYear: 2025, reason: "I want to look again." })).ok).toBe(true);
    expect(await agree("withdrawn")).toBe(false);
    setCtx(clean, { fingerprint: FP_NEXT });
    setCtx(clean);
    expect(await agree("fingerprint flipped away and back")).toBe(false);
  });

  it("a medium finding decided after the approval does NOT revoke it (only blocking findings do)", async () => {
    const runId = await runChecks(clean, { l2: blocked.l2 });
    expect(await runAi(runId)).toBe("completed");
    for (const b of (await state()).findings.filter((f) => f.gating && f.acceptable)) expect((await accept(b)).ok).toBe(true);
    expect((await approveReturn(OWNER_INPUT)).ok).toBe(true);
    const nonBlocking = (await state()).findings.filter((f) => !f.gating && f.acceptable);
    expect(nonBlocking.length).toBeGreaterThan(0);
    for (const m of nonBlocking.slice(0, 3)) {
      expect((await accept(m)).ok).toBe(true);
      expect((await reopen(m)).ok).toBe(true);
    }
    expect(await agree("medium decisions after approval")).toBe(true);
    expect((await state()).approval.revokedReasons ?? []).toEqual([]);
  });

  it("a cancelled AI review event on a run of another fingerprint does not revoke", async () => {
    await approvedWithBlockers();
    const other = { id: "99999999-9999-4999-8999-999999999999", taxYear: 2025, entityId: ENTITY, fingerprint: FP_NEXT, startedAt: new Date(Date.UTC(2026, 5, 1)) };
    fake.tables.run.push(other as never);
    fake.tables.event.push({ id: "e1", runId: other.id, kind: "cancelled", eventKey: "cancelled", createdAt: new Date(Date.UTC(2030, 0, 1)), payload: {} });
    expect(await agree("foreign-fingerprint cancel")).toBe(true);
  });

  it("the facts reader failing at ANY read makes the lookup reject (fail closed) and the page report an error", async () => {
    await approvedWithBlockers();
    const tables = ["taxReviewRun", "taxReviewFinding", "taxReviewFindingDisposition", "taxReviewRunEvent", "taxReturnApproval"] as const;
    for (const t of tables) {
      const delegate = (fake.db as unknown as Record<string, { findMany: (a: unknown) => Promise<unknown>; findFirst?: (a: unknown) => Promise<unknown> }>)[t]!;
      const origMany = delegate.findMany;
      const origFirst = delegate.findFirst;
      delegate.findMany = async () => {
        throw new Error(`boom ${t}`);
      };
      if (origFirst !== undefined) {
        delegate.findFirst = async () => {
          throw new Error(`boom ${t}`);
        };
      }
      try {
        await expect(lookup().currentApproval(FP), `lookup must reject when ${t} cannot be read`).rejects.toThrow();
        const r = await getFinalReviewState({ taxYear: 2025 });
        expect(r.ok, `page must not claim a state when ${t} cannot be read`).toBe(false);
      } finally {
        delegate.findMany = origMany;
        if (origFirst !== undefined) delegate.findFirst = origFirst;
      }
    }
    expect(await agree("restored")).toBe(true);
  });

  // D1 (tester final report), FIXED: the facts reader reads every run of the approved fingerprint (no window) and fails closed when none can be read.
  it("LIMIT: 26 newer runs of OTHER fingerprints push the approved fingerprint's run out of the window; a reopened finding must still revoke", async () => {
    const { blockers } = await approvedWithBlockers();
    await reopen(blockers[0]!);
    expect(await lookup().currentApproval(FP)).toBe(false);
    for (let i = 0; i < 26; i += 1) {
      setCtx(clean, { fingerprint: "d".repeat(62) + i.toString(16).padStart(2, "0") });
      oldRuns();
      await runChecksFp(clean);
    }
    setCtx(clean);
    expect(await lookup().currentApproval(FP), "reopened finding must still revoke after 26 runs of other fingerprints").toBe(false);
  });
});

describe("tester(final): a cancelled AI review of an OLDER run of the same fingerprint (after the approval) revokes it", () => {
  it("events are read for every run of the approved fingerprint, not only the newest", async () => {
    const { runId } = await approvedWithBlockers();
    // a newer run for the same fingerprint with no events at all; the cancellation sits on the older run
    oldRuns();
    const newer = await runChecksFp(clean, { l2: blocked.l2 });
    expect(newer).not.toBe(runId);
    expect(await agree("newer run, same findings")).toBe(true);
    fake.tables.event.push({ id: "e-old", runId, kind: "cancelled", eventKey: "cancelled", createdAt: new Date(Date.UTC(2030, 0, 1)), payload: {} });
    expect(await agree("cancelled event on the older run")).toBe(false);
    expect((await state()).approval.revokedReasons?.join(" ") ?? "").toMatch(/AI review was cancelled/);
  });
});

describe("tester(final): attestation text v2 on the real approveReturn", () => {
  const V2 = "This income tax return has been reviewed, prepared and filed by Eric Kinniburgh.";
  const V1 =
    "I, Eric Kinniburgh, prepared this 2025 federal and Connecticut income tax return myself. I have reviewed every figure and every decision recorded in the Final review, I understand the AI review is an automated aid and not a professional opinion, and I take full responsibility for the return as its preparer.";

  it("the constant is exactly the owner's sentence, version v2, and the page passes that constant to the card", () => {
    expect(ATTESTATION_V2_TEXT).toBe(V2);
    const page = read("app/tax/forms/[year]/final-review/page.tsx");
    expect(page).toContain("attestationText={ATTESTATION_V2_TEXT}");
    expect(page).not.toContain("ATTESTATION_V1");
    // honesty panel directly above the approval card, nothing in between
    expect(page).toMatch(/<HonestyPanel \/>\s*<ApprovalCard/);
  });

  it("every near-miss of the text, the phrase, the name or the account is refused; the exact input is accepted and stores v2 + the hash of v2", async () => {
    await greenRun();
    const bad: Parameters<typeof approveReturn>[0][] = [
      { ...OWNER_INPUT, attestationText: V1 },
      { ...OWNER_INPUT, attestationText: V2.slice(0, -1) },
      { ...OWNER_INPUT, attestationText: V2 + " " },
      { ...OWNER_INPUT, attestationText: " " + V2 },
      { ...OWNER_INPUT, attestationText: V2.toLowerCase() },
      { ...OWNER_INPUT, attestationText: V2.replace("prepared", "prepare") },
      { ...OWNER_INPUT, attestationText: V2.replace(/ /g, " ") },
      { ...OWNER_INPUT, attestationText: "" },
      { ...OWNER_INPUT, typedPhrase: "i prepared this return" },
      { ...OWNER_INPUT, typedPhrase: "I PREPARED THIS RETURN." },
      { ...OWNER_INPUT, typedPhrase: "I PREPARED THIS" },
      { ...OWNER_INPUT, typedPhrase: "" },
      { ...OWNER_INPUT, typedName: "Eric" },
      { ...OWNER_INPUT, typedName: "Eric Sample Jr" },
      { ...OWNER_INPUT, typedName: "" },
      { ...OWNER_INPUT, checked: false },
    ];
    for (const b of bad) await expectRefused(b);
    // a non-owner account
    setCtx(clean, { approver: { allowed: false, ownerName: "Eric Sample", reason: "Only the owner's own account can record the approval." } });
    await expectRefused(OWNER_INPUT);
    // the owner unidentifiable
    setCtx(clean, { approver: { allowed: true, ownerName: null, reason: null } });
    await expectRefused(OWNER_INPUT);
    setCtx(clean);
    expect((await approveReturn(OWNER_INPUT)).ok).toBe(true);
    const row = fake.tables.approval[0] as { attestationVersion: string; attestationTextHash: string; typedConfirmationHash: string };
    expect(row.attestationVersion).toBe("v2");
    expect(row.attestationTextHash).toBe(attestationTextHash(V2));
    expect(row.attestationTextHash).not.toBe(attestationTextHash(V1));
    expect(JSON.stringify(row)).not.toContain(V2);
    expect(JSON.stringify(row)).not.toContain("I PREPARED THIS RETURN");
    // the audit row carries v2 and the hash but not the sentence or the typed text
    const audit = JSON.stringify(fake.db.auditLog.create.mock.calls);
    expect(audit).toContain('"attestationVersion":"v2"');
    expect(audit).not.toContain(V2);
    expect(audit).not.toContain("I PREPARED THIS RETURN");
  });

  it("the sentence appears in no source file but gate.ts (page gets it by import) and the package / PDF code never mention it", () => {
    for (const rel of ["lib/tax2025/pdf/final-package.ts", "app/api/tax/forms/[year]/pdf/route.ts", "lib/tax2025-pdf-route.ts", "lib/tax2025-pdf-approval.ts"]) {
      let src = "";
      try {
        src = read(rel);
      } catch {
        continue;
      }
      expect(src, rel).not.toContain("prepared and filed");
      expect(src, rel).not.toContain("ATTESTATION");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// TESTER (final): L3 store, "the more severe finding per key", insert-only, over the same in-memory database
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("tester(final): L3 store keeps the MORE SEVERE finding per key, insert-only", () => {
  const RUN = "33333333-3333-4333-8333-333333333333";
  const l3 = (severity: "blocker" | "high" | "medium" | "low" | "info", over: { check?: string; message?: string } = {}) =>
    makeFinding({ layer: "L3", check: over.check ?? "L3.income.t1", severity, area: "income", message: over.message ?? `finding at ${severity}`, recommendedAction: "look", acceptable: true, origin: "llm", pass: "income", evidence: [{ ref: "head:total", amount: 5, status: "ok" }] });
  const ev = (key: string) => [{ runId: RUN, eventKey: key, kind: "task_completed" as const, taskId: "a1", attempt: 1, data: {} }];
  const rows = () => (fake.tables.finding as { runId: string; key: string; severity: string; message: string }[]).filter((r) => r.runId === RUN);

  it("medium then high: both rows stored, the reader returns high; high then medium / equal: no second row; the first row is never modified", async () => {
    const store = dbAiRunStore(fake.db as never);
    await store.append(RUN, ev("done:a1"), [l3("medium")]);
    const first = JSON.stringify(rows()[0]);
    await store.append(RUN, ev("done:a2"), [l3("high")]);
    expect(rows().map((r) => r.severity)).toEqual(["medium", "high"]);
    expect(JSON.stringify(rows()[0]), "the earlier row must be untouched").toBe(first);
    let seen = await store.listL3Findings(RUN);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.severity).toBe("high");
    await store.append(RUN, ev("done:a3"), [l3("medium", { message: "again" })]);
    await store.append(RUN, ev("done:a4"), [l3("high", { message: "same severity again" })]);
    await store.append(RUN, ev("done:a5"), [l3("low")]);
    expect(rows()).toHaveLength(2);
    seen = await store.listL3Findings(RUN);
    expect(seen.map((f) => f.severity)).toEqual(["high"]);
    // blocker beats high
    await store.append(RUN, ev("done:a6"), [l3("blocker")]);
    expect(rows().map((r) => r.severity)).toEqual(["medium", "high", "blocker"]);
    expect((await store.listL3Findings(RUN)).map((f) => f.severity)).toEqual(["blocker"]);
  });

  it("one batch holding both severities stores only the more severe; different keys do not interfere; another run is independent", async () => {
    const store = dbAiRunStore(fake.db as never);
    await store.append(RUN, ev("done:b1"), [l3("low"), l3("high"), l3("medium", { check: "L3.income.other" })]);
    expect(rows().map((r) => `${r.severity}`).sort()).toEqual(["high", "medium"]);
    await store.append("44444444-4444-4444-8444-444444444444", ev("done:b2"), [l3("low")]);
    expect((fake.tables.finding as { runId: string }[]).filter((r) => r.runId === "44444444-4444-4444-8444-444444444444")).toHaveLength(1);
  });

  it("a duplicate event key aborts the whole append (events AND findings roll back)", async () => {
    const store = dbAiRunStore(fake.db as never);
    await store.append(RUN, ev("done:c1"), [l3("medium")]);
    await expect(store.append(RUN, ev("done:c1"), [l3("blocker")])).rejects.toThrow();
    expect(rows().map((r) => r.severity)).toEqual(["medium"]);
  });

  it("a non-L3 finding is refused", async () => {
    const store = dbAiRunStore(fake.db as never);
    const l1 = makeFinding({ layer: "L1", check: "L1.x", severity: "high", area: "forms", message: "m", recommendedAction: "r", acceptable: true });
    await expect(store.append(RUN, ev("done:d1"), [l1])).rejects.toThrow();
    expect(rows()).toHaveLength(0);
  });

  it("source: the stores have no update / delete / upsert / raw SQL call", () => {
    for (const rel of ["lib/tax-review-store.ts", "lib/tax-review-l3-store.ts", "lib/tax-review-approval-facts.ts", "lib/tax-review-approval-lookup.ts"]) {
      expect(read(rel), rel).not.toMatch(/\.(update|updateMany|delete|deleteMany|upsert)\(|queryRaw|executeRaw|RawUnsafe/);
    }
  });
});

describe("tester(final): the removed store.findCurrentApproval has no caller", () => {
  it("lib/tax-review-store.ts exports no findCurrentApproval and no file imports one from it", () => {
    expect(read("lib/tax-review-store.ts")).not.toMatch(/export (async )?function findCurrentApproval/);
    const files = ["actions/tax-review.ts", "actions/tax-return-approval.ts", "lib/tax-review-server.ts", "lib/tax-review-approval-lookup.ts", "lib/tax2025-pdf-approval.ts", "lib/tax2025-pdf-route.ts", "lib/tax-review/state.ts"];
    for (const rel of files) expect(read(rel), rel).not.toMatch(/findCurrentApproval[^;]*from "@\/lib\/tax-review-store"/);
  });
});

describe("tester(final): every reader of the approvals table goes through the one facts reader", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "__tests__" || e.name === ".next") continue;
        walk(rel, out);
      } else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
    }
    return out;
  };
  it("only lib/tax-review-approval-facts.ts and lib/tax-review-server.ts call listApprovals; both then use readRevocationFacts", () => {
    const files = [...walk("lib"), ...walk("actions"), ...walk("app"), ...walk("components")];
    const readers = files.filter((f) => /\blistApprovals\(/.test(read(f)) && f !== "lib/tax-review-store.ts");
    expect(readers.sort()).toEqual(["lib/tax-review-approval-facts.ts", "lib/tax-review-server.ts"]);
    const touching = files.filter((f) => /\btaxReturnApproval\b/.test(read(f)) && f !== "lib/tax-review-store.ts");
    expect(touching).toEqual([]);
    expect(read("lib/tax-review-server.ts")).toMatch(/readRevocationFacts\(/);
    expect(read("lib/tax-review-approval-facts.ts")).toMatch(/currentApproval\(approvals, fingerprint, await readRevocationFacts\(/);
    // the routes' lookup and the page state both end in the pure currentApproval with facts; nothing else decides "current"
    const deciders = files.filter((f) => /\bcurrentApproval\(/.test(read(f)) && !f.startsWith("lib/tax-review/gate"));
    // (lib/tax2025-pdf-approval.ts is the ApprovalLookup interface and lib/tax2025-pdf-route.ts calls it; the implementation is the lookup over the facts reader)
    expect(deciders.sort()).toEqual(["lib/tax-review-approval-facts.ts", "lib/tax-review/state.ts", "lib/tax2025-pdf-approval.ts", "lib/tax2025-pdf-route.ts"]);
  });
});
