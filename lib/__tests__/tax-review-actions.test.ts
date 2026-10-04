import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Server actions of the Final review (actions/tax-review.ts, actions/tax-return-approval.ts). Mocks sit at the auth / db / loader /
// store boundary (repo convention: no integrated DB tests); the gate, the approver rule and the finding model are the REAL code.

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
const revalidateMock = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));
const mockDb = vi.hoisted(() => ({ user: { findUnique: vi.fn(), findMany: vi.fn() }, auditLog: { create: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mockDb }));

const build = vi.hoisted(() => ({ runReviewForYear: vi.fn(), loadReviewInputs: vi.fn(), currentReturnFingerprint: vi.fn() }));
vi.mock("@/lib/tax-review-build", () => build);

const server = vi.hoisted(() => ({ loadReviewContext: vi.fn(), readReviewRecords: vi.fn(), stateOf: vi.fn() }));
vi.mock("@/lib/tax-review-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tax-review-server")>();
  server.stateOf.mockImplementation(actual.stateOf);
  return { ...actual, loadReviewContext: server.loadReviewContext, readReviewRecords: server.readReviewRecords, stateOf: server.stateOf };
});

const store = vi.hoisted(() => ({
  insertReviewRun: vi.fn(),
  insertDisposition: vi.fn(),
  insertApproval: vi.fn(),
  listRuns: vi.fn(),
  getRunWithFindings: vi.fn(),
}));
vi.mock("@/lib/tax-review-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tax-review-store")>();
  return { ...actual, ...store };
});

import { acceptFinding, getReviewRun, listReviewRuns, reopenFinding, runReviewChecks } from "@/actions/tax-review";
import { approveReturn, withdrawApproval } from "@/actions/tax-return-approval";
import { ATTESTATION_V1_TEXT, evaluateGate, TYPED_PHRASE, type GateInput } from "@/lib/tax-review/gate";
import { buildReviewState, type ApprovalDetail, type DispositionDetail, type RunRowLike } from "@/lib/tax-review/state";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { ReviewContext, ReviewRecords } from "@/lib/tax-review-server";

const ROOT = resolve(__dirname, "../..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const USER = "11111111-1111-4111-8111-111111111111";
const ENTITY = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const FP = "a".repeat(64);
const OTHER_FP = "b".repeat(64);
const REASON = "Checked the books against the bank statement; the difference is a timing item.";

function finding(check: string, over: Partial<Parameters<typeof makeFinding>[0]> = {}): Finding {
  return makeFinding({
    layer: "L1",
    check,
    severity: "medium",
    area: "tax",
    message: "A thing to look at.",
    evidence: [{ ref: "f1040.9", amount: 5, status: "computed" }],
    recommendedAction: "Look at it.",
    acceptable: true,
    ...over,
  });
}

function runRow(over: Partial<RunRowLike> = {}): RunRowLike {
  return { id: RUN, fingerprint: FP, engineVersion: "e1", startedAt: new Date("2026-10-05T10:00:00Z"), startedByName: "Eric Kinniburgh", l1Summary: { status: "completed", counts: { blocker: 0, high: 0, medium: 1, low: 0, info: 0 } }, l2Summary: { status: "not_run", coverage: [] }, ...over };
}

function ctxOf(over: Partial<ReviewContext> = {}): ReviewContext {
  return {
    year: 2025,
    entityId: ENTITY,
    user: { id: USER, name: "Eric Kinniburgh" },
    fingerprint: FP,
    engineVersion: "e1",
    engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 },
    approver: { allowed: true, ownerName: "Eric Kinniburgh", reason: null },
    ...over,
  };
}

function recordsOf(findings: Finding[] = [finding("L1.E2.expense-ratio")], over: Partial<ReviewRecords> = {}): ReviewRecords {
  return { runs: [runRow()], latest: { run: runRow(), findings }, dispositions: [], approvals: [], ...over };
}

/** A gate with every layer run and nothing open: only reachable in a test (the real phase has L2 / L3 not run). */
function greenGate() {
  const input: GateInput = {
    runFingerprint: FP,
    currentFingerprint: FP,
    engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 },
    findings: [],
    dispositions: [],
    l1: { status: "completed" },
    l2: { status: "completed", coverageListed: true },
    l3: { status: "completed", adversarialCompleted: true },
  };
  return evaluateGate(input);
}

