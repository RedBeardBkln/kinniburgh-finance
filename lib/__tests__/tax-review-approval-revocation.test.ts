import { describe, expect, it } from "vitest";
import { approvalRevocationReasons, currentApproval, NO_REVOCATION_FACTS, type ApprovalRevocationFacts, type DispositionRow } from "@/lib/tax-review/gate";
import { makeFinding, type Finding, type FindingDraft } from "@/lib/tax-review/types";

// The pure rule that revokes an approval AFTER it was recorded (integration review, observation O3). The same rule runs behind the page and the
// clean-copy routes; the end-to-end cases over the real actions are in tax-review-tester-all.test.ts ("approval revocation after the approval").

const FP = "a".repeat(64);
const T0 = "2026-10-05T10:00:00Z";
const A = { kind: "approved" as const, fingerprint: FP, at: T0 };
const LATER = "2026-10-05T11:00:00Z";
const EARLIER = "2026-10-05T09:00:00Z";

function f(check: string, over: Partial<FindingDraft> = {}): Finding {
  return makeFinding({ layer: "L2", check, severity: "high", area: "tax", message: "A thing differs.", evidence: [{ ref: "f1040.9", amount: 1, status: "computed" }], recommendedAction: "Look.", acceptable: true, ...over });
}

const disposition = (finding: Finding, action: "accepted" | "reopened", at: string, over: Partial<DispositionRow> = {}): DispositionRow => ({
  findingKey: finding.key,
  evidenceHash: finding.evidenceHash,
  action,
  reason: action === "accepted" ? "Looked at it and the return stands." : "Reopened",
  at,
  ...over,
});

const facts = (over: Partial<ApprovalRevocationFacts>): ApprovalRevocationFacts => ({ ...NO_REVOCATION_FACTS, ...over });

describe("approvalRevocationReasons", () => {
  it("nothing recorded: not revoked", () => {
    expect(approvalRevocationReasons(A, NO_REVOCATION_FACTS)).toEqual([]);
    expect(currentApproval([A], FP, NO_REVOCATION_FACTS)).toEqual(A);
  });

  it("a blocking finding that is accepted (before the approval) stays closed", () => {
    const b = f("L2.diff.x");
    expect(approvalRevocationReasons(A, facts({ findings: [b], dispositions: [disposition(b, "accepted", EARLIER)] }))).toEqual([]);
  });

  it("a finding reopened after the approval revokes it (open again)", () => {
    const b = f("L2.diff.x");
    const reasons = approvalRevocationReasons(A, facts({ findings: [b], dispositions: [disposition(b, "accepted", EARLIER), disposition(b, "reopened", LATER)] }));
    expect(reasons.join(" ")).toMatch(/1 finding that blocks approval is open again/);
    expect(currentApproval([A], FP, facts({ findings: [b], dispositions: [disposition(b, "accepted", EARLIER), disposition(b, "reopened", LATER)] }))).toBeNull();
  });

  it("a reopen followed by a fresh acceptance still revokes (decided again after the approval); the same pair BEFORE the approval does not", () => {
    const b = f("L2.diff.x");
    const after = facts({ findings: [b], dispositions: [disposition(b, "accepted", EARLIER), disposition(b, "reopened", LATER), disposition(b, "accepted", "2026-10-05T12:00:00Z")] });
    expect(approvalRevocationReasons(A, after).join(" ")).toMatch(/reopened or decided again after the approval/);
    const before = facts({ findings: [b], dispositions: [disposition(b, "reopened", "2026-10-05T08:00:00Z"), disposition(b, "accepted", EARLIER)] });
    expect(approvalRevocationReasons(A, before)).toEqual([]);
  });

  it("a new open blocking finding revokes; a non-blocking open finding (medium, acceptable) does not", () => {
    const high = f("L2.diff.new");
    const medium = f("L2.diff.minor", { severity: "medium" });
    expect(approvalRevocationReasons(A, facts({ findings: [high] })).join(" ")).toMatch(/open again/);
    expect(approvalRevocationReasons(A, facts({ findings: [medium] }))).toEqual([]);
  });

  it("a blocker that cannot be accepted is blocking whatever the severity label, and a decision on a non-blocking finding after the approval is irrelevant", () => {
    const fixMe = f("L1.B1.fix", { severity: "medium", acceptable: false });
    expect(approvalRevocationReasons(A, facts({ findings: [fixMe] })).join(" ")).toMatch(/open again/);
    const medium = f("L2.diff.minor", { severity: "medium" });
    expect(approvalRevocationReasons(A, facts({ findings: [medium], dispositions: [disposition(medium, "accepted", LATER)] }))).toEqual([]);
  });

  it("a decision on a blocking finding of ANOTHER state (different evidence hash) never closes it: it is open, so the approval is revoked", () => {
    const b = f("L2.diff.x");
    expect(approvalRevocationReasons(A, facts({ findings: [b], dispositions: [disposition(b, "accepted", EARLIER, { evidenceHash: "0".repeat(16) })] })).join(" ")).toMatch(/open again/);
  });

  it("an AI review cancelled after the approval revokes it; one cancelled before it, or at the same instant, does not", () => {
    expect(approvalRevocationReasons(A, facts({ aiCancelledAt: [LATER] })).join(" ")).toMatch(/AI review was cancelled after the approval/);
    expect(approvalRevocationReasons(A, facts({ aiCancelledAt: [EARLIER, T0] }))).toEqual([]);
    expect(approvalRevocationReasons(A, facts({ aiCancelledAt: [new Date("2026-10-05T11:00:00Z")] })).length).toBe(1);
  });

  it("reasons add up and an unparseable timestamp is treated as the epoch (it can not revoke by accident)", () => {
    const b = f("L2.diff.x");
    expect(approvalRevocationReasons(A, facts({ findings: [b], aiCancelledAt: [LATER] })).length).toBe(2);
    expect(approvalRevocationReasons(A, facts({ aiCancelledAt: ["not a date"] }))).toEqual([]);
  });
});

describe("a read failure revokes (fail closed)", () => {
  it("facts that say the approved run could not be read revoke the approval, whatever else they hold", () => {
    const failed = facts({ readFailure: "the review run this approval was recorded against could not be read" });
    expect(approvalRevocationReasons(A, failed).join(" ")).toMatch(/could not be read/);
    expect(currentApproval([A], FP, failed)).toBeNull();
  });
});

describe("currentApproval with revocation facts", () => {
  const W = { kind: "withdrawn" as const, fingerprint: FP, at: LATER };
  it("still needs the fingerprint and the latest word to be an approval", () => {
    const b = f("L2.diff.x");
    expect(currentApproval([A], "b".repeat(64), NO_REVOCATION_FACTS)).toBeNull();
    expect(currentApproval([A, W], FP, NO_REVOCATION_FACTS)).toBeNull();
    expect(currentApproval([A], FP, facts({ findings: [b] }))).toBeNull();
  });
  it("a NEW approval after the revoking event is current again (the decision was the owner's, made later)", () => {
    const b = f("L2.diff.x");
    const reopened = facts({ findings: [b], dispositions: [disposition(b, "accepted", EARLIER), disposition(b, "reopened", LATER), disposition(b, "accepted", "2026-10-05T12:00:00Z")] });
    const A2 = { kind: "approved" as const, fingerprint: FP, at: "2026-10-05T13:00:00Z" };
    expect(currentApproval([A, A2], FP, reopened)).toEqual(A2);
  });
});
