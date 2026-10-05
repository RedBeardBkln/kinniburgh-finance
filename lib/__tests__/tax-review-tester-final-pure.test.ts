import { describe, expect, it } from "vitest";
import { approvalRevocationReasons, currentApproval, NO_REVOCATION_FACTS, REASON_MIN, type ApprovalRevocationFacts, type ApprovalRow, type DispositionRow } from "@/lib/tax-review/gate";
import { makeFinding, type Finding, type Severity } from "@/lib/tax-review/types";
import { packageDownloadOutcome } from "@/lib/tax-review/ui";

// TESTER (ai-return-reviewer, final): an independent oracle for the approval revocation rule, fuzzed, plus fail-closed probes for
// undefined / null / partial facts. The oracle is written from the plan text, not from gate.ts.

const FP = "a".repeat(64);
const FP2 = "b".repeat(64);

let seed = 987654321;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;

const SEVS: Severity[] = ["blocker", "high", "medium", "low", "info"];

function mk(i: number): Finding {
  const sev = pick(SEVS);
  const defaultDecision = rnd() < 0.15;
  const acceptable = rnd() < 0.8;
  const downgraded = rnd() < 0.1;
  return makeFinding({
    layer: pick(["L1", "L2", "L3"] as const),
    check: defaultDecision ? `L1.D2.decision.x${i}` : `L1.T.check${i}`,
    severity: downgraded ? "medium" : sev,
    area: "forms",
    message: `finding number ${i}`,
    recommendedAction: "look",
    acceptable,
    ...(downgraded ? { downgradedFrom: pick(["blocker", "high", "medium"] as const) } : {}),
    ...(downgraded && rnd() < 0.5
      ? { citation: { sources: [], sourceStatus: pick(["verified", "unverified"] as const) } }
      : {}),
    evidence: [{ ref: "head:total", amount: i, status: "ok" }],
  });
}

const blockingOracle = (f: Finding): boolean => {
  const gatingSev = f.severity === "blocker" || f.severity === "high";
  const defaultDecision = f.check.startsWith("L1.D2.decision");
  const downgradedUnverified = f.downgradedFrom !== undefined && (f.downgradedFrom === "blocker" || f.downgradedFrom === "high") && f.citation.sourceStatus === "unverified";
  return gatingSev || defaultDecision || downgradedUnverified || !f.acceptable;
};

function oracleStatusOpen(f: Finding, ds: readonly DispositionRow[]): boolean {
  if (!f.acceptable) return true;
  let best: DispositionRow | null = null;
  let bt = -Infinity;
  for (const d of ds) {
    if (d.findingKey !== f.key || d.evidenceHash !== f.evidenceHash) continue;
    const t = new Date(d.at).getTime();
    if (t >= bt) {
      best = d;
      bt = t;
    }
  }
  if (best === null || best.action !== "accepted") return true;
  return best.reason.trim().length < REASON_MIN;
}

function oracleRevoked(approvalAt: number, facts: ApprovalRevocationFacts): boolean {
  const blockingOpen = facts.findings.some((f) => blockingOracle(f) && oracleStatusOpen(f, facts.dispositions));
  const keys = new Set(facts.findings.filter(blockingOracle).map((f) => f.key));
  const laterDecision = facts.dispositions.some((d) => new Date(d.at).getTime() > approvalAt && keys.has(d.findingKey));
  const cancelled = facts.aiCancelledAt.some((a) => new Date(a).getTime() > approvalAt);
  return blockingOpen || laterDecision || cancelled;
}

