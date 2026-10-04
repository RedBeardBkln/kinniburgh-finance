import { describe, expect, it } from "vitest";
import { resolveApprover } from "@/lib/tax-review/approver";
import { approvalInForce } from "@/lib/tax-review/gate";
import { buildReviewState, gateInputFor, layerStateOf, l1StateOf, NOT_RUN_NOTICE, pickRun, toFindingDto, type ApprovalDetail, type DispositionDetail, type RunRowLike } from "@/lib/tax-review/state";
import { makeFinding, type Finding } from "@/lib/tax-review/types";

const FP = "a".repeat(64);
const OTHER = "b".repeat(64);
const ERIC = { id: "u-eric", name: "Eric Kinniburgh" };
const EVA = { id: "u-eva", name: "Eva-Laura Ramirez-Wisiackas" };
const EKC = "Eric Kinniburgh Consulting, LLC";

function finding(check: string, over: Partial<Parameters<typeof makeFinding>[0]> = {}): Finding {
  return makeFinding({ layer: "L1", check, severity: "medium", area: "tax", message: "A thing to look at.", evidence: [{ ref: "f1040.9", amount: 5, status: "computed" }], recommendedAction: "Look.", acceptable: true, ...over });
}
function run(over: Partial<RunRowLike> = {}): RunRowLike {
  return { id: "r1", fingerprint: FP, engineVersion: "e", startedAt: "2026-10-05T10:00:00.000Z", startedByName: "Eric Kinniburgh", l1Summary: { status: "completed", counts: { blocker: 1, high: 0, medium: 2, low: 0, info: 3 } }, l2Summary: { status: "not_run", coverage: [] }, ...over };
}
const engine = { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 };
const approver = { allowed: true, ownerName: "Eric Kinniburgh", reason: null };

