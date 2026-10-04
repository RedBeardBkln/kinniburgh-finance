import { describe, it, expect, vi, beforeEach } from "vitest";

// Provenance (`src`) in the stored answers JSON: it must survive parse / effective / summary, and an
// unrelated save must never erase another node's `src` (the round-trip hazard the plan names first).

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
import {
  buildSummary,
  describeAnswerSource,
  effectiveAnswers,
  parseAnswerSource,
  parseStoredAnswers,
  type AnswerSource,
  type QuestionnaireContext,
} from "@/lib/tax-questionnaire";
import { questionnaireById } from "@/lib/tax-questionnaire-content";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const ENTITIES = [{ id: PERSONAL, name: "Personal", slug: "personal", type: "personal", foundedDate: null, taxStatusNotes: null }];

const RC = "return-completeness";
const rc = questionnaireById(RC)!;
const CTX: QuestionnaireContext = { year: 2025, entityName: null, ekcActive: true, svActive: false };

const SRC: AnswerSource = { kind: "document", field: "w2.box12.deferrals", docIds: ["doc-1", "doc-2"], basis: "doc_verified", docValue: 1_850_000 };
const AT = "2026-10-04T12:00:00.000Z";

describe("parseStoredAnswers keeps a valid src", () => {
  it("round-trips src through parse and leaves entries without one untouched", () => {
    const parsed = parseStoredAnswers({
      def_eric: { v: "some", at: AT, by: "u1", src: SRC },
      plan_eva: { v: "yes", at: AT, by: "u1" },
    });
    expect(parsed.def_eric).toEqual({ v: "some", at: AT, by: "u1", src: SRC });
    expect(parsed.plan_eva).toEqual({ v: "yes", at: AT, by: "u1" });
    expect(parsed.plan_eva).not.toHaveProperty("src");
    // JSON round trip (what the database does)
    expect(parseStoredAnswers(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("drops only a malformed src and keeps v / at / by", () => {
    const bad: unknown[] = [
      "text",
      [],
      { ...SRC, kind: "other" },
      { ...SRC, field: "Has Spaces" },
      { ...SRC, field: "x".repeat(61) },
      { ...SRC, docIds: "doc-1" },
      { ...SRC, docIds: Array.from({ length: 13 }, (_, i) => `d${i}`) },
      { ...SRC, docIds: [1] },
      { ...SRC, basis: "guess" },
      { ...SRC, docValue: { a: 1 } },
      { ...SRC, docValue: Number.NaN },
    ];
    for (const src of bad) {
      const parsed = parseStoredAnswers({ def_eric: { v: "some", at: AT, by: "u1", src } });
      expect(parsed.def_eric, JSON.stringify(src)).toEqual({ v: "some", at: AT, by: "u1" });
    }
    expect(parseAnswerSource(undefined)).toBeUndefined();
    expect(parseAnswerSource({ ...SRC, kind: "planning", docIds: [], basis: "planning", docValue: "claimed_already" })).toBeDefined();
  });

  it("an answer saved before src existed is read exactly as before", () => {
    const parsed = parseStoredAnswers({ def_eric: { v: "some", at: AT, by: null } });
    expect(parsed).toEqual({ def_eric: { v: "some", at: AT, by: null } });
  });
});

describe("effectiveAnswers and buildSummary carry src", () => {
  it("carries src for an unbound node and nothing for one without", () => {
    const stored = parseStoredAnswers({
      def_eric: { v: "some", at: AT, by: "u1", src: SRC },
      defamt_eric: { v: 1_850_000, at: AT, by: "u1", src: SRC },
      plan_eva: { v: "yes", at: AT, by: "u1" },
    });
    const eff = effectiveAnswers(rc, stored, [], CTX);
    expect(eff.def_eric!.src).toEqual(SRC);
    expect(eff.defamt_eric!.src).toEqual(SRC);
    expect(eff.plan_eva).not.toHaveProperty("src");
  });

  it("does not attach a stored src to a bound node whose value comes from the Planning screen", () => {
    const form2210 = questionnaireById("form-2210")!;
    const bound = form2210.nodes.find((n) => n.id === "ut3")!;
    const planning = [{ key: bound.binding!.questionKey, answer: "12000", skippedReason: null, answeredAt: new Date(AT) }];
    const eff = effectiveAnswers(form2210, { ut3: { v: null, at: AT, by: "u1", src: SRC } }, planning, CTX);
    expect(eff[bound.id]).toBeDefined();
    expect(eff[bound.id]).not.toHaveProperty("src");
  });

  it("buildSummary adds a plain, name-free source note only to a fact that has a src", () => {
    const stored = parseStoredAnswers({
      def_eric: { v: "some", at: AT, by: "u1", src: SRC },
      plan_eva: { v: "yes", at: AT, by: "u1" },
    });
    const summary = buildSummary(rc, CTX, effectiveAnswers(rc, stored, [], CTX), null);
    const def = summary.facts.find((f) => f.nodeId === "def_eric")!;
    const plan = summary.facts.find((f) => f.nodeId === "plan_eva")!;
    expect(def.sourceNote).toBe("Filled from a W-2 (box 12 deferral codes), verified when accepted");
    expect(plan).not.toHaveProperty("sourceNote");
    expect(describeAnswerSource({ ...SRC, basis: "doc_unverified" })).toContain("unverified AI read");
    expect(describeAnswerSource({ ...SRC, field: "something.new" })).toBe("Filled from a document, verified when accepted");
  });
});

describe("saveQuestionnaireAnswer and src", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.$transaction.mockImplementation(async (cb: (tx: typeof mockDb) => Promise<unknown>) => cb(mockDb));
    authMock.mockResolvedValue({ user: { id: USER } });
    mockDb.entity.findMany.mockResolvedValue(ENTITIES);
    mockDb.taxWorkspace.findUnique.mockResolvedValue(null);
    mockDb.taxQuestionnaire.upsert.mockResolvedValue({});
    mockDb.auditLog.create.mockResolvedValue({});
  });

  const row = (answers: unknown) => ({ taxYear: 2025, entityId: PERSONAL, questionnaireId: RC, definitionVersion: rc.version, answers, note: null });
  const written = (): Record<string, Record<string, unknown>> => {
    const call = mockDb.taxQuestionnaire.upsert.mock.calls[0]![0] as { update: { answers: Record<string, Record<string, unknown>> } };
    return call.update.answers;
  };

  it("saving an unrelated answer keeps every other node's src", async () => {
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue(
      row({
        def_eric: { v: "some", at: AT, by: "u1", src: SRC },
        defamt_eric: { v: 1_850_000, at: AT, by: "u1", src: SRC },
      })
    );
    const res = await saveQuestionnaireAnswer({ taxYear: 2025, questionnaireId: RC, entityId: PERSONAL, nodeId: "plan_eva", value: "yes" });
    expect(res).toEqual({ ok: true });
    const a = written();
    expect(a.def_eric).toEqual({ v: "some", at: AT, by: "u1", src: SRC });
    expect(a.defamt_eric).toEqual({ v: 1_850_000, at: AT, by: "u1", src: SRC });
    expect(a.plan_eva).toMatchObject({ v: "yes", by: USER });
    expect(a.plan_eva).not.toHaveProperty("src");
  });

  it("a manual save on a node that had a src writes a fresh entry with no src (an owner statement)", async () => {
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue(
      row({
        def_eric: { v: "some", at: AT, by: "u1", src: SRC },
        defamt_eric: { v: 1_850_000, at: AT, by: "u1", src: SRC },
      })
    );
    const res = await saveQuestionnaireAnswer({ taxYear: 2025, questionnaireId: RC, entityId: PERSONAL, nodeId: "defamt_eric", value: 1_000_000 });
    expect(res).toEqual({ ok: true });
    const a = written();
    expect(a.defamt_eric).toMatchObject({ v: 1_000_000, by: USER });
    expect(a.defamt_eric).not.toHaveProperty("src");
    expect(a.def_eric).toHaveProperty("src");
  });

  it("the audit rows of a normal save never mention src", async () => {
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue(row({ def_eric: { v: "some", at: AT, by: "u1", src: SRC } }));
    await saveQuestionnaireAnswer({ taxYear: 2025, questionnaireId: RC, entityId: PERSONAL, nodeId: "plan_eva", value: "no" });
    expect(JSON.stringify(mockDb.auditLog.create.mock.calls)).not.toContain("docIds");
  });
});
