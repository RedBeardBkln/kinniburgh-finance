import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// Tester probe for actions/tax-questionnaires.ts: matrix over EVERY node of EVERY
// definition, with the db / auth boundary mocked (repo convention: no DB tests).
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const ensureWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@/actions/tax-planning", () => ({ ensurePersonalWorkspace: ensureWorkspace }));

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

import { saveQuestionnaireAnswer, saveQuestionnaireNote, resetQuestionnaire } from "@/actions/tax-questionnaires";
import { QUESTIONNAIRES, questionnaireById } from "@/lib/tax-questionnaire-content";
import {
  enumerateAnswerPaths,
  nodeOptions,
  resolveBoundWrite,
  isNodeVisible,
  UNSURE_ID,
  type AnswerValue,
  type ChoiceNode,
  type EffectiveAnswers,
  type NumberNode,
  type QNode,
  type QuestionnaireContext,
  type QuestionnaireDef,
} from "@/lib/tax-questionnaire";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const EKC = "33333333-3333-4333-8333-333333333333";
const SV = "44444444-4444-4444-8444-444444444444";
const MEZZO = "55555555-5555-4555-8555-555555555555";
const WS = "66666666-6666-4666-8666-666666666666";

const ENTITIES = [
  { id: PERSONAL, name: "Personal", slug: "personal", type: "personal", foundedDate: null, taxStatusNotes: null },
  { id: EKC, name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting", type: "business", foundedDate: null, taxStatusNotes: null },
  { id: SV, name: "Sudden Valley Property Management, LLC", slug: "sudden-valley", type: "business", foundedDate: new Date("2025-03-01"), taxStatusNotes: null },
  { id: MEZZO, name: "Mezzo", slug: "mezzo", type: "business", foundedDate: null, taxStatusNotes: "Not yet formed/registered" },
];
const YEAR = 2025;
const FULL_CTX = (def: QuestionnaireDef): QuestionnaireContext => ({ year: YEAR, entityName: def.scope === "entity" ? "Eric Kinniburgh Consulting, LLC" : null, ekcActive: true, svActive: true });
const entityFor = (def: QuestionnaireDef) => (def.scope === "household" ? PERSONAL : EKC);

const isChoice = (n: QNode): n is ChoiceNode => n.kind === "single" || n.kind === "multi";

function validValue(node: QNode, ctx: QuestionnaireContext): AnswerValue {
  if (isChoice(node)) {
    const opts = nodeOptions(node, ctx);
    const plain = opts.find((o) => !o.unsure && !o.exclusive) ?? opts[0]!;
    return node.kind === "single" ? plain.id : [plain.id];
  }
  const n = node as NumberNode;
  return n.kind === "dollars" ? Math.max(n.min, 1) * 100 * 12 : Math.max(n.min, 1);
}

/** A stored-answers map + planning rows that make `target` visible (from a real enumerated path). */
function stateMakingVisible(def: QuestionnaireDef, targetId: string) {
  const ctx = FULL_CTX(def);
  const { paths } = enumerateAnswerPaths(def, ctx, 50000);
  const p: EffectiveAnswers | undefined = paths.find((x) => x[targetId] !== undefined);
  if (!p) throw new Error(`no path shows ${def.id}.${targetId}`);
  const stored: Record<string, { v: unknown; at: string; by: string | null }> = {};
  const planning: { key: string; answer: unknown; skippedReason: null; answeredAt: Date }[] = [];
  for (const node of def.nodes) {
    if (node.id === targetId) continue;
    const a = p[node.id];
    if (!a) continue;
    if (node.binding) {
      const w = resolveBoundWrite(node, a.value);
      if (w && w.planningValue !== null) planning.push({ key: w.questionKey, answer: w.planningValue, skippedReason: null, answeredAt: new Date("2026-10-01T00:00:00Z") });
      else stored[node.id] = { v: a.value, at: "2026-10-01T00:00:00.000Z", by: null };
    } else stored[node.id] = { v: a.value, at: "2026-10-01T00:00:00.000Z", by: null };
  }
  return { stored, planning };
}

function setupRow(stored: Record<string, unknown>, planning: unknown[], withWorkspace = true) {
  mockDb.taxQuestionnaire.findUnique.mockResolvedValue({ taxYear: YEAR, answers: stored, note: null, definitionVersion: 1 });
  mockDb.taxWorkspace.findUnique.mockResolvedValue(withWorkspace ? { id: WS, questions: planning } : null);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$transaction.mockImplementation(async (cb: (tx: typeof mockDb) => Promise<unknown>) => cb(mockDb));
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.entity.findMany.mockResolvedValue(ENTITIES);
  mockDb.taxQuestionnaire.findUnique.mockResolvedValue(null);
  mockDb.taxQuestionnaire.upsert.mockResolvedValue({});
  mockDb.taxQuestionnaire.update.mockResolvedValue({});
  mockDb.taxWorkspace.findUnique.mockResolvedValue(null);
  mockDb.taxQuestion.updateMany.mockResolvedValue({ count: 1 });
  mockDb.auditLog.create.mockResolvedValue({});
  ensureWorkspace.mockResolvedValue(WS);
});

