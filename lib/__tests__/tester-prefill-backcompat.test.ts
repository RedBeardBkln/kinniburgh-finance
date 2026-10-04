// TESTER: backwards safety of the stored answer shape, and the "unrelated save erases another node's src"
// hazard, exercised through the REAL saveQuestionnaireAnswer action with a mocked db boundary.
// Old-shape answers = every answer saved in production before this change (no `src`).

import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/actions/tax-planning", () => ({ ensurePersonalWorkspace: vi.fn() }));
const mockDb = vi.hoisted(() => {
  const m = {
    entity: { findMany: vi.fn() },
    taxWorkspace: { findUnique: vi.fn() },
    taxQuestion: { updateMany: vi.fn() },
    taxQuestionnaire: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  m.$transaction.mockImplementation(async (cb: (tx: typeof m) => Promise<unknown>) => cb(m));
  return m;
});
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { saveQuestionnaireAnswer } from "@/actions/tax-questionnaires";
import { buildSummary, effectiveAnswers, parseAnswerSource, parseStoredAnswers } from "@/lib/tax-questionnaire";
import { RETURN_COMPLETENESS_ID, questionnaireById } from "@/lib/tax-questionnaire-content";
import { RC_CONTEXT } from "@/lib/tax2025/answers";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const AT = "2026-10-02T15:00:00.000Z";

const OLD = {
  age_eric: { v: "no", at: AT, by: "u-eric" },
  plan_eva: { v: "yes", at: AT, by: "u-eva" },
  def_eva: { v: "some", at: AT, by: "u-eva" },
  defamt_eva: { v: 139_398, at: AT, by: "u-eva" },
  pyjoint: { v: "yes", at: AT, by: null },
};

describe("old-shape answers (no src) parse, validate and display exactly as before", () => {
  it("parseStoredAnswers returns the legacy {v,at,by} objects with NO src key at all", () => {
    const out = parseStoredAnswers(OLD);
    expect(out).toStrictEqual(OLD);
    for (const e of Object.values(out)) expect("src" in e).toBe(false);
  });

  it("effectiveAnswers carries no src key; buildSummary facts carry no sourceNote key", () => {
    const def = questionnaireById(RETURN_COMPLETENESS_ID)!;
    const eff = effectiveAnswers(def, parseStoredAnswers(OLD), [], RC_CONTEXT);
    expect(eff.defamt_eva).toStrictEqual({ value: 139_398, source: "questionnaire", at: AT, by: "u-eva" });
    for (const a of Object.values(eff)) expect("src" in a).toBe(false);
    const summary = buildSummary(def, RC_CONTEXT, eff, null);
    expect(summary.facts.length).toBeGreaterThan(0);
    for (const f of summary.facts) expect("sourceNote" in f).toBe(false);
  });

  it("a mixed row (some entries with a valid src, some without) keeps each as saved", () => {
    const src = { kind: "document", field: "w2.box13.plan", docIds: ["d1"], basis: "doc_verified", docValue: "yes" };
    const out = parseStoredAnswers({ ...OLD, plan_eric: { v: "yes", at: AT, by: "u1", src } });
    expect(out.plan_eric).toStrictEqual({ v: "yes", at: AT, by: "u1", src });
    expect("src" in out.plan_eva!).toBe(false);
  });

  it("a malformed src drops ONLY the src (value, at, by kept)", () => {
    const good = { kind: "document", field: "w2.box13.plan", docIds: ["d1"], basis: "doc_verified", docValue: "yes" };
    const bad: unknown[] = [
      null,
      "str",
      [],
      42,
      {},
      { ...good, kind: "other" },
      { ...good, field: "Has Space" },
      { ...good, field: "UPPER" },
      { ...good, field: "a".repeat(61) },
      { ...good, field: "" },
      { ...good, docIds: "d1" },
      { ...good, docIds: [1] },
      { ...good, docIds: [""] },
      { ...good, docIds: Array.from({ length: 13 }, (_, i) => `d${i}`) },
      { ...good, docIds: ["x".repeat(65)] },
      { ...good, basis: "verified" },
      { ...good, docValue: { a: 1 } },
      { ...good, docValue: Number.NaN },
      { ...good, docValue: "x".repeat(81) },
      { ...good, docValue: null },
      { ...good, docValue: undefined },
    ];
    for (const s of bad) {
      const out = parseStoredAnswers({ plan_eric: { v: "yes", at: AT, by: "u1", src: s } });
      expect(out.plan_eric, JSON.stringify(s)).toStrictEqual({ v: "yes", at: AT, by: "u1" });
      expect(parseAnswerSource(s)).toBeUndefined();
    }
    expect(parseAnswerSource(good)).toStrictEqual(good);
  });

  it("an extra unknown key inside src is dropped, not preserved (no unvalidated data round-trips)", () => {
    const out = parseStoredAnswers({ plan_eric: { v: "yes", at: AT, by: "u1", src: { kind: "document", field: "w2.box13.plan", docIds: [], basis: "doc_verified", docValue: "yes", evil: "<script>" } } });
    expect(JSON.stringify(out)).not.toContain("evil");
  });
});

// ── Hazard #1 through the real action ────────────────────────────────────────

const SRC_PLAN = { kind: "document", field: "w2.box13.plan", docIds: ["d1", "d2"], basis: "doc_verified", docValue: "yes" };
const SRC_DEF = { kind: "document", field: "w2.box12.deferrals", docIds: ["d1", "d2"], basis: "doc_verified", docValue: 54_089 };
const STORED_WITH_SRC = {
  plan_eva: { v: "yes", at: AT, by: "u-eva", src: SRC_PLAN },
  def_eva: { v: "some", at: AT, by: "u-eva", src: SRC_DEF },
  defamt_eva: { v: 54_089, at: AT, by: "u-eva", src: SRC_DEF },
};

function written(): Record<string, Record<string, unknown>> {
  return (mockDb.taxQuestionnaire.upsert.mock.calls[0]![0] as { update: { answers: Record<string, Record<string, unknown>> } }).update.answers;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$transaction.mockImplementation(async (cb: (tx: typeof mockDb) => Promise<unknown>) => cb(mockDb));
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.entity.findMany.mockResolvedValue([
    { id: PERSONAL, name: "Personal", slug: "personal", type: "personal", foundedDate: null, taxStatusNotes: null },
  ]);
  mockDb.taxWorkspace.findUnique.mockResolvedValue(null);
  mockDb.taxQuestionnaire.upsert.mockResolvedValue({});
  mockDb.auditLog.create.mockResolvedValue({});
  mockDb.taxQuestionnaire.findUnique.mockResolvedValue({ taxYear: 2025, entityId: PERSONAL, questionnaireId: RETURN_COMPLETENESS_ID, definitionVersion: 2, answers: STORED_WITH_SRC, note: null });
});

