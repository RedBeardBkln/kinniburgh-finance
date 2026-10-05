import { vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The loader's DB edges are injected; the modules it imports for production wiring are mocked so importing them opens no connection.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: vi.fn(async () => null) }));

import { loadReviewInputs, runReviewForYear, currentReturnFingerprint, type ReviewBuildDeps } from "@/lib/tax-review-build";
import type { OverrideRow } from "@/lib/tax2025/overrides";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { evaluateGate } from "@/lib/tax-review/gate";
import { blankFormIds, cleanScenario, loadCatalogs, loadLineLabels } from "./tax-review-harness";

const ENTITY = "22222222-2222-4222-8222-222222222222";

function deps(over: Partial<ReviewBuildDeps> & { rows?: OverrideRow[]; questionnaire?: unknown } = {}): ReviewBuildDeps {
  const s = cleanScenario();
  return {
    loadRaw: async () => s.raw,
    overrides: { resolveEntityId: async () => ENTITY, loadRows: async () => over.rows ?? [] },
    loadQuestionnaires: async () => [{ questionnaireId: "return_completeness", definitionVersion: 3, answers: over.questionnaire ?? { q1: "none" } }],
    ekcName: async () => "Sample Consulting, LLC",
    now: () => new Date("2026-10-05T16:00:00Z"),
    formData: () => ({ catalogs: loadCatalogs(), lineLabels: loadLineLabels(), blankFormIds: blankFormIds() }),
    ...over,
  };
}

describe("loadReviewInputs", () => {
  it("returns the return, the raw inputs of the SAME read, and fingerprint v2", async () => {
    const r = await loadReviewInputs(2025, "Tester", deps());
    if ("error" in r) throw new Error(r.error);
    expect(r.entityId).toBe(ENTITY);
    expect(r.raw.documents.length).toBe(6);
    expect(r.fingerprint.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(r.engineVersion).toBe(r.built.ret.engineVersion);
  });
  it("the fingerprint ignores when it was built and who asked, and changes with each input group", async () => {
    const base = await currentReturnFingerprint(2025, "Tester", deps());
    if ("error" in base) throw new Error(base.error);
    const later = await currentReturnFingerprint(2025, "Someone Else", deps({ now: () => new Date("2026-10-09T09:00:00Z") }));
    if ("error" in later) throw new Error(later.error);
    expect(later.fingerprint.fingerprint).toBe(base.fingerprint.fingerprint);
    const answer = await currentReturnFingerprint(2025, "Tester", deps({ questionnaire: { q1: "some" } }));
    if ("error" in answer) throw new Error(answer.error);
    expect(answer.fingerprint.fingerprint).not.toBe(base.fingerprint.fingerprint);
    expect(answer.fingerprint.parts.questionnaires).not.toBe(base.fingerprint.parts.questionnaires);
    const row: OverrideRow = {
      id: "00000000-0000-4000-8000-0000000000dd",
      taxYear: 2025,
      targetKind: "decision",
      targetKey: "homeOfficeMethod",
      version: 1,
      valueKind: "choice",
      valueCents: null,
      valueText: "actual",
      computedSnapshot: { status: "default_undecided", cents: null },
      authority: "owner",
      reason: "test",
      setByName: "Test User",
      setAt: new Date("2026-10-01T12:00:00Z"),
      archivedAt: null,
    };
    const withRow = await currentReturnFingerprint(2025, "Tester", deps({ rows: [row] }));
    if ("error" in withRow) throw new Error(withRow.error);
    expect(withRow.fingerprint.fingerprint).not.toBe(base.fingerprint.fingerprint);
    expect(withRow.fingerprint.parts.overrides).not.toBe(base.fingerprint.parts.overrides);
  });
  it("fails closed when the questionnaire answers cannot be read, and when the entity is missing", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const noQ = await loadReviewInputs(2025, "Tester", deps({ loadQuestionnaires: async () => { throw new Error("db down with secret 123456789"); } }));
    expect("error" in noQ && noQ.error).toMatch(/questionnaire answers could not be read/);
    expect(JSON.stringify(noQ)).not.toMatch(/123456789/);
    quiet.mockRestore();
    const noEntity = await loadReviewInputs(2025, "Tester", deps({ overrides: { resolveEntityId: async () => null, loadRows: async () => [] } }));
    expect("error" in noEntity).toBe(true);
  });
  it("passes a loader error through (the review never falls back to a partial return)", async () => {
    const r = await loadReviewInputs(2025, "Tester", deps({ loadRaw: async () => ({ error: "Personal entity not found" }) }));
    expect(r).toEqual({ error: "Personal entity not found" });
  });
});

describe("runReviewForYear", () => {
  it("runs L1 over the draft packet and returns the L2 recalculation as not run for an incomplete return, with counts-only summaries and the gate's engine state", async () => {
    const r = await runReviewForYear(2025, "Tester", "draft", deps());
    if ("error" in r) throw new Error(r.error);
    expect(r.l1.status).toBe("completed");
    expect(r.l2).toMatchObject({ status: "not_run", findings: [], coverage: [] });
    expect(r.l2.reason).toMatch(/not complete/);
    expect(r.l2Summary).toMatchObject({ status: "not_run", mismatchCount: 0 });
    expect(r.engine).toEqual({ complete: false, blockingItemCount: expect.any(Number), lineOverrideCount: 0, staleOverrideCount: 0 });
    expect(r.config).toMatchObject({ fingerprintVersion: 2, l1Version: 1, mode: "draft" });
    expect(JSON.stringify(r.l1Summary)).not.toMatch(/Sample|Alpine/);
    expect(r.fingerprint.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // the raw inputs here carry no questionnaire answers, so the engine reports blocking items: the review says so
    expect(r.l1.findings.some((f) => f.check === "L1.D1.incomplete")).toBe(true);
  });
  it("with L2 not run the gate is red for this fingerprint (no waiver exists)", async () => {
    const r = await runReviewForYear(2025, "Tester", "draft", deps());
    if ("error" in r) throw new Error(r.error);
    const gate = evaluateGate({
      runFingerprint: r.fingerprint.fingerprint,
      currentFingerprint: r.fingerprint.fingerprint,
      engine: r.engine,
      findings: r.l1.findings,
      dispositions: [],
      l1: { status: r.l1.status },
      l2: { status: r.l2.status === "ran" ? "completed" : "not_run", coverageListed: false },
      l3: { status: "not_run", adversarialCompleted: false },
    });
    expect(gate.verdict).toBe("flagged");
    expect(gate.items.find((i) => i.id === "l2")?.state).toBe("not_run");
    expect(gate.items.find((i) => i.id === "l3")?.state).toBe("not_run");
  });
  it("uses the real maps (the same ones the download uses)", () => {
    expect(FORM_MAPS.length).toBeGreaterThan(10);
  });
});

describe("lib/tax-review-build.ts is read-only", () => {
  const src = readFileSync(path.join(process.cwd(), "lib", "tax-review-build.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("no create / update / upsert / delete, no auditLog, no server action", () => {
    for (const call of [".create(", ".createMany(", ".update(", ".updateMany(", ".upsert(", ".delete(", ".deleteMany(", "$transaction", "auditLog", '"use server"']) {
      expect(src.includes(call), call).toBe(false);
    }
  });
  it("reads the questionnaire answers with findMany only", () => {
    expect(src).toMatch(/db\.taxQuestionnaire\.findMany/);
  });
});