const auditJson = () => JSON.stringify(mockDb.auditLog.create.mock.calls.map((c) => c[0]));
const writes = () =>
  mockDb.taxQuestionnaire.upsert.mock.calls.length +
  mockDb.taxQuestionnaire.update.mock.calls.length +
  mockDb.auditLog.create.mock.calls.length +
  mockDb.taxQuestion.updateMany.mock.calls.length +
  ensureWorkspace.mock.calls.length;

describe("saveQuestionnaireAnswer: matrix over every node of every definition", () => {
  for (const def of QUESTIONNAIRES) {
    it(`${def.id}: each visible node saves; audit holds ids/numbers only; workspace opened iff a planning value is written`, async () => {
      const ctx = FULL_CTX(def);
      for (const node of def.nodes) {
        vi.clearAllMocks();
        mockDb.$transaction.mockImplementation(async (cb: (tx: typeof mockDb) => Promise<unknown>) => cb(mockDb));
        authMock.mockResolvedValue({ user: { id: USER } });
        mockDb.entity.findMany.mockResolvedValue(ENTITIES);
        mockDb.taxQuestion.updateMany.mockResolvedValue({ count: 1 });
        ensureWorkspace.mockResolvedValue(WS);
        const { stored, planning } = stateMakingVisible(def, node.id);
        setupRow(stored, planning);
        const value = validValue(node, ctx);
        const res = await saveQuestionnaireAnswer({ taxYear: YEAR, questionnaireId: def.id, entityId: entityFor(def), nodeId: node.id, value });
        expect(res, `${def.id}.${node.id}`).toEqual({ ok: true });
        const bound = resolveBoundWrite(node, value as AnswerValue);
        const writesPlanning = !!bound && bound.planningValue !== null;
        expect(ensureWorkspace.mock.calls.length, `${def.id}.${node.id} ensureWorkspace`).toBe(writesPlanning ? 1 : 0);
        expect(mockDb.taxQuestion.updateMany.mock.calls.length > 0, `${def.id}.${node.id} planning write`).toBe(!!bound);
        const upsert = mockDb.taxQuestionnaire.upsert.mock.calls[0]![0];
        const entry = upsert.update.answers[node.id];
        expect(entry.by).toBe(USER);
        expect(entry.v).toEqual(writesPlanning ? null : value);
        // untouched earlier answers survive the merge
        for (const k of Object.keys(stored)) expect(upsert.update.answers[k]).toBeDefined();
        const audit = auditJson();
        for (const n of def.nodes) if (isChoice(n)) for (const o of n.options) if (o.label.length >= 14) expect(audit).not.toContain(o.label);
        expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
      }
    });
  }
});