describe("hazard 1: saving never erases another node's src", () => {
  const base = { taxYear: 2025, questionnaireId: RETURN_COMPLETENESS_ID, entityId: PERSONAL };

  it("an unrelated save (age_eric) leaves plan_eva / def_eva / defamt_eva src byte-for-byte; the new entry has no src", async () => {
    const res = await saveQuestionnaireAnswer({ ...base, nodeId: "age_eric", value: "no" });
    expect(res.ok).toBe(true);
    const a = written();
    expect(a.plan_eva).toStrictEqual(STORED_WITH_SRC.plan_eva);
    expect(a.def_eva).toStrictEqual(STORED_WITH_SRC.def_eva);
    expect(a.defamt_eva).toStrictEqual(STORED_WITH_SRC.defamt_eva);
    expect("src" in a.age_eric!).toBe(false);
  });

  it("a manual save of a prefilled node writes a fresh entry with NO src (an owner statement); siblings keep theirs", async () => {
    const res = await saveQuestionnaireAnswer({ ...base, nodeId: "defamt_eva", value: 139_398 });
    expect(res.ok).toBe(true);
    const a = written();
    expect("src" in a.defamt_eva!).toBe(false);
    expect(a.defamt_eva!.v).toBe(139_398);
    expect(a.defamt_eva!.by).toBe(USER);
    expect(a.def_eva).toStrictEqual(STORED_WITH_SRC.def_eva); // sibling untouched (still says "from W-2")
    expect(a.plan_eva).toStrictEqual(STORED_WITH_SRC.plan_eva);
  });

  it("re-saving the SAME value by hand (\"Keep my answer\") also clears src", async () => {
    await saveQuestionnaireAnswer({ ...base, nodeId: "plan_eva", value: "yes" });
    expect("src" in written().plan_eva!).toBe(false);
  });

  it("the audit row of a normal save contains no src / document ids", async () => {
    await saveQuestionnaireAnswer({ ...base, nodeId: "age_eric", value: "no" });
    const audit = JSON.stringify(mockDb.auditLog.create.mock.calls);
    expect(audit).not.toContain("w2.box");
    expect(audit).not.toContain("d1");
  });
});