describe("who may approve (D5 / D6)", () => {
  it("is the one user whose full name matches the consulting entity, and only when he is the signed-in account", () => {
    expect(resolveApprover([ERIC, EVA], EKC, ERIC.id)).toEqual({ allowed: true, ownerName: "Eric Kinniburgh", reason: null });
    const spouse = resolveApprover([ERIC, EVA], EKC, EVA.id);
    expect(spouse.allowed).toBe(false);
    expect(spouse.reason).toMatch(/owner's own account/);
  });
  it("fails closed when the entity is unknown, no user matches, or two do", () => {
    expect(resolveApprover([ERIC, EVA], null, ERIC.id).allowed).toBe(false);
    expect(resolveApprover([ERIC, EVA], "  ", ERIC.id).allowed).toBe(false);
    expect(resolveApprover([EVA], EKC, EVA.id).allowed).toBe(false);
    expect(resolveApprover([ERIC, { id: "u-2", name: "Eric Kinniburgh" }], EKC, ERIC.id).allowed).toBe(false);
    expect(resolveApprover([], EKC, ERIC.id).allowed).toBe(false);
  });
  it("a first name alone is not enough to be named the owner when another user shares it only partly", () => {
    // 'Evan' is not 'Eric': the match is by full name containment (score 2) or the same first word (score 1); a lone first-word tie is ambiguous
    const r = resolveApprover([{ id: "u-3", name: "Eric Other" }, ERIC], EKC, "u-3");
    expect(r.allowed).toBe(false);
    expect(resolveApprover([{ id: "u-3", name: "Eric Other" }, ERIC], EKC, ERIC.id).allowed).toBe(true);
  });
});

describe("layer states and the gate input of a run", () => {
  it("L1 counts as completed only on an explicit 'completed'; L2 / L3 are not run at this phase whatever a stored summary claims", () => {
    expect(l1StateOf({ status: "completed" })).toBe("completed");
    for (const bad of [null, undefined, {}, { status: "ok" }, { status: "failed" }, "completed"]) expect(l1StateOf(bad)).toBe("failed");
    expect(layerStateOf({ status: "not_run" })).toBe("not_run");
    expect(layerStateOf(null)).toBe("not_run");
    expect(layerStateOf({ status: "weird" })).toBe("not_run");
    const input = gateInputFor({ run: run({ l2Summary: { status: "completed", coverage: [{ a: 1 }] } }), findings: [], dispositions: [], currentFingerprint: FP, engine });
    expect(input.l3).toEqual({ status: "not_run", adversarialCompleted: false });
    expect(input.l1.status).toBe("completed");
  });
  it("no run at all: nothing has been run", () => {
    const input = gateInputFor({ run: null, findings: [], dispositions: [], currentFingerprint: FP, engine });
    expect(input.runFingerprint).toBeNull();
    expect(input.l1.status).toBe("not_run");
  });
  it("pickRun prefers the newest run made for the CURRENT return, else the newest", () => {
    const runs = [run({ id: "new-stale", fingerprint: OTHER }), run({ id: "old-current" })];
    expect(pickRun(runs, FP)?.id).toBe("old-current");
    expect(pickRun(runs, "c".repeat(64))?.id).toBe("new-stale");
    expect(pickRun([], FP)).toBeNull();
  });
});

describe("buildReviewState", () => {
  const base = { currentFingerprint: FP, engine, runs: [run()], dispositions: [] as DispositionDetail[], approvals: [] as ApprovalDetail[], approver };

  it("with L2 and L3 not run the gate is red, the plain notice is there and approval cannot be done now (no waiver)", () => {
    const s = buildReviewState({ ...base, latest: { run: run(), findings: [] } });
    expect(s.gate.verdict).toBe("flagged");
    expect(s.notRunNotice).toBe(NOT_RUN_NOTICE);
    expect(NOT_RUN_NOTICE).toBe("Independent recalculation and AI review passes not run yet: required before approval.");
    expect(s.canApproveNow).toBe(false);
    expect(s.gate.items.find((i) => i.id === "l2")?.state).toBe("not_run");
    expect(s.gate.items.find((i) => i.id === "l3")?.state).toBe("not_run");
    expect(s.currentFingerprint12).toBe(FP.slice(0, 12));
    expect(JSON.stringify(s)).not.toContain(FP); // only the short form leaves the server
  });

  it("no run: the notice still says what is missing and the run is null", () => {
    const s = buildReviewState({ ...base, runs: [], latest: null });
    expect(s.latestRun).toBeNull();
    expect(s.runIsStale).toBe(false);
    expect(s.gate.items.find((i) => i.id === "fingerprint")?.state).toBe("not_run");
  });

  it("a run for an older return state is stale", () => {
    const s = buildReviewState({ ...base, latest: { run: run({ fingerprint: OTHER }), findings: [] } });
    expect(s.runIsStale).toBe(true);
    expect(s.latestRun?.isCurrent).toBe(false);
    expect(s.gate.items.find((i) => i.id === "fingerprint")?.state).toBe("fail");
  });

  it("findings carry status and gating: an open blocker gates, an accepted medium shows who accepted it and why", () => {
    const blocker = finding("L1.F1.f1040.9", { severity: "blocker", acceptable: false });
    const medium = finding("L1.E2.expense-ratio");
    const disp: DispositionDetail = { findingKey: medium.key, evidenceHash: medium.evidenceHash, action: "accepted", reason: "Startup year, the ratio is right.", at: "2026-10-05T11:00:00.000Z", byName: "Eric Kinniburgh" };
    const s = buildReviewState({ ...base, dispositions: [disp], latest: { run: run(), findings: [blocker, medium] } });
    expect(s.findings.find((f) => f.check === "L1.F1.f1040.9")).toMatchObject({ status: "open", gating: true, acceptable: false });
    expect(s.findings.find((f) => f.check === "L1.E2.expense-ratio")).toMatchObject({ status: "accepted", gating: false, acceptedBy: "Eric Kinniburgh", acceptedReason: "Startup year, the ratio is right." });
    expect(s.totals).toEqual({ findings: 2, open: 1, accepted: 1, gatingOpen: 1 });
  });

  it("an acceptance never applies to a finding that cannot be accepted, nor after its evidence changed", () => {
    const blocker = finding("L1.F1.f1040.9", { severity: "blocker", acceptable: false });
    const dispBlocker: DispositionDetail = { findingKey: blocker.key, evidenceHash: blocker.evidenceHash, action: "accepted", reason: "Looks fine to me.", at: "2026-10-05T11:00:00.000Z", byName: "x" };
    expect(toFindingDto(blocker, [dispBlocker]).status).toBe("open");
    const medium = finding("L1.E2.expense-ratio");
    const stale: DispositionDetail = { findingKey: medium.key, evidenceHash: "0".repeat(16), action: "accepted", reason: "Looks fine to me.", at: "2026-10-05T11:00:00.000Z", byName: "x" };
    expect(toFindingDto(medium, [stale]).status).toBe("open");
  });

  it("approval flags: in force and current, in force but stale, withdrawn", () => {
    const approved: ApprovalDetail = { id: "a1", kind: "approved", fingerprint: FP, at: "2026-10-06T10:00:00.000Z", runId: "r1", approvedByName: "Eric Kinniburgh" };
    const withdrawn: ApprovalDetail = { id: "a2", kind: "withdrawn", fingerprint: FP, at: "2026-10-07T10:00:00.000Z", runId: "r1", approvedByName: "Eric Kinniburgh" };
    const latest = { run: run(), findings: [] };
    expect(buildReviewState({ ...base, latest, approvals: [approved] }).approval).toMatchObject({ inForce: true, current: true, approvedByName: "Eric Kinniburgh", fingerprint12: FP.slice(0, 12) });
    expect(buildReviewState({ ...base, latest, currentFingerprint: OTHER, approvals: [approved] }).approval).toMatchObject({ inForce: true, current: false });
    expect(buildReviewState({ ...base, latest, approvals: [approved, withdrawn] }).approval).toMatchObject({ inForce: false, current: false, approvedByName: null });
    expect(approvalInForce([approved, withdrawn])).toBeNull();
    expect(approvalInForce([{ ...withdrawn, at: "2026-10-05T10:00:00.000Z" }, approved])?.id).toBe("a1");
  });

  it("the state is JSON-safe (no Date) and holds no value of the return beyond the findings' own text", () => {
    const s = buildReviewState({ ...base, latest: { run: run({ startedAt: new Date("2026-10-05T10:00:00Z") }), findings: [finding("L1.x")] } });
    const round = JSON.parse(JSON.stringify(s)) as typeof s;
    expect(round.latestRun?.startedAt).toBe("2026-10-05T10:00:00.000Z");
    expect(Object.keys(s).sort()).toEqual(["approval", "approver", "canApproveNow", "currentFingerprint12", "findings", "gate", "latestRun", "notRunNotice", "runIsStale", "runs", "totals", "year"]);
  });
});