describe("hidden / out-of-scope writes are refused with zero side effects", () => {
  it("a node that is not currently visible is rejected for every definition", async () => {
    for (const def of QUESTIONNAIRES) {
      for (const node of def.nodes) {
        if (!node.showWhen) continue;
        vi.clearAllMocks();
        mockDb.entity.findMany.mockResolvedValue(ENTITIES);
        mockDb.taxQuestionnaire.findUnique.mockResolvedValue(null); // nothing answered -> every gated node hidden
        mockDb.taxWorkspace.findUnique.mockResolvedValue(null);
        const res = await saveQuestionnaireAnswer({ taxYear: YEAR, questionnaireId: def.id, entityId: entityFor(def), nodeId: node.id, value: validValue(node, FULL_CTX(def)) });
        expect(res.ok, `${def.id}.${node.id}`).toBe(false);
        expect(writes(), `${def.id}.${node.id}`).toBe(0);
        // and the pure engine agrees
        expect(isNodeVisible(def, FULL_CTX(def), {}, node.id)).toBe(false);
      }
    }
  });

  it("scope matrix: wrong entity type, inactive entity, SV-only questionnaires without SV, bad year", async () => {
    const calls: { def: string; entity: string; year: number; node?: string }[] = [];
    for (const def of QUESTIONNAIRES) {
      const first = def.nodes[0]!;
      if (def.scope === "household") calls.push({ def: def.id, entity: EKC, year: YEAR });
      else calls.push({ def: def.id, entity: PERSONAL, year: YEAR });
      if (def.scope === "entity") calls.push({ def: def.id, entity: MEZZO, year: YEAR });
      calls.push({ def: def.id, entity: "99999999-9999-4999-8999-999999999999", year: YEAR });
      for (const year of [1999, 2101]) calls.push({ def: def.id, entity: entityFor(def), year });
      void first;
    }
    for (const c of calls) {
      vi.clearAllMocks();
      mockDb.entity.findMany.mockResolvedValue(ENTITIES);
      const def = questionnaireById(c.def)!;
      const node = def.nodes[0]!;
      const res = await saveQuestionnaireAnswer({ taxYear: c.year, questionnaireId: c.def, entityId: c.entity, nodeId: node.id, value: validValue(node, FULL_CTX(def)) });
      expect(res.ok, JSON.stringify(c)).toBe(false);
      expect(writes(), JSON.stringify(c)).toBe(0);
      expect((await saveQuestionnaireNote({ taxYear: c.year, questionnaireId: c.def, entityId: c.entity, note: "x" })).ok).toBe(false);
      expect((await resetQuestionnaire({ taxYear: c.year, questionnaireId: c.def, entityId: c.entity })).ok).toBe(false);
      expect(writes(), JSON.stringify(c)).toBe(0);
    }
    // SV-only questionnaires without an active Sudden Valley (founded 2026, year 2025)
    mockDb.entity.findMany.mockResolvedValue(ENTITIES.map((e) => (e.id === SV ? { ...e, foundedDate: new Date("2026-02-01") } : e)));
    for (const id of ["form-4562", "form-8582"]) {
      const def = questionnaireById(id)!;
      const node = def.nodes[0]!;
      const res = await saveQuestionnaireAnswer({ taxYear: YEAR, questionnaireId: id, entityId: PERSONAL, nodeId: node.id, value: validValue(node, FULL_CTX(def)) });
      expect(res.ok, id).toBe(false);
      expect((await saveQuestionnaireNote({ taxYear: YEAR, questionnaireId: id, entityId: PERSONAL, note: "x" })).ok, id).toBe(false);
    }
    expect(writes()).toBe(0);
  });

  it("zod: junk shapes never reach the db", async () => {
    const base = { taxYear: YEAR, questionnaireId: "form-8889", entityId: PERSONAL, nodeId: "hs1" };
    const bad: unknown[] = [
      { ...base, value: 5.5 }, { ...base, value: true }, { ...base, value: null }, { ...base, value: {} },
      { ...base, value: "x".repeat(81) }, { ...base, value: Array(13).fill("a") }, { ...base, value: "eric", confirmed: "yes" },
      { ...base, taxYear: 2025.5, value: "eric" }, { ...base, taxYear: "2025", value: "eric" }, { ...base, entityId: "not-a-uuid", value: "eric" },
      { ...base, nodeId: "", value: "eric" }, { ...base, questionnaireId: "", value: "eric" }, { ...base, questionnaireId: "x".repeat(61), value: "eric" },
    ];
    for (const b of bad) {
      vi.clearAllMocks();
      const res = await saveQuestionnaireAnswer(b as never);
      expect(res.ok, JSON.stringify(b)).toBe(false);
      expect(mockDb.entity.findMany).not.toHaveBeenCalled();
    }
    for (const proto of ["__proto__", "constructor", "toString"]) {
      vi.clearAllMocks();
      mockDb.entity.findMany.mockResolvedValue(ENTITIES);
      expect((await saveQuestionnaireAnswer({ ...base, questionnaireId: proto, value: "eric" })).ok).toBe(false);
      expect((await saveQuestionnaireAnswer({ ...base, nodeId: proto, value: "eric" })).ok).toBe(false);
      expect(writes()).toBe(0);
    }
  });
});

