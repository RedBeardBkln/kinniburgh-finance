import { vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { insertApproval, insertReviewRun, ReviewStoreError, type ReviewStoreDb } from "@/lib/tax-review-store";
import { evaluateGate, findingStatus, isGatingFinding, DEFAULT_DECISION_CHECK, type DispositionRow, type GateInput } from "@/lib/tax-review/gate";
import { inputGuard } from "@/lib/tax-review/l1/input-guard";
import { engineGateState } from "@/lib/tax-review/l1/engine-state";
import { isSafeOutgoing } from "@/lib/tax-review/redact";
import { makeFinding, type Finding } from "@/lib/tax-review/types";
import { buildPipeline, cleanScenario } from "./tax-review-harness";
import { footingCheck } from "@/lib/tax-review/l1/footing";
import { sourceTieoutCheck } from "@/lib/tax-review/l1/source-tieout";

const FP = "a".repeat(64);

function finding(over: Partial<Parameters<typeof makeFinding>[0]> = {}): Finding {
  return makeFinding({ layer: "L1", check: "L1.X.a", severity: "info", area: "process", message: "m", recommendedAction: "r", acceptable: true, ...over });
}

function green(): GateInput {
  return {
    runFingerprint: FP,
    currentFingerprint: FP,
    engine: { complete: true, blockingItemCount: 0, lineOverrideCount: 0, staleOverrideCount: 0 },
    findings: [],
    dispositions: [],
    l1: { status: "completed" },
    l2: { status: "completed", coverageListed: true },
    l3: { status: "completed", adversarialCompleted: true },
  };
}

describe("a decision still at its default gates approval (owner decision)", () => {
  const decision = (id: string): Finding => finding({ check: `${DEFAULT_DECISION_CHECK}`, ruleTag: id, severity: "medium", area: "process" });
  it("X1, X3 and X5 each keep the gate red until accepted with a written reason", () => {
    for (const id of ["X1", "X3", "X5", "X9"]) {
      const f = decision(id);
      expect(isGatingFinding(f)).toBe(true);
      expect(evaluateGate({ ...green(), findings: [f] }).verdict).toBe("flagged");
      const ok: DispositionRow[] = [{ findingKey: f.key, evidenceHash: f.evidenceHash, action: "accepted", reason: "The default is right for us.", at: "2026-10-05T10:00:00Z" }];
      expect(findingStatus(f, ok)).toBe("accepted");
      expect(evaluateGate({ ...green(), findings: [f], dispositions: ok }).verdict).toBe("passed");
      const weak: DispositionRow[] = [{ ...ok[0]!, reason: "ok" }];
      expect(evaluateGate({ ...green(), findings: [f], dispositions: weak }).verdict).toBe("flagged");
    }
  });
  it("every undecided decision must be confirmed separately", () => {
    const [a, b] = [decision("X1"), decision("X5")];
    const ack: DispositionRow[] = [{ findingKey: a.key, evidenceHash: a.evidenceHash, action: "accepted", reason: "Confirmed X1.", at: "2026-10-05T10:00:00Z" }];
    expect(evaluateGate({ ...green(), findings: [a, b], dispositions: ack }).verdict).toBe("flagged");
  });
  it("other medium findings still do not gate (no rule weakened or tightened)", () => {
    expect(isGatingFinding(finding({ check: "L1.D2.conflict", severity: "medium" }))).toBe(false);
    expect(evaluateGate({ ...green(), findings: [finding({ check: "L1.D2.derived-inputs", severity: "medium" })] }).verdict).toBe("passed");
  });
  it("a default-decision finding can be acted on only through an acceptance, never by an LLM finding of the same name", () => {
    const llm = makeFinding({ layer: "L3", check: DEFAULT_DECISION_CHECK, severity: "info", area: "process", message: "m", recommendedAction: "r", acceptable: true, origin: "llm", pass: "risk" });
    expect(evaluateGate({ ...green(), findings: [llm] }).verdict).toBe("flagged"); // fail closed: it still needs an acceptance
  });
});

describe("D1 redaction hardening", () => {
  const refused = ["1234​567890", "123456789abc", "1234567890ab", "abc123456789", "١٢٣٤٥٦٧٨٩", "123,45,6789", "123/45/6789", "123_45_6789", "123 456 789", "123-456-789", "12345­6789", "1‍2‍3456789"];
  it.each(refused)("refuses %j", (s) => expect(isSafeOutgoing(s)).toBe(false));
  it("still accepts digests of exact digest length and ordinary amounts", () => {
    for (const s of ["4dd661066a07", "4dd661066a07beef", "a".repeat(32), "b".repeat(40), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "$1,234,567,890", "2026-10-05", "line 11a 177,967 and 38,522"]) expect(isSafeOutgoing(s), s).toBe(true);
  });
  it("a hex-looking token that is not a whole digest-length token is scanned", () => {
    expect(isSafeOutgoing("abcdef1234567890abcdef12345")).toBe(false);
  });
});

describe("D2 store refuses what it promises to refuse", () => {
  function capture() {
    const created: unknown[] = [];
    const tx = {
      taxReviewRun: { create: vi.fn(async ({ data }: { data: unknown }) => ({ ...(data as object), id: "r1", startedAt: new Date() })) },
      taxReviewFinding: { createMany: vi.fn(async ({ data }: { data: unknown[] }) => { created.push(...data); return { count: data.length }; }) },
    };
    const store = { ...tx, taxReturnApproval: { create: vi.fn(async () => ({ id: "a1" })) }, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as ReviewStoreDb;
    return { store, created, tx };
  }
  const base = { taxYear: 2025, entityId: "e", fingerprint: FP, engineVersion: "x", startedById: null, startedByName: "Owner", config: {}, l1Summary: {}, l2Summary: {} };
  it("SSN-like text in a finding built by hand never reaches the table", async () => {
    const { store, created } = capture();
    await expect(insertReviewRun({ ...base, findings: [{ ...finding(), message: "SSN 123-45-6789 on file" }] }, store)).rejects.toThrow(ReviewStoreError);
    await expect(insertReviewRun({ ...base, findings: [{ ...finding(), evidence: [{ ref: "doc:1", amount: null, status: "x", note: "acct 1234567890" }] }] }, store)).rejects.toThrow();
    expect(created.length).toBe(0);
  });
  it("SSN-like text in the run config / summaries is refused", async () => {
    const { store } = capture();
    for (const k of ["config", "l1Summary", "l2Summary"] as const) {
      await expect(insertReviewRun({ ...base, [k]: { note: "123-45-6789" }, findings: [] }, store)).rejects.toThrow(/looks like/);
    }
  });
  it("a forged key or evidence hash is refused (recomputed, never trusted)", async () => {
    const { store } = capture();
    await expect(insertReviewRun({ ...base, findings: [{ ...finding(), key: "0123456789abcdef" }] }, store)).rejects.toThrow(/key/);
    await expect(insertReviewRun({ ...base, findings: [{ ...finding(), evidenceHash: "0123456789abcdef" }] }, store)).rejects.toThrow(/evidence hash/);
    const ok = await insertReviewRun({ ...base, findings: [finding({ ruleTag: "doc-1" })] }, store);
    expect(ok.findingCount).toBe(1);
  });
  it("an approval is recorded only for a passed gate", async () => {
    const { store } = capture();
    const row = { taxYear: 2025, entityId: "e", kind: "approved" as const, runId: "r", fingerprint: FP, attestationVersion: "v1", attestationTextHash: "h", typedConfirmationHash: "h", reason: null, approvedById: null, approvedByName: "Owner" };
    for (const snap of [{ verdict: "flagged" }, {}, null, "passed"]) await expect(insertApproval({ ...row, verdictSnapshot: snap }, store)).rejects.toThrow(/passed/);
    await expect(insertApproval({ ...row, verdictSnapshot: { verdict: "passed" } }, store)).resolves.toEqual({ id: "a1" });
  });
});

describe("D3 missing input fails closed", () => {
  it("the input guard turns each missing input into a non-acceptable blocker", async () => {
    const { ctx } = await buildPipeline(cleanScenario());
    expect(inputGuard(ctx)).toEqual([]);
    const gaps: [string, Partial<typeof ctx>][] = [
      ["effective", { effective: null }],
      ["cover", { cover: null }],
      ["raw", { raw: null }],
      ["labels", { lineLabels: {} }],
      ["maps", { maps: [] }],
      ["csv", { csvText: " " }],
      ["catalogs", { catalogs: {} }],
      ["files", { packet: { ...ctx.packet, files: [] } }],
    ];
    for (const [name, patch] of gaps) {
      const f = inputGuard({ ...ctx, ...patch });
      expect(f.length, name).toBe(1);
      expect(f[0]?.check).toBe("L1.runner.input-missing");
      expect(f[0]?.severity).toBe("blocker");
      expect(f[0]?.acceptable).toBe(false);
    }
  });
  it("without the override layer the gate's engine state is not complete", async () => {
    const { ctx } = await buildPipeline(cleanScenario());
    expect(engineGateState(ctx).complete).toBe(true);
    expect(engineGateState({ ...ctx, effective: null }).complete).toBe(false);
  });
  it("a printed table with no rows under a non-zero line is a blocker, and missing documents are a non-acceptable blocker", async () => {
    const { ctx } = await buildPipeline(cleanScenario());
    const view = structuredClone(ctx.view);
    view.tables = {};
    const line = view.lines["schc.48"];
    if (!line) throw new Error("no schc.48");
    line.amount = 500;
    line.status = "computed";
    const f = await footingCheck.run({ ...ctx, view });
    expect(Array.isArray(f) && f.some((x) => x.check === "L1.F1.schc.48.rows" && x.acceptable === false)).toBe(true);
    const d = await sourceTieoutCheck.run({ ...ctx, raw: null });
    expect(Array.isArray(d) && d[0]?.acceptable).toBe(false);
    expect(Array.isArray(d) && d[0]?.severity).toBe("blocker");
  });
});

describe("D4 loader order is deterministic", () => {
  const src = readFileSync(path.join(process.cwd(), "lib", "tax2025-build.ts"), "utf8");
  it("every findMany that feeds the return has an orderBy", () => {
    for (const model of ["document", "paystub", "user", "donation", "taxQuestion", "mileageEntry", "fixedAsset"]) {
      const at = src.indexOf(`db.${model}.findMany(`);
      expect(at, model).toBeGreaterThan(-1);
      const call = src.slice(at, src.indexOf("\n", at + 400) === -1 ? at + 600 : at + 600);
      expect(call, model).toMatch(/orderBy/);
    }
    expect(src).toMatch(/db\.document\.findMany\(\{[^)]*orderBy: \[\{ createdAt: "asc" \}, \{ id: "asc" \}\]/);
  });
});