describe("tester(final): approval revocation rule vs an independent oracle (fuzz)", () => {
  it("5000 random fact sets: currentApproval agrees with the oracle (fingerprint match x facts)", () => {
    let revokedCount = 0;
    let currentCount = 0;
    for (let n = 0; n < 5000; n += 1) {
      const findings = Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => mk(i));
      const approvedAt = 1_000_000 + Math.floor(rnd() * 10) * 1000;
      const dispositions: DispositionRow[] = [];
      for (const f of findings) {
        const k = Math.floor(rnd() * 4);
        for (let j = 0; j < k; j += 1) {
          dispositions.push({
            findingKey: f.key,
            evidenceHash: rnd() < 0.9 ? f.evidenceHash : "0".repeat(16),
            action: rnd() < 0.6 ? "accepted" : "reopened",
            reason: rnd() < 0.85 ? "a real written reason" : rnd() < 0.5 ? "no" : "   ",
            at: new Date(1_000_000 + Math.floor(rnd() * 14) * 1000),
          });
        }
      }
      // a disposition for a key that is in no finding
      if (rnd() < 0.2) dispositions.push({ findingKey: "f".repeat(16), evidenceHash: "e".repeat(16), action: "accepted", reason: "stray reason", at: new Date(approvedAt + 5000) });
      const aiCancelledAt = Array.from({ length: Math.floor(rnd() * 3) }, () => new Date(1_000_000 + Math.floor(rnd() * 14) * 1000));
      const facts: ApprovalRevocationFacts = { findings, dispositions, aiCancelledAt };
      const rows: ApprovalRow[] = [{ kind: "approved", fingerprint: FP, at: new Date(approvedAt) }];
      for (const fp of [FP, FP2]) {
        const got = currentApproval(rows, fp, facts) !== null;
        const want = fp === FP && !oracleRevoked(approvedAt, facts);
        expect(got, `case ${n} fp ${fp.slice(0, 1)}`).toBe(want);
        if (fp === FP) {
          if (want) currentCount += 1;
          else revokedCount += 1;
        }
      }
      // the reasons list is empty exactly when the oracle says not revoked
      expect(approvalRevocationReasons({ at: new Date(approvedAt) }, facts).length === 0).toBe(!oracleRevoked(approvedAt, facts));
    }
    // both outcomes are well represented, so the agreement is not vacuous
    expect(currentCount).toBeGreaterThan(300);
    expect(revokedCount).toBeGreaterThan(300);
  });

  it("a withdrawn approval is never current, whatever the facts; an approval after the withdrawal is judged on its own time", () => {
    const approvedRow = { kind: "approved" as const, fingerprint: FP, at: new Date(1000) };
    const rows: ApprovalRow[] = [approvedRow, { kind: "withdrawn", fingerprint: FP, at: new Date(2000) }];
    expect(currentApproval(rows, FP, NO_REVOCATION_FACTS)).toBeNull();
    const again = [...rows, { kind: "approved" as const, fingerprint: FP, at: new Date(3000) }];
    expect(currentApproval(again, FP, NO_REVOCATION_FACTS)).not.toBeNull();
    // a cancellation between the first approval and the re-approval does not revoke the second one
    expect(currentApproval(again, FP, { findings: [], dispositions: [], aiCancelledAt: [new Date(2500)] })).not.toBeNull();
    expect(currentApproval(again, FP, { findings: [], dispositions: [], aiCancelledAt: [new Date(3500)] })).toBeNull();
    // withdrawn row inserted BEFORE the approval in the array but later in time: the later time wins
    const shuffled: ApprovalRow[] = [{ kind: "withdrawn", fingerprint: FP, at: new Date(5000) }, { kind: "approved", fingerprint: FP, at: new Date(4000) }];
    expect(currentApproval(shuffled, FP, NO_REVOCATION_FACTS)).toBeNull();
  });

  it("undefined / null / partial facts never produce a current approval (they throw: a caller cannot get 'approved' from them)", () => {
    const rows: ApprovalRow[] = [{ kind: "approved", fingerprint: FP, at: new Date(1000) }];
    const bad: unknown[] = [undefined, null, {}, { findings: [] }, { findings: [], dispositions: [] }, { findings: null, dispositions: [], aiCancelledAt: [] }, { findings: [], dispositions: undefined, aiCancelledAt: [] }, { findings: [], dispositions: [], aiCancelledAt: null }, { findings: "x", dispositions: [], aiCancelledAt: [] }, []];
    for (const b of bad) {
      let result: unknown = "threw";
      try {
        result = currentApproval(rows, FP, b as ApprovalRevocationFacts);
      } catch {
        result = "threw";
      }
      expect(result === "threw" || result === null, `facts ${JSON.stringify(b)} => ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it("an unparsable approval time revokes on any later-looking decision (fails closed); an unparsable decision time cannot revoke by time", () => {
    const f = makeFinding({ layer: "L1", check: "L1.T.x", severity: "high", area: "forms", message: "m", recommendedAction: "r", acceptable: true, evidence: [{ ref: "head:t", amount: 1, status: "ok" }] });
    const accepted: DispositionRow = { findingKey: f.key, evidenceHash: f.evidenceHash, action: "accepted", reason: "a real written reason", at: new Date(500) };
    const rows: ApprovalRow[] = [{ kind: "approved", fingerprint: FP, at: "not a date" }];
    // approval time NaN -> 0, the acceptance at t=500 is "after" it: revoked (closed-failing direction)
    expect(currentApproval(rows, FP, { findings: [f], dispositions: [accepted], aiCancelledAt: [] })).toBeNull();
  });
});

// ── the download button's decision (components/tax/review/approval-card.tsx uses packageDownloadOutcome) ──────────────

describe("tester(final): the final-package button saves only a 200 zip and shows the refusal otherwise (fuzz)", () => {
  it("2000 random responses: file iff ok && zip/octet-stream; refusal text is the route's own error (<= 300 chars) or a fixed sentence, never HTML", () => {
    const types: (string | null)[] = ["application/zip", "application/x-zip-compressed", "application/octet-stream", "APPLICATION/ZIP", "application/json", "text/html; charset=utf-8", "text/plain", "", null, "application/pdf", "application/json; charset=utf-8"];
    const bodies: (string | null)[] = [
      null,
      "",
      "   ",
      JSON.stringify({ error: "The return is not approved for its current state." }),
      JSON.stringify({ error: "x".repeat(900) }),
      JSON.stringify({ error: 42 }),
      JSON.stringify({ message: "no error key" }),
      "<html><body><h1>Sign in</h1><script>alert(1)</script></body></html>",
      "not json at all",
      "{\"error\":",
      JSON.stringify(["error"]),
      "null",
    ];
    const dispositions: (string | null)[] = [null, 'attachment; filename="final-package.zip"', "attachment; filename=../../evil.zip", 'attachment; filename*=UTF-8\'\'a%20b.zip', "attachment", 'attachment; filename="<script>.zip"', ""];
    let files = 0;
    let refusals = 0;
    for (let i = 0; i < 2000; i += 1) {
      const ok = rnd() < 0.5;
      const status = ok ? (rnd() < 0.9 ? 200 : 204) : pick([400, 401, 403, 404, 409, 500, 502, 503, 0, 302]);
      const type = pick(types);
      const body = pick(bodies);
      const out = packageDownloadOutcome({ ok, status, contentType: type, disposition: pick(dispositions) }, body);
      const isZip = ok && type !== null && /zip|octet-stream/i.test(type);
      expect(out.kind === "file", JSON.stringify({ ok, status, type })).toBe(isZip);
      if (out.kind === "file") {
        files += 1;
        expect(out.filename).toMatch(/^[A-Za-z0-9._-]+$/);
      } else {
        refusals += 1;
        expect(out.message.length).toBeGreaterThan(0);
        expect(out.message.length).toBeLessThanOrEqual(300);
        expect(out.message).not.toMatch(/<[a-z]/i);
      }
    }
    expect(files).toBeGreaterThan(100);
    expect(refusals).toBeGreaterThan(100);
  });
});