describe("local-only ('Not sure') over an existing planning answer needs confirmation (every bound node)", () => {
  for (const def of QUESTIONNAIRES) {
    for (const node of def.nodes) {
      if (!node.binding) continue;
      const localValues: AnswerValue[] = [];
      if (isChoice(node) && node.binding.mode === "shared_choice") {
        for (const [optId, bankVal] of Object.entries(node.binding.bank)) if (bankVal === null) localValues.push(optId);
      } else localValues.push(UNSURE_ID);
      for (const local of localValues) {
        it(`${def.id}.${node.id} -> ${String(local)}: refused without confirmed, clears planning answer with it, never opens a workspace`, async () => {
          const { stored, planning } = stateMakingVisible(def, node.id);
          // existing planning answer for the node itself
          const existing = isChoice(node) && node.binding!.mode === "shared_choice"
            ? { key: node.binding!.questionKey, answer: Object.values(node.binding!.bank).find((v) => v !== null)!, skippedReason: null, answeredAt: new Date("2026-10-01T00:00:00Z") }
            : { key: node.binding!.questionKey, answer: "180", skippedReason: null, answeredAt: new Date("2026-10-01T00:00:00Z") };
          // the dollar node's existing answer must parse as dollars
          if (node.kind === "dollars") existing.answer = "12000";
          setupRow(stored, [...planning.filter((p) => p.key !== existing.key), existing]);
          const args = { taxYear: YEAR, questionnaireId: def.id, entityId: entityFor(def), nodeId: node.id, value: local };
          const refused = await saveQuestionnaireAnswer(args);
          expect(refused).toMatchObject({ ok: false, code: "needs_confirm" });
          expect(writes()).toBe(0);
          const ok = await saveQuestionnaireAnswer({ ...args, confirmed: true });
          expect(ok).toEqual({ ok: true });
          expect(ensureWorkspace).not.toHaveBeenCalled();
          const upd = mockDb.taxQuestion.updateMany.mock.calls[0]![0];
          expect(upd.where).toEqual({ workspaceId: WS, key: node.binding!.questionKey });
          expect(upd.data.answer).toBe(Prisma.DbNull);
          expect(upd.data.answeredAt).toBeNull();
          const entry = mockDb.taxQuestionnaire.upsert.mock.calls[0]![0].update.answers[node.id];
          expect(entry.v).toEqual(local);
        });
      }
    }
  }

  it("local-only choice with no planning answer and no workspace: no confirm, no workspace, no planning write", async () => {
    const def = questionnaireById("form-8829")!;
    setupRow({}, [], false);
    const res = await saveQuestionnaireAnswer({ taxYear: YEAR, questionnaireId: def.id, entityId: PERSONAL, nodeId: "ho1", value: UNSURE_ID });
    expect(res).toEqual({ ok: true });
    expect(ensureWorkspace).not.toHaveBeenCalled();
    expect(mockDb.taxQuestion.updateMany).not.toHaveBeenCalled();
  });

  it("solar_credit 'Not sure' maps to the planning value 'unsure' (a real bank answer), so it is a replace, not a clear", async () => {
    const def = questionnaireById("schedule-3-federal")!;
    setupRow({}, [{ key: "solar_credit", answer: "yes_unclaimed", skippedReason: null, answeredAt: new Date() }]);
    const res = await saveQuestionnaireAnswer({ taxYear: YEAR, questionnaireId: def.id, entityId: PERSONAL, nodeId: "s35", value: UNSURE_ID });
    // documented plan behaviour (6.8): not confirm-gated because 'unsure' is a legitimate Planning answer
    expect(res).toEqual({ ok: true });
    expect(mockDb.taxQuestion.updateMany.mock.calls[0]![0].data.answer).toBe("unsure");
  });
});

