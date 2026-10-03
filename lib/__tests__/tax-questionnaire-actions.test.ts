import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma } from "@prisma/client";

// Mocks at the db/auth boundary (repo convention: no integrated DB tests).
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

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const EKC = "33333333-3333-4333-8333-333333333333";
const SV = "44444444-4444-4444-8444-444444444444";
const ARCHIVED = "55555555-5555-4555-8555-555555555555";
const WS = "66666666-6666-4666-8666-666666666666";

const ENTITIES = [
  { id: PERSONAL, name: "Personal", slug: "personal", type: "personal", foundedDate: null, taxStatusNotes: null },
  { id: EKC, name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting", type: "business", foundedDate: null, taxStatusNotes: null },
  { id: SV, name: "Sudden Valley Property Management, LLC", slug: "sudden-valley", type: "business", foundedDate: new Date("2026-02-01"), taxStatusNotes: null },
];

const base = { taxYear: 2025, questionnaireId: "form-8889", entityId: PERSONAL };

function planningRows(rows: { key: string; answer: unknown; skippedReason?: string | null; answeredAt?: Date | null }[]) {
  return rows.map((r) => ({ key: r.key, answer: r.answer, skippedReason: r.skippedReason ?? null, answeredAt: r.answeredAt ?? null }));
}

/** Source text with comments removed (rules about CODE, not about the comments that explain them). */
function code(file: string): string {
  return readFileSync(resolve(__dirname, "../../", file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The JSON that actually went to the audit log, serialized. */
function auditJson(): string {
  return JSON.stringify(mockDb.auditLog.create.mock.calls.map((c) => c[0]));
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

describe("auth gate", () => {
  it("every export rejects an unauthenticated caller before touching the db", async () => {
    authMock.mockResolvedValue(null);
    await expect(saveQuestionnaireAnswer({ ...base, nodeId: "hs1", value: "eric" })).rejects.toThrow("Unauthorized");
    await expect(saveQuestionnaireNote({ ...base, note: "x" })).rejects.toThrow("Unauthorized");
    await expect(resetQuestionnaire(base)).rejects.toThrow("Unauthorized");
    expect(mockDb.entity.findMany).not.toHaveBeenCalled();
    expect(mockDb.taxQuestionnaire.findUnique).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(ensureWorkspace).not.toHaveBeenCalled();
  });

  it("source check: every exported function starts with `const user = await requireAuth();`", () => {
    const src = readFileSync(resolve(__dirname, "../../actions/tax-questionnaires.ts"), "utf8").replace(/\r\n/g, "\n");
    const names = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    expect(names.sort()).toEqual(["resetQuestionnaire", "saveQuestionnaireAnswer", "saveQuestionnaireNote"]);
    for (const name of names) {
      const start = src.indexOf(`export async function ${name}`);
      const body = src.slice(src.indexOf("{\n", start) + 2, src.indexOf("{\n", start) + 120);
      expect(body.trimStart().startsWith("const user = await requireAuth();"), name).toBe(true);
    }
  });

  it("source check: no hard delete, no `any`, no window.confirm", () => {
    const files = [
      "actions/tax-questionnaires.ts",
      "lib/tax-questionnaire.ts",
      "lib/tax-questionnaire-content.ts",
      "lib/tax-questionnaire-build.ts",
      "components/tax/forms/questionnaire-runner.tsx",
      "components/tax/forms/questionnaire-card-block.tsx",
      "components/tax/forms/cpa-summary-view.tsx",
    ];
    for (const file of files) {
      const src = code(file);
      expect(src, file).not.toMatch(/\.delete\(|\.deleteMany\(/);
      expect(src, file).not.toMatch(/:\s*any\b|as any\b/);
      expect(src, file).not.toMatch(/window\.confirm|\bconfirm\(/);
    }
  });

  it("source check: the Forms page and the new pages never create a workspace while rendering", () => {
    for (const file of [
      "lib/tax-questionnaire-build.ts",
      "lib/tax-forms-build.ts",
      "app/tax/forms/[year]/cpa-summary/page.tsx",
      "app/tax/forms/[year]/questionnaire/[questionnaireId]/page.tsx",
    ]) {
      const src = code(file);
      expect(src, file).not.toMatch(/ensurePersonalWorkspace|ensureTaxWorkspace/);
      expect(src, file).not.toMatch(/\.(create|update|upsert|delete)(Many)?\(/);
    }
  });

  it("source check: the Forms-page questionnaire read is guarded so a missing table cannot break the page", () => {
    const src = readFileSync(resolve(__dirname, "../../lib/tax-forms-build.ts"), "utf8");
    expect(src).toMatch(/loadQuestionnaireRowsSafe/);
    expect(src).toMatch(/try \{\s*return await db\.taxQuestionnaire\.findMany[\s\S]*?\} catch \{\s*return \[\];/);
  });
});

describe("input validation and scope", () => {
  it("zod rejects a bad year, a non-uuid entity, a non-integer value and an oversize note", async () => {
    expect(await saveQuestionnaireAnswer({ ...base, taxYear: 1999, nodeId: "hs1", value: "eric" })).toMatchObject({ ok: false });
    expect(await saveQuestionnaireAnswer({ ...base, entityId: "nope", nodeId: "hs1", value: "eric" })).toMatchObject({ ok: false });
    expect(await saveQuestionnaireAnswer({ ...base, nodeId: "ho5", value: 1.5 })).toMatchObject({ ok: false });
    expect(await saveQuestionnaireNote({ ...base, note: "x".repeat(2001) })).toMatchObject({ ok: false });
    expect(await resetQuestionnaire({ ...base, taxYear: 3000 })).toMatchObject({ ok: false });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an unknown questionnaire and an unknown question", async () => {
    expect(await saveQuestionnaireAnswer({ ...base, questionnaireId: "nope", nodeId: "hs1", value: "eric" })).toEqual({
      ok: false,
      error: "Unknown questionnaire",
    });
    expect(await saveQuestionnaireAnswer({ ...base, nodeId: "zz9", value: "eric" })).toEqual({ ok: false, error: "Unknown question" });
  });

  it("rejects scope mismatches", async () => {
    // a household questionnaire under a business entity
    expect(await saveQuestionnaireAnswer({ ...base, entityId: EKC, nodeId: "hs1", value: "eric" })).toMatchObject({ ok: false });
    // an entity questionnaire under Personal
    expect(
      await saveQuestionnaireAnswer({ taxYear: 2025, questionnaireId: "entity-ct-filing", entityId: PERSONAL, nodeId: "cf1", value: "household" })
    ).toMatchObject({ ok: false });
    // an archived / unknown entity is not in the non-archived list
    expect(await saveQuestionnaireAnswer({ ...base, entityId: ARCHIVED, nodeId: "hs1", value: "eric" })).toEqual({
      ok: false,
      error: "Entity not found",
    });
    // Sudden Valley not formed yet for 2025
    expect(
      await saveQuestionnaireAnswer({ taxYear: 2025, questionnaireId: "entity-ct-filing", entityId: SV, nodeId: "cf1", value: "household" })
    ).toMatchObject({ ok: false });
    // Sudden Valley-only questionnaires need Sudden Valley active
    expect(
      await saveQuestionnaireAnswer({ taxYear: 2025, questionnaireId: "form-8582", entityId: PERSONAL, nodeId: "pa1", value: "avg7" })
    ).toMatchObject({ ok: false });
    expect(await saveQuestionnaireNote({ ...base, entityId: EKC, note: "x" })).toMatchObject({ ok: false });
    expect(await resetQuestionnaire({ ...base, entityId: EKC })).toMatchObject({ ok: false });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("rejects answering a question that is not currently shown", async () => {
    // hs2 only appears after hs1 is answered with a positive value
    expect(await saveQuestionnaireAnswer({ ...base, nodeId: "hs2", value: "family" })).toEqual({
      ok: false,
      error: "That question is not shown right now",
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid value for the node", async () => {
    expect(await saveQuestionnaireAnswer({ ...base, nodeId: "hs1", value: "martian" })).toMatchObject({ ok: false });
    expect(await saveQuestionnaireAnswer({ ...base, nodeId: "hs1", value: ["eric"] })).toMatchObject({ ok: false });
  });

  it("accepts an entity questionnaire for an active business entity", async () => {
    const res = await saveQuestionnaireAnswer({ taxYear: 2025, questionnaireId: "entity-ct-filing", entityId: EKC, nodeId: "cf1", value: "household" });
    expect(res).toEqual({ ok: true });
    expect(mockDb.taxQuestionnaire.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("unbound answers", () => {
  it("upserts the row and writes one audit row holding ids / option ids only (no labels, no note)", async () => {
    const res = await saveQuestionnaireAnswer({ ...base, nodeId: "hs1", value: "both" });
    expect(res).toEqual({ ok: true });
    expect(ensureWorkspace).not.toHaveBeenCalled();
    expect(mockDb.taxQuestion.updateMany).not.toHaveBeenCalled();

    const upsert = mockDb.taxQuestionnaire.upsert.mock.calls[0]![0];
    expect(upsert.where).toEqual({ taxYear_entityId_questionnaireId: { taxYear: 2025, entityId: PERSONAL, questionnaireId: "form-8889" } });
    expect(upsert.create.answers.hs1).toMatchObject({ v: "both", by: USER });
    expect(upsert.create.definitionVersion).toBe(1);

    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = mockDb.auditLog.create.mock.calls[0]![0].data;
    expect(audit.changeType).toBe("tax_questionnaire_answer");
    expect(audit.changedBy).toBe(USER);
    expect(audit.before).toEqual({ taxYear: 2025, questionnaireId: "form-8889", entityId: PERSONAL, nodeId: "hs1", value: null });
    expect(audit.after).toEqual({ taxYear: 2025, questionnaireId: "form-8889", entityId: PERSONAL, nodeId: "hs1", value: "both" });
    expect(auditJson()).not.toContain("Both of us");
  });

  it("merges into the existing answers and records the previous value", async () => {
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue({
      answers: { hs1: { v: "eric", at: "2026-01-01T00:00:00.000Z", by: USER }, zz: { v: "x", at: "2026-01-01T00:00:00.000Z", by: null } },
      note: "kept",
    });
    await saveQuestionnaireAnswer({ ...base, nodeId: "hs1", value: "eva" });
    const upsert = mockDb.taxQuestionnaire.upsert.mock.calls[0]![0];
    expect(upsert.update.answers.hs1).toMatchObject({ v: "eva" });
    expect(upsert.update.answers.zz).toBeTruthy(); // other entries untouched
    expect(upsert.update).not.toHaveProperty("note");
    expect(mockDb.auditLog.create.mock.calls[0]![0].data.before.value).toBe("eric");
  });

  it("a multi-select answer is stored as an array of option ids", async () => {
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue({
      answers: { hs1: { v: "eric", at: "2026-01-01T00:00:00.000Z", by: USER }, hs3: { v: "yes", at: "2026-01-01T00:00:00.000Z", by: USER } },
    });
    await saveQuestionnaireAnswer({ ...base, nodeId: "hs4", value: ["payroll", "direct"] });
    expect(mockDb.taxQuestionnaire.upsert.mock.calls[0]![0].update.answers.hs4.v).toEqual(["payroll", "direct"]);
  });

  it("dollar answers are integer cents; fractional cents are rejected, cents are kept", async () => {
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue({
      answers: {
        hs1: { v: "eric", at: "2026-01-01T00:00:00.000Z", by: USER },
        hs3: { v: "yes", at: "2026-01-01T00:00:00.000Z", by: USER },
        hs4: { v: ["direct"], at: "2026-01-01T00:00:00.000Z", by: USER },
      },
    });
    expect(await saveQuestionnaireAnswer({ ...base, nodeId: "hs5", value: 500_000.5 })).toMatchObject({ ok: false });
    expect(await saveQuestionnaireAnswer({ ...base, nodeId: "hs5", value: 500_000 })).toEqual({ ok: true });
    expect(mockDb.taxQuestionnaire.upsert.mock.calls[0]![0].update.answers.hs5.v).toBe(500_000);
  });
});

describe("bound answers (single source of truth with the Planning screen)", () => {
  const ho = { ...base, questionnaireId: "form-8829" };

  it("writes the planning answer with the bank value, opens the workspace, and keeps only who/when on the row", async () => {
    const res = await saveQuestionnaireAnswer({ ...ho, nodeId: "ho1", value: "yes_exclusive" });
    expect(res).toEqual({ ok: true });
    expect(ensureWorkspace).toHaveBeenCalledWith(2025);
    const call = mockDb.taxQuestion.updateMany.mock.calls[0]![0];
    expect(call.where).toEqual({ workspaceId: WS, key: "home_office_ekc" });
    expect(call.data.answer).toBe("yes_exclusive");
    expect(call.data.skippedReason).toBeNull();
    expect(call.data.answeredAt).toBeInstanceOf(Date);

    const entry = mockDb.taxQuestionnaire.upsert.mock.calls[0]![0].create.answers.ho1;
    expect(entry.v).toBeNull(); // the value lives in the planning answer
    expect(entry.by).toBe(USER);
    expect(entry.at).toBe((call.data.answeredAt as Date).toISOString()); // same Date -> attribution matches

    const audit = mockDb.auditLog.create.mock.calls[0]![0].data;
    expect(audit.after).toMatchObject({ value: "yes_exclusive", planningKey: "home_office_ekc" });
  });

  it("maps option ids to bank values (child credits: 'other' -> other_dependents)", async () => {
    await saveQuestionnaireAnswer({ ...base, questionnaireId: "child-dependent-credits", nodeId: "cd1", value: "other" });
    expect(mockDb.taxQuestion.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { key: "household_members" },
      data: { answer: "other_dependents" },
    });
  });

  it("only the registry's binding allow-list can reach a planning key (a client cannot name one)", () => {
    const src = readFileSync(resolve(__dirname, "../../actions/tax-questionnaires.ts"), "utf8");
    expect(src).toMatch(/key: bound\.questionKey/);
    expect(src).not.toMatch(/parsed\.data\.key/);
  });

  it("a local-only choice over an existing planning answer needs inline confirmation, enforced server-side", async () => {
    mockDb.taxWorkspace.findUnique.mockResolvedValue({
      id: WS,
      questions: planningRows([{ key: "home_office_ekc", answer: "yes_exclusive", answeredAt: new Date("2026-09-01T00:00:00Z") }]),
    });
    const refused = await saveQuestionnaireAnswer({ ...ho, nodeId: "ho1", value: "unsure" });
    expect(refused).toMatchObject({ ok: false, code: "needs_confirm" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.taxQuestion.updateMany).not.toHaveBeenCalled();

    const done = await saveQuestionnaireAnswer({ ...ho, nodeId: "ho1", value: "unsure", confirmed: true });
    expect(done).toEqual({ ok: true });
    const call = mockDb.taxQuestion.updateMany.mock.calls[0]![0];
    expect(call.where).toEqual({ workspaceId: WS, key: "home_office_ekc" });
    expect(call.data).toEqual({ answer: Prisma.DbNull, answeredAt: null, skippedReason: null });
    expect(mockDb.taxQuestionnaire.upsert.mock.calls[0]![0].create.answers.ho1.v).toBe("unsure"); // kept locally
    expect(ensureWorkspace).not.toHaveBeenCalled(); // clearing never opens a workspace
  });

  it("a local-only choice with no planning answer needs no confirmation and does not open a workspace", async () => {
    const res = await saveQuestionnaireAnswer({ ...ho, nodeId: "ho1", value: "unsure" });
    expect(res).toEqual({ ok: true });
    expect(ensureWorkspace).not.toHaveBeenCalled();
    expect(mockDb.taxQuestion.updateMany).not.toHaveBeenCalled();
    expect(mockDb.taxQuestionnaire.upsert.mock.calls[0]![0].create.answers.ho1.v).toBe("unsure");
  });

  it("a typed number over unparseable planning prose needs confirmation; with it, the canonical string is written", async () => {
    mockDb.taxWorkspace.findUnique.mockResolvedValue({
      id: WS,
      questions: planningRows([
        { key: "home_office_ekc", answer: "yes_exclusive", answeredAt: new Date("2026-09-01T00:00:00Z") },
        { key: "home_office_sqft", answer: "about two hundred", answeredAt: new Date("2026-09-01T00:00:00Z") },
      ]),
    });
    const refused = await saveQuestionnaireAnswer({ ...ho, nodeId: "ho5", value: 180 });
    expect(refused).toMatchObject({ ok: false, code: "needs_confirm" });
    expect(mockDb.taxQuestion.updateMany).not.toHaveBeenCalled();

    expect(await saveQuestionnaireAnswer({ ...ho, nodeId: "ho5", value: 180, confirmed: true })).toEqual({ ok: true });
    expect(mockDb.taxQuestion.updateMany.mock.calls[0]![0].data.answer).toBe("180");
  });

  it("a number over a parseable planning answer replaces it without a confirmation", async () => {
    mockDb.taxWorkspace.findUnique.mockResolvedValue({
      id: WS,
      questions: planningRows([
        { key: "home_office_ekc", answer: "yes_exclusive", answeredAt: new Date("2026-09-01T00:00:00Z") },
        { key: "home_office_sqft", answer: "150", answeredAt: new Date("2026-09-01T00:00:00Z") },
      ]),
    });
    expect(await saveQuestionnaireAnswer({ ...ho, nodeId: "ho5", value: 180 })).toEqual({ ok: true });
  });

  it("estimated payments: whole dollars become the planning string the draft parser reads", async () => {
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue({ answers: { ut2: { v: "regular", at: "2026-01-01T00:00:00.000Z", by: USER } } });
    const res = await saveQuestionnaireAnswer({ ...base, questionnaireId: "form-2210", nodeId: "ut3", value: 1_200_000 });
    expect(res).toEqual({ ok: true });
    expect(mockDb.taxQuestion.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { key: "estimated_tax_payments_amount" },
      data: { answer: "12000" },
    });
    expect(mockDb.auditLog.create.mock.calls[0]![0].data.after.value).toBe(1_200_000); // cents in the audit trail
  });

  it("a failed planning write rolls back with a clear error", async () => {
    mockDb.taxQuestion.updateMany.mockResolvedValue({ count: 0 });
    const res = await saveQuestionnaireAnswer({ ...ho, nodeId: "ho1", value: "no" });
    expect(res).toEqual({ ok: false, error: "That planning question is not part of this workspace" });
    expect(mockDb.taxQuestionnaire.upsert).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("note for the CPA", () => {
  it("stores the note, and the audit row holds lengths only - never the text", async () => {
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue({ note: "old private text" });
    const res = await saveQuestionnaireNote({ ...base, note: "  secret planning detail  " });
    expect(res).toEqual({ ok: true });
    const upsert = mockDb.taxQuestionnaire.upsert.mock.calls[0]![0];
    expect(upsert.update.note).toBe("secret planning detail");
    expect(upsert.update.noteUpdatedById).toBe(USER);
    expect(upsert.update.noteUpdatedAt).toBeInstanceOf(Date);
    const audit = mockDb.auditLog.create.mock.calls[0]![0].data;
    expect(audit.changeType).toBe("tax_questionnaire_note");
    expect(audit.before.noteLength).toBe("old private text".length);
    expect(audit.after.noteLength).toBe("secret planning detail".length);
    expect(auditJson()).not.toContain("secret planning detail");
    expect(auditJson()).not.toContain("old private text");
  });

  it("an empty note stores null; exactly 2000 characters is accepted", async () => {
    await saveQuestionnaireNote({ ...base, note: "   " });
    expect(mockDb.taxQuestionnaire.upsert.mock.calls[0]![0].update.note).toBeNull();
    expect(mockDb.auditLog.create.mock.calls[0]![0].data.after.noteLength).toBe(0);
    expect(await saveQuestionnaireNote({ ...base, note: "y".repeat(2000) })).toEqual({ ok: true });
  });
});

describe("reset", () => {
  it("empties answers and note, keeps the prior values in the audit `before`, never touches planning answers", async () => {
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue({
      answers: {
        hs1: { v: "eric", at: "2026-01-01T00:00:00.000Z", by: USER },
        hs5: { v: 500_000, at: "2026-01-01T00:00:00.000Z", by: USER },
      },
      note: "do not log this note",
    });
    const res = await resetQuestionnaire(base);
    expect(res).toEqual({ ok: true });
    expect(mockDb.taxQuestionnaire.update.mock.calls[0]![0]).toMatchObject({
      data: { answers: {}, note: null, noteUpdatedAt: null, noteUpdatedById: null },
    });
    const audit = mockDb.auditLog.create.mock.calls[0]![0].data;
    expect(audit.changeType).toBe("tax_questionnaire_reset");
    expect(audit.before.answers).toEqual({ hs1: "eric", hs5: 500_000 });
    expect(audit.after).toBe(Prisma.JsonNull);
    expect(auditJson()).not.toContain("do not log this note");
    expect(mockDb.taxQuestion.updateMany).not.toHaveBeenCalled();
    expect(ensureWorkspace).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing was saved", async () => {
    expect(await resetQuestionnaire(base)).toEqual({ ok: true });
    expect(mockDb.taxQuestionnaire.update).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create).not.toHaveBeenCalled();
  });
});
