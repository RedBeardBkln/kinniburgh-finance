import { describe, expect, it } from "vitest";
import { evaluateGate, type GateInput } from "@/lib/tax-review/gate";
import { buildReviewState, type FindingDto } from "@/lib/tax-review/state";
import { checkAcceptForm, checkApprovalForm, checkReason, DEFAULT_FILTERS, filterFindings, formatNewYork, areasPresent, severityCountsOf, toggleSeverity, verdictChip, reasonCounter, gateStateLabel } from "@/lib/tax-review/ui";
import { TYPED_PHRASE } from "@/lib/tax-review/limits";

function dto(over: Partial<FindingDto> = {}): FindingDto {
  return {
    key: "0".repeat(16),
    evidenceHash: "1".repeat(16),
    layer: "L1",
    check: "L1.E2.expense-ratio",
    severity: "medium",
    area: "income",
    formKey: "f1040sc",
    lineKey: "schc.28",
    message: "Schedule C expenses are high.",
    evidence: [],
    citation: { sources: [], sourceStatus: "not_applicable" },
    recommendedAction: "Check.",
    acceptable: true,
    status: "open",
    gating: false,
    acceptedReason: null,
    acceptedBy: null,
    acceptedAt: null,
    ...over,
  };
}

const FINDINGS: FindingDto[] = [
  dto({ key: "a".repeat(16), severity: "blocker", area: "tax", gating: true, acceptable: false, message: "Line 9 does not add up", check: "L1.F1.f1040.9", formKey: "f1040", lineKey: "f1040.9" }),
  dto({ key: "b".repeat(16), severity: "medium", area: "income", message: "Expenses are high" }),
  dto({ key: "c".repeat(16), severity: "info", area: "forms", message: "Lines left blank", check: "L1.B5.unmodeled", formKey: "f1040s2", lineKey: null }),
  dto({ key: "d".repeat(16), severity: "medium", area: "income", status: "accepted", acceptedReason: "Startup year", message: "Another high ratio" }),
];

describe("filters", () => {
  it("no filter shows everything; severities combine; area, status and text narrow", () => {
    expect(filterFindings(FINDINGS, DEFAULT_FILTERS)).toHaveLength(4);
    expect(filterFindings(FINDINGS, { ...DEFAULT_FILTERS, severities: ["blocker", "info"] }).map((f) => f.severity)).toEqual(["blocker", "info"]);
    expect(filterFindings(FINDINGS, { ...DEFAULT_FILTERS, area: "income" })).toHaveLength(2);
    expect(filterFindings(FINDINGS, { ...DEFAULT_FILTERS, status: "open" })).toHaveLength(3);
    expect(filterFindings(FINDINGS, { ...DEFAULT_FILTERS, status: "gating" }).map((f) => f.severity)).toEqual(["blocker"]);
    expect(filterFindings(FINDINGS, { ...DEFAULT_FILTERS, status: "accepted" }).map((f) => f.key)).toEqual(["d".repeat(16)]);
    expect(filterFindings(FINDINGS, { ...DEFAULT_FILTERS, text: "  UNMODELED " }).map((f) => f.check)).toEqual(["L1.B5.unmodeled"]);
    expect(filterFindings(FINDINGS, { ...DEFAULT_FILTERS, text: "f1040.9" })).toHaveLength(1);
    expect(filterFindings(FINDINGS, { severities: ["medium"], area: "income", status: "open", text: "expenses" })).toHaveLength(1);
  });
  it("toggleSeverity adds and removes; counts and areas come from the findings", () => {
    expect(toggleSeverity([], "high")).toEqual(["high"]);
    expect(toggleSeverity(["high", "low"], "high")).toEqual(["low"]);
    expect(severityCountsOf(FINDINGS)).toEqual({ blocker: 1, high: 0, medium: 2, low: 0, info: 1 });
    expect(areasPresent(FINDINGS)).toEqual(["forms", "income", "tax"]);
  });
});