describe("number nodes over unparseable planning prose", () => {
  it("ut3: prose needs confirm; confirmed writes canonical whole dollars; ho5 same for sqft", async () => {
    const f2210 = questionnaireById("form-2210")!;
    const st = stateMakingVisible(f2210, "ut3");
    setupRow(st.stored, [{ key: "estimated_tax_payments_amount", answer: "about 12 grand", skippedReason: null, answeredAt: new Date() }]);
    const a = { taxYear: YEAR, questionnaireId: "form-2210", entityId: PERSONAL, nodeId: "ut3", value: 1_200_000 };
    expect(await saveQuestionnaireAnswer(a)).toMatchObject({ ok: false, code: "needs_confirm" });
    expect(writes()).toBe(0);
    expect(await saveQuestionnaireAnswer({ ...a, confirmed: true })).toEqual({ ok: true });
    expect(mockDb.taxQuestion.updateMany.mock.calls[0]![0].data.answer).toBe("12000");
    expect(ensureWorkspace).toHaveBeenCalledTimes(1);
  });

  it("a prose planning answer on a prose-only (link-only) question is never written by any action", async () => {
    // retirement_contributions / retirement_contribution_amount / estimated_taxes_2025 are not bound by any node
    const bound = new Set<string>();
    for (const d of QUESTIONNAIRES) for (const n of d.nodes) if (n.binding) bound.add(n.binding.questionKey);
    for (const k of ["retirement_contributions", "retirement_contribution_amount", "estimated_taxes_2025"]) expect(bound.has(k), k).toBe(false);
    for (const d of QUESTIONNAIRES) for (const l of d.planningLinks ?? []) expect(bound.has(l.key), `${d.id}:${l.key}`).toBe(false);
  });
});