function greenState(records: ReviewRecords, ctx: ReviewContext) {
  const real = buildReviewState({ currentFingerprint: ctx.fingerprint, engine: ctx.engine, latest: records.latest, runs: records.runs, dispositions: records.dispositions, approvals: records.approvals, approver: ctx.approver });
  return { ...real, gate: greenGate(), canApproveNow: ctx.approver.allowed };
}

const approvalInput = { taxYear: 2025, checked: true, attestationText: ATTESTATION_V1_TEXT, typedPhrase: TYPED_PHRASE, typedName: "Eric Kinniburgh" };
const acceptInput = (f: Finding) => ({ taxYear: 2025, findingKey: f.key, evidenceHash: f.evidenceHash, reason: REASON });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.user.findUnique.mockResolvedValue({ id: USER, name: "Eric Kinniburgh" });
  mockDb.auditLog.create.mockResolvedValue({});
  server.loadReviewContext.mockResolvedValue({ ok: true, ctx: ctxOf() });
  server.readReviewRecords.mockResolvedValue(recordsOf());
  store.insertDisposition.mockResolvedValue({ id: "disp-1" });
  store.insertApproval.mockResolvedValue({ id: "appr-1" });
  store.insertReviewRun.mockResolvedValue({ runId: RUN, findingCount: 1 });
  store.listRuns.mockResolvedValue([]);
  store.getRunWithFindings.mockResolvedValue(null);
});

const ACTION_FILES = ["actions/tax-review.ts", "actions/tax-return-approval.ts"];