describe("reason (accept / withdraw)", () => {
  it("3 to 500 characters, trimmed; an empty field shows no error yet", () => {
    expect(checkReason("")).toEqual({ ok: false, error: null, length: 0 });
    expect(checkReason("  ok ").ok).toBe(false);
    expect(checkReason("ok!").ok).toBe(true);
    expect(checkReason("x".repeat(500)).ok).toBe(true);
    const long = checkReason("x".repeat(501));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toMatch(/500/);
    expect(reasonCounter("  abc ")).toBe("3 / 500");
  });
  it("SSN-like text, an employer ID and a long number are refused (the server refuses them too)", () => {
    for (const bad of ["Notice 123-45-6789", "12-3456789 confirmed", "account 123456789012", "123 45 6789"]) {
      const r = checkReason(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Social Security/);
    }
  });
  it("Accept is enabled only for a finding that may be accepted, with a valid reason, and not while busy", () => {
    expect(checkAcceptForm({ reason: "Looked at it.", busy: false, acceptable: true }).canAccept).toBe(true);
    expect(checkAcceptForm({ reason: "Looked at it.", busy: true, acceptable: true }).canAccept).toBe(false);
    expect(checkAcceptForm({ reason: "Looked at it.", busy: false, acceptable: false }).canAccept).toBe(false);
    expect(checkAcceptForm({ reason: "no", busy: false, acceptable: true })).toEqual({ canAccept: false, reasonError: "Write at least 3 characters." });
  });
});

describe("approval form", () => {
  const ok = { checked: true, typedPhrase: TYPED_PHRASE, typedName: "Eric Kinniburgh", busy: false, gateGreen: true, accountAllowed: true, alreadyApproved: false };
  it("is enabled only when the gate is green, the account is the owner's, the box is ticked, the phrase and a name are typed", () => {
    expect(checkApprovalForm(ok)).toEqual({ canApprove: true, blockers: [] });
    expect(checkApprovalForm({ ...ok, gateGreen: false }).canApprove).toBe(false);
    expect(checkApprovalForm({ ...ok, accountAllowed: false }).canApprove).toBe(false);
    expect(checkApprovalForm({ ...ok, checked: false }).canApprove).toBe(false);
    expect(checkApprovalForm({ ...ok, typedPhrase: "i prepared this return" }).canApprove).toBe(false);
    expect(checkApprovalForm({ ...ok, typedName: "  " }).canApprove).toBe(false);
    expect(checkApprovalForm({ ...ok, busy: true }).canApprove).toBe(false);
    expect(checkApprovalForm({ ...ok, alreadyApproved: true }).canApprove).toBe(false);
  });
  it("a red gate is explained in plain words and there is no override of it", () => {
    const r = checkApprovalForm({ ...ok, gateGreen: false });
    expect(r.blockers.join(" ")).toMatch(/not passed yet/);
    // nothing in the state of the form can turn a red gate into an enabled button
    for (const checked of [true, false]) for (const busy of [true, false]) expect(checkApprovalForm({ ...ok, gateGreen: false, checked, busy }).canApprove).toBe(false);
  });
});

describe("verdict chip and labels", () => {
  const green: GateInput = {
    runFingerprint: "a".repeat(64),
    currentFingerprint: "a".repeat(64),
    engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 },
    findings: [],
    dispositions: [],
    l1: { status: "completed" },
    l2: { status: "completed", coverageListed: true },
    l3: { status: "completed", adversarialCompleted: true },
  };
  const run = { id: "r", fingerprint: "a".repeat(64), engineVersion: "e", startedAt: "2026-10-05T10:00:00.000Z", startedByName: "x", l1Summary: { status: "completed" }, l2Summary: null };
  const base = { currentFingerprint: "a".repeat(64), engine: green.engine, runs: [run], dispositions: [], approvals: [], approver: { allowed: true, ownerName: "x", reason: null } };

  it("not run / stale / flagged (counts the open blockers) / passed", () => {
    expect(verdictChip(buildReviewState({ ...base, runs: [], latest: null })).label).toBe("AI review: not run");
    expect(verdictChip(buildReviewState({ ...base, latest: { run: { ...run, fingerprint: "b".repeat(64) }, findings: [] } })).tone).toBe("warn");
    const flagged = verdictChip(buildReviewState({ ...base, latest: { run, findings: [] } }));
    expect(flagged.tone).toBe("bad");
    expect(flagged.label).toMatch(/^AI review: FLAGGED \(0 open blocker\/high items\)$/);
    const passedGate = evaluateGate(green);
    expect(verdictChip({ latestRun: { id: "r", startedAt: "", startedByName: "", fingerprint12: "aaaaaaaaaaaa", isCurrent: true, engineVersion: "e", counts: null, l1Status: "completed" }, runIsStale: false, gate: passedGate, currentFingerprint12: "aaaaaaaaaaaa" })).toEqual({ tone: "ok", label: "AI review: PASSED for aaaaaaaaaaaa" });
  });
  it("gate state labels and New York time", () => {
    expect([gateStateLabel("pass"), gateStateLabel("fail"), gateStateLabel("not_run")]).toEqual(["Passed", "Not passed", "Not run yet"]);
    expect(formatNewYork("2026-10-05T14:30:00.000Z")).toMatch(/Oct 5, 2026/);
    expect(formatNewYork("nonsense")).toBe("unknown time");
  });
});