describe("note and reset", () => {
  it("note text never reaches the audit log; boundaries; whitespace; reset keeps planning untouched", async () => {
    const SECRET = "TOPSECRET-NOTE-12345 ssn 123-45-6789";
    for (const def of QUESTIONNAIRES) {
      vi.clearAllMocks();
      mockDb.entity.findMany.mockResolvedValue(ENTITIES);
      mockDb.taxQuestionnaire.findUnique.mockResolvedValue({ note: "previous-secret-777", answers: {} });
      const r = await saveQuestionnaireNote({ taxYear: YEAR, questionnaireId: def.id, entityId: entityFor(def), note: `  ${SECRET}  ` });
      expect(r, def.id).toEqual({ ok: true });
      const audit = auditJson();
      expect(audit).not.toContain("TOPSECRET");
      expect(audit).not.toContain("previous-secret");
      expect(audit).not.toContain("123-45");
      expect(JSON.parse(audit)[0].data.after.noteLength).toBe(SECRET.length);
      expect(mockDb.taxQuestionnaire.upsert.mock.calls[0]![0].update.note).toBe(SECRET);
    }
    vi.clearAllMocks();
    mockDb.entity.findMany.mockResolvedValue(ENTITIES);
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue(null);
    expect((await saveQuestionnaireNote({ taxYear: YEAR, questionnaireId: "form-8889", entityId: PERSONAL, note: "a".repeat(2000) })).ok).toBe(true);
    expect((await saveQuestionnaireNote({ taxYear: YEAR, questionnaireId: "form-8889", entityId: PERSONAL, note: "a".repeat(2001) })).ok).toBe(false);
    expect((await saveQuestionnaireNote({ taxYear: YEAR, questionnaireId: "form-8889", entityId: PERSONAL, note: "   " })).ok).toBe(true);
    expect(mockDb.taxQuestionnaire.upsert.mock.calls.at(-1)![0].update.note).toBeNull();
    // 2000 chars + padding spaces: trimmed first, so accepted
    expect((await saveQuestionnaireNote({ taxYear: YEAR, questionnaireId: "form-8889", entityId: PERSONAL, note: ` ${"a".repeat(2000)} ` })).ok).toBe(true);
  });

  it("reset: updates (never deletes), audit before = value map without note, planning untouched, no workspace", async () => {
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue({
      answers: { hs1: { v: "eric", at: "t", by: USER }, hs5: { v: 500000, at: "t", by: USER } },
      note: "do-not-log-me",
    });
    const res = await resetQuestionnaire({ taxYear: YEAR, questionnaireId: "form-8889", entityId: PERSONAL });
    expect(res).toEqual({ ok: true });
    expect(mockDb.taxQuestion.updateMany).not.toHaveBeenCalled();
    expect(ensureWorkspace).not.toHaveBeenCalled();
    const upd = mockDb.taxQuestionnaire.update.mock.calls[0]![0];
    expect(upd.data).toMatchObject({ answers: {}, note: null, noteUpdatedAt: null });
    const audit = auditJson();
    expect(audit).not.toContain("do-not-log-me");
    const rec = JSON.parse(audit)[0];
    expect(rec.data.changeType).toBe("tax_questionnaire_reset");
    expect(rec.data.before.answers).toEqual({ hs1: "eric", hs5: 500000 });
    expect(Object.keys(mockDb)).not.toContain("delete");
  });

  it("every action rejects an unauthenticated session and a session without a user id", async () => {
    for (const session of [null, {}, { user: {} }, { user: { id: "" } }]) {
      authMock.mockResolvedValue(session);
      await expect(saveQuestionnaireAnswer({ taxYear: YEAR, questionnaireId: "form-8889", entityId: PERSONAL, nodeId: "hs1", value: "eric" })).rejects.toThrow();
      await expect(saveQuestionnaireNote({ taxYear: YEAR, questionnaireId: "form-8889", entityId: PERSONAL, note: "x" })).rejects.toThrow();
      await expect(resetQuestionnaire({ taxYear: YEAR, questionnaireId: "form-8889", entityId: PERSONAL })).rejects.toThrow();
    }
    expect(mockDb.entity.findMany).not.toHaveBeenCalled();
  });

  it("a failed transaction returns a generic error and does not claim success", async () => {
    mockDb.$transaction.mockRejectedValue(new Error("boom with details"));
    const r = await saveQuestionnaireAnswer({ taxYear: YEAR, questionnaireId: "form-8889", entityId: PERSONAL, nodeId: "hs1", value: "eric" });
    expect(r).toEqual({ ok: false, error: "Could not save the answer" });
  });
});