describe("source checks", () => {
  it("both files are server actions whose every export is an async function that starts with `const user = await requireAuth();`", () => {
    for (const file of ACTION_FILES) {
      const src = read(file);
      expect(src.startsWith('"use server";'), file).toBe(true);
      const exportsFound = [...src.matchAll(/^export (async )?function (\w+)/gm)];
      expect(exportsFound.length, file).toBeGreaterThanOrEqual(2);
      expect(src.match(/^export (?!async function)/gm), `${file}: only async functions are exported`).toBeNull();
      for (const m of exportsFound) {
        const at = m.index ?? 0;
        const open = src.indexOf("{\n", src.indexOf(")", at));
        const body = src.slice(open + 2).trimStart();
        expect(body.startsWith("const user = await requireAuth();") || body.startsWith("await requireAuth();"), `${file} ${m[2]}`).toBe(true);
      }
    }
  });

  it("no hard delete and no update-in-place anywhere in the actions, the support module or the server loader", () => {
    for (const file of [...ACTION_FILES, "lib/tax-review-action-support.ts", "lib/tax-review-server.ts"]) {
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
      expect(code, file).not.toMatch(/\.(delete|deleteMany|update|updateMany|upsert)\(|\$executeRaw|\$queryRaw/);
    }
  });

  it("the actions take no fingerprint and no gate state from a client (strict input schemas)", () => {
    for (const file of ACTION_FILES) {
      const src = read(file);
      expect(src, file).toMatch(/\.strict\(\)/);
      expect(src, file).not.toMatch(/z\.object\(\{[^}]*fingerprint/);
    }
  });

  it("AuditLog rows are written only through writeReviewAudit and never carry a reason or a name", () => {
    for (const file of ACTION_FILES) {
      const src = read(file);
      expect(src, file).not.toMatch(/auditLog\.create/);
      for (const m of src.matchAll(/writeReviewAudit\([\s\S]*?\}\);/g)) expect(m[0], file).not.toMatch(/\b(reason|byName|approvedByName|name|message|typedPhrase|typedName)\s*:/);
    }
  });
});

describe("auth and year guards", () => {
  const calls: [string, () => Promise<unknown>][] = [
    ["runReviewChecks", () => runReviewChecks({ taxYear: 2025 })],
    ["listReviewRuns", () => listReviewRuns({ taxYear: 2025 })],
    ["getReviewRun", () => getReviewRun({ taxYear: 2025, runId: RUN })],
    ["acceptFinding", () => acceptFinding({ taxYear: 2025, findingKey: "0".repeat(16), evidenceHash: "0".repeat(16), reason: REASON })],
    ["reopenFinding", () => reopenFinding({ taxYear: 2025, findingKey: "0".repeat(16), evidenceHash: "0".repeat(16) })],
    ["approveReturn", () => approveReturn(approvalInput)],
    ["withdrawApproval", () => withdrawApproval({ taxYear: 2025, reason: REASON })],
  ];

  it("every export rejects an unauthenticated caller before any database, engine or store call", async () => {
    authMock.mockResolvedValue(null);
    for (const [name, call] of calls) await expect(call(), name).rejects.toThrow("Unauthorized");
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
    expect(build.runReviewForYear).not.toHaveBeenCalled();
    expect(server.loadReviewContext).not.toHaveBeenCalled();
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it("only tax year 2025 is accepted, and nothing is read or written for another year", async () => {
    const wrong: [string, () => Promise<{ ok: boolean; error?: string }>][] = [
      ["runReviewChecks", () => runReviewChecks({ taxYear: 2024 as 2025 })],
      ["listReviewRuns", () => listReviewRuns({ taxYear: 2024 as 2025 })],
      ["getReviewRun", () => getReviewRun({ taxYear: 2024 as 2025, runId: RUN })],
      ["acceptFinding", () => acceptFinding({ ...acceptInput(finding("L1.x")), taxYear: 2024 as 2025 })],
      ["reopenFinding", () => reopenFinding({ taxYear: 2024 as 2025, findingKey: "0".repeat(16), evidenceHash: "0".repeat(16) })],
      ["approveReturn", () => approveReturn({ ...approvalInput, taxYear: 2024 as 2025 })],
      ["withdrawApproval", () => withdrawApproval({ taxYear: 2024 as 2025, reason: REASON })],
    ];
    for (const [name, call] of wrong) {
      const r = await call();
      expect(r.ok, name).toBe(false);
      expect(r.error, name).toMatch(/2025/);
    }
    expect(build.runReviewForYear).not.toHaveBeenCalled();
    expect(server.loadReviewContext).not.toHaveBeenCalled();
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  });

  it("an input that carries a fingerprint or a verdict is rejected: nothing the gate depends on comes from the client", async () => {
    const r1 = await approveReturn({ ...approvalInput, fingerprint: FP, verdict: "passed" } as unknown as typeof approvalInput);
    expect(r1.ok).toBe(false);
    const r2 = await acceptFinding({ ...acceptInput(finding("L1.x")), fingerprint: FP } as never);
    expect(r2.ok).toBe(false);
    const r3 = await runReviewChecks({ taxYear: 2025, fingerprint: FP } as never);
    expect(r3.ok).toBe(false);
    expect(server.loadReviewContext).not.toHaveBeenCalled();
    expect(build.runReviewForYear).not.toHaveBeenCalled();
  });
});

describe("SSN-like text is refused before any work", () => {
  it("a reason with an SSN-like number, an EIN or a long number is refused (accept, withdraw), and so is a typed name", async () => {
    for (const bad of ["Per notice 123-45-6789 it is fine", "Employer 12-3456789 confirmed it", "Account 123456789012 matched", "123 45 6789 matched"]) {
      expect((await acceptFinding({ ...acceptInput(finding("L1.x")), reason: bad })).ok, bad).toBe(false);
      expect((await withdrawApproval({ taxYear: 2025, reason: bad })).ok, bad).toBe(false);
    }
    const typed = await approveReturn({ ...approvalInput, typedName: "Eric 123-45-6789" });
    expect(typed.ok).toBe(false);
    expect(server.loadReviewContext).not.toHaveBeenCalled();
    expect(store.insertDisposition).not.toHaveBeenCalled();
    expect(store.insertApproval).not.toHaveBeenCalled();
  });
  it("a reason needs 3 to 500 characters", async () => {
    expect((await acceptFinding({ ...acceptInput(finding("L1.x")), reason: "ok" })).ok).toBe(false);
    expect((await acceptFinding({ ...acceptInput(finding("L1.x")), reason: "x".repeat(501) })).ok).toBe(false);
    expect((await acceptFinding({ ...acceptInput(finding("L1.x")), reason: "   " })).ok).toBe(false);
  });
});

describe("runReviewChecks", () => {
  const result = (over: Record<string, unknown> = {}) => ({
    entityId: ENTITY,
    fingerprint: { fingerprint: FP },
    engineVersion: "e1",
    l1: { findings: [finding("L1.E2.expense-ratio")], status: "completed", summary: { counts: { blocker: 0, high: 0, medium: 1, low: 0, info: 0 } } },
    l2: { status: "not_run", coverage: [] },
    config: { l1Version: 1 },
    l1Summary: { status: "completed" },
    l2Summary: { status: "not_run", coverage: [] },
    ...over,
  });

  it("runs L1 for the current return, stores the run and its findings, and writes an audit row of ids and counts", async () => {
    build.runReviewForYear.mockResolvedValue(result());
    const r = await runReviewChecks({ taxYear: 2025 });
    expect(r).toEqual({ ok: true, runId: RUN, findingCount: 1, reused: false });
    expect(build.runReviewForYear).toHaveBeenCalledWith(2025, "Eric Kinniburgh", "draft");
    const arg = store.insertReviewRun.mock.calls[0]?.[0] as { fingerprint: string; findings: Finding[]; startedById: string };
    expect(arg.fingerprint).toBe(FP);
    expect(arg.findings).toHaveLength(1);
    expect(arg.startedById).toBe(USER);
    const audit = mockDb.auditLog.create.mock.calls[0]?.[0] as { data: { changeType: string; after: Record<string, unknown> } };
    expect(audit.data.changeType).toBe("tax_review_run_started");
    expect(Object.keys(audit.data.after).sort()).toEqual(["counts", "engineVersion", "findingCount", "fingerprint", "l1Status", "runId", "taxYear"]);
    expect(JSON.stringify(audit.data.after)).not.toMatch(/expense|thing to look at/i);
  });

  it("a second click for the same return state within seconds returns the same run", async () => {
    build.runReviewForYear.mockResolvedValue(result());
    store.listRuns.mockResolvedValue([{ id: RUN, fingerprint: FP, startedAt: new Date() }]);
    const r = await runReviewChecks({ taxYear: 2025 });
    expect(r).toMatchObject({ ok: true, runId: RUN, reused: true });
    expect(store.insertReviewRun).not.toHaveBeenCalled();
  });

  it("an engine or loader error is reported and nothing is stored; a store failure says so in plain words", async () => {
    build.runReviewForYear.mockResolvedValue({ error: "The review could not read the return inputs." });
    expect(await runReviewChecks({ taxYear: 2025 })).toEqual({ ok: false, error: "The review could not read the return inputs." });
    expect(store.insertReviewRun).not.toHaveBeenCalled();
    build.runReviewForYear.mockResolvedValue(result());
    store.insertReviewRun.mockRejectedValue(Object.assign(new Error("relation does not exist"), { code: "P2021" }));
    const r = await runReviewChecks({ taxYear: 2025 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/migration/);
  });
});

describe("acceptFinding / reopenFinding", () => {
  it("records the acceptance with the reason for the owner's account, on the current run, and the audit row has ids only", async () => {
    const f = finding("L1.E2.expense-ratio");
    server.readReviewRecords.mockResolvedValue(recordsOf([f]));
    const r = await acceptFinding(acceptInput(f));
    expect(r).toEqual({ ok: true, dispositionId: "disp-1" });
    expect(store.insertDisposition).toHaveBeenCalledWith(expect.objectContaining({ taxYear: 2025, entityId: ENTITY, findingKey: f.key, evidenceHash: f.evidenceHash, action: "accepted", reason: REASON, byId: USER, byName: "Eric Kinniburgh" }));
    const audit = mockDb.auditLog.create.mock.calls[0]?.[0] as { data: { changeType: string; after: unknown } };
    expect(audit.data.changeType).toBe("tax_review_disposition");
    expect(JSON.stringify(audit.data.after)).not.toContain(REASON);
    expect(JSON.stringify(audit.data.after)).not.toContain("Eric");
  });

  it("only the owner's account may accept (spouse refused), and nothing is stored", async () => {
    server.loadReviewContext.mockResolvedValue({ ok: true, ctx: ctxOf({ approver: { allowed: false, ownerName: "Eric Kinniburgh", reason: "Only the owner's own account can approve the return or accept a finding." } }) });
    const f = finding("L1.x");
    const r = await acceptFinding(acceptInput(f));
    expect(r.ok).toBe(false);
    expect(store.insertDisposition).not.toHaveBeenCalled();
  });

  it("a finding that must be fixed (not acceptable) can never be accepted, whatever the reason", async () => {
    const f = finding("L1.F1.f1040.9", { severity: "blocker", acceptable: false });
    server.readReviewRecords.mockResolvedValue(recordsOf([f]));
    const r = await acceptFinding(acceptInput(f));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot be accepted/);
    expect(store.insertDisposition).not.toHaveBeenCalled();
  });

  it("is refused when the return changed after the checks ran (stale run) and for a finding that is not in the latest run", async () => {
    const f = finding("L1.x");
    server.readReviewRecords.mockResolvedValue(recordsOf([f], { latest: { run: runRow({ fingerprint: OTHER_FP }), findings: [f] } }));
    const stale = await acceptFinding(acceptInput(f));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toMatch(/changed/);
    server.readReviewRecords.mockResolvedValue(recordsOf([finding("L1.other")]));
    const missing = await acceptFinding(acceptInput(f));
    expect(missing.ok).toBe(false);
    expect(store.insertDisposition).not.toHaveBeenCalled();
  });

  it("reopening appends a 'reopened' row (the acceptance stays in the history)", async () => {
    const f = finding("L1.x");
    server.readReviewRecords.mockResolvedValue(recordsOf([f]));
    const r = await reopenFinding({ taxYear: 2025, findingKey: f.key, evidenceHash: f.evidenceHash });
    expect(r.ok).toBe(true);
    expect(store.insertDisposition).toHaveBeenCalledWith(expect.objectContaining({ action: "reopened" }));
  });
});

describe("approveReturn", () => {
  it("is IMPOSSIBLE at this phase: with the real gate the AI review passes and the independent recalculation have not run, so the gate is red and nothing is stored", async () => {
    // the real stateOf: L1 completed and clean, L2 / L3 not run
    server.readReviewRecords.mockResolvedValue(recordsOf([]));
    const r = await approveReturn(approvalInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/not PASSED/);
      expect(r.reasons?.join(" ")).toMatch(/not PASSED/);
    }
    expect(store.insertApproval).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });

  it("is impossible when the gate is red for any reason (open blocker, stale run, line override), even when everything is typed correctly", async () => {
    const blocker = finding("L1.F1.f1040.9", { severity: "blocker", acceptable: false });
    server.readReviewRecords.mockResolvedValue(recordsOf([blocker]));
    expect((await approveReturn(approvalInput)).ok).toBe(false);
    server.readReviewRecords.mockResolvedValue(recordsOf([], { latest: { run: runRow({ fingerprint: OTHER_FP }), findings: [] } }));
    server.stateOf.mockImplementationOnce((c: ReviewContext, rec: ReviewRecords) => ({ ...greenState(rec, c), gate: evaluateGate({ ...gateInput(rec, c), runFingerprint: OTHER_FP }) }));
    const stale = await approveReturn(approvalInput);
    expect(stale.ok).toBe(false);
    expect(store.insertApproval).not.toHaveBeenCalled();
  });

  function gateInput(rec: ReviewRecords, c: ReviewContext): GateInput {
    return {
      runFingerprint: rec.latest?.run.fingerprint ?? null,
      currentFingerprint: c.fingerprint,
      engine: c.engine,
      findings: rec.latest?.findings ?? [],
      dispositions: [],
      l1: { status: "completed" },
      l2: { status: "completed", coverageListed: true },
      l3: { status: "completed", adversarialCompleted: true },
    };
  }

  it("with a green gate (test-only state) it records the approval for the CURRENT fingerprint, hashes the text and what was typed, and audits ids/hashes only", async () => {
    const ctx = ctxOf();
    const rec = recordsOf([]);
    server.stateOf.mockImplementationOnce(() => greenState(rec, ctx));
    server.readReviewRecords.mockResolvedValue(rec);
    const r = await approveReturn(approvalInput);
    expect(r).toEqual({ ok: true, approvalId: "appr-1" });
    const arg = store.insertApproval.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg).toMatchObject({ kind: "approved", fingerprint: FP, runId: RUN, attestationVersion: "v1", approvedById: USER, approvedByName: "Eric Kinniburgh", reason: null });
    expect(arg["attestationTextHash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(arg["typedConfirmationHash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(arg["verdictSnapshot"])).not.toMatch(/Eric|message/);
    const audit = mockDb.auditLog.create.mock.calls[0]?.[0] as { data: { changeType: string; after: Record<string, unknown> } };
    expect(audit.data.changeType).toBe("tax_return_approved");
    expect(Object.keys(audit.data.after).sort()).toEqual(["approvalId", "attestationTextHash", "attestationVersion", "fingerprint", "gate", "runId", "taxYear", "typedConfirmationHash"]);
    expect(JSON.stringify(audit.data.after)).not.toContain("Eric");
    expect(JSON.stringify(audit.data.after)).not.toContain(TYPED_PHRASE);
  });

  it("the fingerprint is recomputed on the server for every call: the loader runs again and a changed return refuses the second approval", async () => {
    const rec = recordsOf([]);
    server.readReviewRecords.mockResolvedValue(rec);
    server.stateOf.mockImplementationOnce((c: ReviewContext) => greenState(rec, c));
    expect((await approveReturn(approvalInput)).ok).toBe(true);
    expect(server.loadReviewContext).toHaveBeenCalledTimes(1);
    // the return changes: the loader now computes another fingerprint, the stored run no longer matches
    server.loadReviewContext.mockResolvedValue({ ok: true, ctx: ctxOf({ fingerprint: OTHER_FP }) });
    const second = await approveReturn(approvalInput);
    expect(second.ok).toBe(false);
    expect(server.loadReviewContext).toHaveBeenCalledTimes(2);
    expect(store.insertApproval).toHaveBeenCalledTimes(1);
  });

  it("only the owner's account (D5), with the exact text, phrase, full name and the box ticked", async () => {
    const ctx = ctxOf();
    const rec = recordsOf([]);
    server.readReviewRecords.mockResolvedValue(rec);
    server.stateOf.mockImplementation(() => greenState(rec, ctx));
    server.loadReviewContext.mockResolvedValue({ ok: true, ctx: ctxOf({ approver: { allowed: false, ownerName: "Eric Kinniburgh", reason: "Only the owner's own account can approve the return or accept a finding." } }) });
    expect((await approveReturn(approvalInput)).ok).toBe(false);
    server.loadReviewContext.mockResolvedValue({ ok: true, ctx });
    expect((await approveReturn({ ...approvalInput, checked: false })).ok).toBe(false);
    expect((await approveReturn({ ...approvalInput, attestationText: "I agree" })).ok).toBe(false);
    expect((await approveReturn({ ...approvalInput, typedPhrase: "i prepared this return please" })).ok).toBe(false);
    expect((await approveReturn({ ...approvalInput, typedName: "Eva Ramirez" })).ok).toBe(false);
    expect(store.insertApproval).not.toHaveBeenCalled();
    expect((await approveReturn(approvalInput)).ok).toBe(true);
  });

  it("an already-approved current return is not approved twice", async () => {
    const ctx = ctxOf();
    const approved: ApprovalDetail = { id: "appr-0", kind: "approved", fingerprint: FP, at: new Date("2026-10-06T10:00:00Z"), runId: RUN, approvedByName: "Eric Kinniburgh" };
    server.readReviewRecords.mockResolvedValue(recordsOf([], { approvals: [approved] }));
    server.stateOf.mockImplementation((c: ReviewContext, rec: ReviewRecords) => greenState(rec, c));
    const r = await approveReturn(approvalInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already approved/);
    expect(ctx.fingerprint).toBe(FP);
  });
});

describe("withdrawApproval", () => {
  const approved = (fp = FP): ApprovalDetail => ({ id: "appr-0", kind: "approved", fingerprint: fp, at: new Date("2026-10-06T10:00:00Z"), runId: RUN, approvedByName: "Eric Kinniburgh" });

  it("appends a 'withdrawn' row with the reason (never a delete) and audits ids only", async () => {
    server.readReviewRecords.mockResolvedValue(recordsOf([], { approvals: [approved()] }));
    const r = await withdrawApproval({ taxYear: 2025, reason: "Found a mistake in a W-2 box." });
    expect(r).toEqual({ ok: true, approvalId: "appr-1" });
    expect(store.insertApproval).toHaveBeenCalledWith(expect.objectContaining({ kind: "withdrawn", fingerprint: FP, runId: RUN, reason: "Found a mistake in a W-2 box.", attestationVersion: null }));
    const audit = mockDb.auditLog.create.mock.calls[0]?.[0] as { data: { changeType: string; after: unknown } };
    expect(audit.data.changeType).toBe("tax_return_approval_withdrawn");
    expect(JSON.stringify(audit.data.after)).not.toContain("W-2");
  });

  it("works on a stale approval too (the return changed since), and needs an approval in force", async () => {
    server.readReviewRecords.mockResolvedValue(recordsOf([], { approvals: [approved(OTHER_FP)] }));
    expect((await withdrawApproval({ taxYear: 2025, reason: "Starting over." })).ok).toBe(true);
    const withdrawnAlready: ApprovalDetail[] = [approved(), { ...approved(), id: "appr-2", kind: "withdrawn", at: new Date("2026-10-07T10:00:00Z") }];
    server.readReviewRecords.mockResolvedValue(recordsOf([], { approvals: withdrawnAlready }));
    store.insertApproval.mockClear();
    const none = await withdrawApproval({ taxYear: 2025, reason: "Again." });
    expect(none.ok).toBe(false);
    expect(store.insertApproval).not.toHaveBeenCalled();
  });

  it("only the owner's account may withdraw, and a reason is required", async () => {
    server.readReviewRecords.mockResolvedValue(recordsOf([], { approvals: [approved()] }));
    server.loadReviewContext.mockResolvedValue({ ok: true, ctx: ctxOf({ approver: { allowed: false, ownerName: "Eric Kinniburgh", reason: "Only the owner's own account can approve the return or accept a finding." } }) });
    expect((await withdrawApproval({ taxYear: 2025, reason: "Because." })).ok).toBe(false);
    expect((await withdrawApproval({ taxYear: 2025, reason: "" })).ok).toBe(false);
    expect(store.insertApproval).not.toHaveBeenCalled();
  });
});

describe("listing", () => {
  it("lists runs newest first with the 'current' flag computed against the recomputed fingerprint", async () => {
    store.listRuns.mockResolvedValue([runRow({ id: "r2", fingerprint: OTHER_FP }), runRow({ id: "r1" })]);
    const r = await listReviewRuns({ taxYear: 2025 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.runs.map((x) => [x.id, x.isCurrent])).toEqual([["r2", false], ["r1", true]]);
  });
  it("opens a past run read-only with its findings and shows an acceptance made on a finding", async () => {
    const f = finding("L1.x");
    const disp: DispositionDetail = { findingKey: f.key, evidenceHash: f.evidenceHash, action: "accepted", reason: REASON, at: new Date("2026-10-05T11:00:00Z"), byName: "Eric Kinniburgh" };
    store.getRunWithFindings.mockResolvedValue({ run: runRow(), findings: [f] });
    server.readReviewRecords.mockResolvedValue(recordsOf([f], { dispositions: [disp] }));
    const r = await getReviewRun({ taxYear: 2025, runId: RUN });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.findings[0]).toMatchObject({ status: "accepted", acceptedReason: REASON, acceptedBy: "Eric Kinniburgh" });
    }
    store.getRunWithFindings.mockResolvedValue(null);
    expect((await getReviewRun({ taxYear: 2025, runId: RUN })).ok).toBe(false);
  });
});
