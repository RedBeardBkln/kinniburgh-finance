import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Mocks at the db / auth / loader boundary (repo convention: no integrated DB tests).
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const loaderMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tax-prefill-build", () => ({ loadPrefillSuggestions: loaderMock }));

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

import { acceptPrefillSuggestions } from "@/actions/tax-questionnaire-prefill";
import type { PrefillSuggestion } from "@/lib/tax-prefill";
import { DOC_A, DOC_B, DOC_EVA, DOC_OTHER, DOC_RET, DOC_RET2, ERIC, EVA, box12, rawInputs, returnDoc, suggestionsFor, w2doc } from "@/lib/__tests__/tax-prefill-fixtures";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const EKC = "33333333-3333-4333-8333-333333333333";
const RC = "return-completeness";

const ENTITIES = [
  { id: PERSONAL, name: "Personal", slug: "personal", type: "personal", foundedDate: null, taxStatusNotes: null },
  { id: EKC, name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting", type: "business", foundedDate: null, taxStatusNotes: null },
];

const base = { taxYear: 2025 as const, questionnaireId: RC, entityId: PERSONAL };

function code(file: string): string {
  return readFileSync(resolve(__dirname, "../../", file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function written(): Record<string, Record<string, unknown>> {
  const call = mockDb.taxQuestionnaire.upsert.mock.calls[0]![0] as { update: { answers: Record<string, Record<string, unknown>> } };
  return call.update.answers;
}

const auditJson = (): string => JSON.stringify(mockDb.auditLog.create.mock.calls.map((c) => c[0]));

/** Eric: two verified W-2s (D $12,000 + AA $6,500), plan checked. Eva: one UNVERIFIED W-2 with a deferral. One 2024 return (mfj). */
function standardDocs() {
  return [
    w2doc(DOC_A, ERIC, { employerName: "Alpine Bio", box12: box12(["D", 1_200_000]), retirementPlan: true }),
    w2doc(DOC_B, ERIC, { employerName: "NUMU Food Group", box12: box12(["AA", 650_000]) }),
    w2doc(DOC_EVA, EVA, { employerName: "Fox Farm Brewery", box12: box12(["D", 400_000]) }, { verified: false }),
    returnDoc(DOC_RET, { filingStatus: "mfj" }),
  ];
}

function stored(answers: unknown) {
  return { taxYear: 2025, entityId: PERSONAL, questionnaireId: RC, definitionVersion: 2, answers, note: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$transaction.mockImplementation(async (cb: (tx: typeof mockDb) => Promise<unknown>) => cb(mockDb));
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.entity.findMany.mockResolvedValue(ENTITIES);
  mockDb.taxQuestionnaire.findUnique.mockResolvedValue(null);
  mockDb.taxQuestionnaire.upsert.mockResolvedValue({});
  mockDb.taxWorkspace.findUnique.mockResolvedValue(null);
  mockDb.auditLog.create.mockResolvedValue({});
  loaderMock.mockResolvedValue(suggestionsFor(standardDocs()));
});

describe("auth, source checks and input validation", () => {
  it("rejects an unauthenticated caller before touching the db or the loader", async () => {
    authMock.mockResolvedValue(null);
    await expect(acceptPrefillSuggestions({ ...base, mode: "bulk", items: [] })).rejects.toThrow("Unauthorized");
    expect(mockDb.entity.findMany).not.toHaveBeenCalled();
    expect(mockDb.taxQuestionnaire.findUnique).not.toHaveBeenCalled();
    expect(loaderMock).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("source check: every export starts with `const user = await requireAuth();` and the file exports only the accept action", () => {
    const src = readFileSync(resolve(__dirname, "../../actions/tax-questionnaire-prefill.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(src.startsWith('"use server";')).toBe(true);
    const names = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    expect(names).toEqual(["acceptPrefillSuggestions"]);
    expect([...src.matchAll(/^export /gm)]).toHaveLength(1);
    for (const name of names) {
      const start = src.indexOf(`export async function ${name}`);
      const body = src.slice(src.indexOf("{\n", start) + 2, src.indexOf("{\n", start) + 120);
      expect(body.trimStart().startsWith("const user = await requireAuth();"), name).toBe(true);
    }
  });

  it("the pinned export list of actions/tax-questionnaires.ts is untouched", () => {
    const src = readFileSync(resolve(__dirname, "../../actions/tax-questionnaires.ts"), "utf8");
    expect([...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]).sort()).toEqual(["resetQuestionnaire", "saveQuestionnaireAnswer", "saveQuestionnaireNote"]);
  });

  it("source check: no hard delete, no `any`, no window.confirm, nothing logged, in every prefill file", () => {
    for (const file of [
      "actions/tax-questionnaire-prefill.ts",
      "lib/tax-prefill.ts",
      "lib/tax-prefill-build.ts",
      "components/tax/forms/prefill-panel.tsx",
      "components/tax/forms/questionnaire-runner.tsx",
    ]) {
      const src = code(file);
      expect(src, file).not.toMatch(/\.delete\(|\.deleteMany\(/);
      expect(src, file).not.toMatch(/:\s*any\b|as any\b/);
      expect(src, file).not.toMatch(/window\.confirm|\bconfirm\(/);
      expect(src, file).not.toMatch(/console\.(log|error|warn|info)/);
    }
  });

  it("render safety: the loader and the page loader never write and never open a workspace", () => {
    for (const file of ["lib/tax-prefill-build.ts", "lib/tax-questionnaire-build.ts", "lib/tax-prefill.ts"]) {
      const src = code(file);
      expect(src, file).not.toMatch(/ensurePersonalWorkspace|ensureTaxWorkspace/);
      expect(src, file).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    }
    // the page that renders the questionnaire has no server action import that writes during render
    const page = code("app/tax/forms/[year]/questionnaire/[questionnaireId]/page.tsx");
    expect(page).not.toMatch(/acceptPrefillSuggestions|saveQuestionnaireAnswer/);
  });

  it("rejects bad input before any db call (year, entity, non-uuid document id, empty items)", async () => {
    const bad: unknown[] = [
      { ...base, taxYear: 2024, mode: "bulk", items: [] },
      { ...base, entityId: "not-a-uuid", mode: "bulk", items: [] },
      { ...base, mode: "items", items: [] },
      { ...base, mode: "items", items: [{ nodeId: "plan_eric", documentIds: ["nope"] }] },
      { ...base, mode: "items", items: Array.from({ length: 41 }, () => ({ nodeId: "plan_eric" })) },
      { ...base, mode: "everything", items: [] },
    ];
    for (const input of bad) {
      const res = await acceptPrefillSuggestions(input as Parameters<typeof acceptPrefillSuggestions>[0]);
      expect(res.ok, JSON.stringify(input)).toBe(false);
    }
    expect(mockDb.entity.findMany).not.toHaveBeenCalled();
  });

  it("an entity that is not the household's Personal entity is rejected", async () => {
    const res = await acceptPrefillSuggestions({ ...base, entityId: EKC, mode: "items", items: [{ nodeId: "plan_eric" }] });
    expect(res.ok).toBe(false);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

describe("accepting one suggestion", () => {
  it("recomputes the value on the server, ignores any client-sent value, writes parent + dependent in ONE transaction with src and ONE audit row", async () => {
    const res = await acceptPrefillSuggestions({
      ...base,
      mode: "items",
      // a `value` smuggled in by a client is not part of the schema and is ignored
      items: [{ nodeId: "def_eric", value: "none", answer: 5 } as unknown as { nodeId: string }],
    });
    expect(res).toEqual({ ok: true, accepted: ["def_eric", "defamt_eric"] });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.taxQuestionnaire.upsert).toHaveBeenCalledTimes(1);
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
    const a = written();
    const src = { kind: "document", field: "w2.box12.deferrals", docIds: [DOC_A, DOC_B], basis: "doc_verified", docValue: 1_850_000 };
    expect(a.def_eric).toMatchObject({ v: "some", by: USER, src });
    expect(a.defamt_eric).toMatchObject({ v: 1_850_000, by: USER, src });
    expect(typeof a.def_eric!.at).toBe("string");
    const audit = mockDb.auditLog.create.mock.calls[0]![0] as { data: { changeType: string; changedBy: string } };
    expect(audit.data.changeType).toBe("tax_questionnaire_prefill_accept");
    expect(audit.data.changedBy).toBe(USER);
  });

  it("the audit row holds ids, codes and numbers only (no employer names, labels or free text)", async () => {
    await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "def_eric" }] });
    const json = auditJson();
    for (const forbidden of ["Alpine Bio", "NUMU", "Fox Farm", "Employer", "chip", "caveat", "Yes", "verified:"]) expect(json).not.toContain(forbidden);
    expect(json).toContain("w2.box12.deferrals");
    expect(json).toContain(DOC_A);
    expect(json).toContain("doc_verified");
    expect(json).toContain("1850000");
  });

  it("uses only the chosen documents (a subset) and recomputes from them", async () => {
    const res = await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "def_eric", documentIds: [DOC_B] }] });
    expect(res.ok).toBe(true);
    expect(written().defamt_eric).toMatchObject({ v: 650_000, src: { docIds: [DOC_B], docValue: 650_000 } });
  });

  it("rejects a document id that is not a candidate for that answer (another person's W-2, an unknown id)", async () => {
    for (const id of [DOC_EVA, DOC_OTHER]) {
      const res = await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "def_eric", documentIds: [id] }] });
      expect(res).toEqual({ ok: false, error: "Those documents cannot be used for this answer" });
    }
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a question that has no suggestion, and a question listed twice", async () => {
    expect((await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "ira_eric" }] })).ok).toBe(false);
    expect((await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "plan_eric" }, { nodeId: "plan_eric" }] })).ok).toBe(false);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("a weak suggestion can be accepted one at a time (its own click)", async () => {
    const res = await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "def_eva" }] });
    expect(res.ok).toBe(true);
    expect(written().def_eva).toMatchObject({ v: "some", src: { basis: "doc_unverified", docIds: [DOC_EVA] } });
  });

  it("when several 2024 returns exist the owner must choose one; the chosen one is then used", async () => {
    loaderMock.mockResolvedValue(suggestionsFor([returnDoc(DOC_RET, { filingStatus: "mfj" }), returnDoc(DOC_RET2, { filingStatus: "single" })]));
    const none = await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "pyjoint" }] });
    expect(none).toEqual({ ok: false, error: "Pick the document to use first" });
    const picked = await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "pyjoint", documentIds: [DOC_RET2] }] });
    expect(picked.ok).toBe(true);
    expect(written().pyjoint).toMatchObject({ v: "no", src: { docIds: [DOC_RET2], docValue: "single" } });
  });

  it("a Planning-based suggestion is stored with kind planning and no document ids", async () => {
    loaderMock.mockResolvedValue(suggestionsFor([], { planning: { ...rawInputs([]).planning, solarCredit: "claimed_already" } }));
    const res = await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "g_solar_credit" }] });
    expect(res.ok).toBe(true);
    expect(written().g_solar_credit).toMatchObject({ v: "none", src: { kind: "planning", docIds: [], basis: "planning", docValue: "claimed_already" } });
  });

  it("keeps every other node's saved answer and src when merging", async () => {
    const otherSrc = { kind: "document", field: "w2.box13.plan", docIds: [DOC_A], basis: "doc_verified", docValue: "yes" };
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue(
      stored({ plan_eric: { v: "yes", at: "2026-10-04T10:00:00.000Z", by: "u1", src: otherSrc }, age_eric: { v: "no", at: "2026-10-04T10:00:00.000Z", by: "u1" } })
    );
    await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "def_eric" }] });
    const a = written();
    expect(a.plan_eric).toEqual({ v: "yes", at: "2026-10-04T10:00:00.000Z", by: "u1", src: otherSrc });
    expect(a.age_eric).toEqual({ v: "no", at: "2026-10-04T10:00:00.000Z", by: "u1" });
    expect(a.def_eric).toBeDefined();
  });

  it("rejects a hidden node (a dependent amount without its gate) and a Planning-bound node", async () => {
    const crafted = (nodeId: string, value: string | number): PrefillSuggestion => ({
      key: `x:${nodeId}`,
      questionnaireId: RC,
      ruleId: "planning_solar",
      person: null,
      personName: null,
      field: "planning.solar_credit",
      kind: "planning",
      nodeIds: [nodeId],
      answers: [{ nodeId, value }],
      strength: "weak",
      basis: "planning",
      docValue: "claimed_already",
      chip: "x",
      caveats: [],
      needsPick: false,
      docIds: [],
      candidates: [],
    });
    loaderMock.mockResolvedValue([crafted("defamt_eric", 100)]);
    expect(await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "defamt_eric" }] })).toEqual({ ok: false, error: "That question is not shown right now" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    // form-2210 ut3 is bound to a Planning answer: never prefilled
    loaderMock.mockResolvedValue([{ ...crafted("ut3", 100), questionnaireId: "form-2210" }]);
    const res = await acceptPrefillSuggestions({ ...base, questionnaireId: "form-2210", mode: "items", items: [{ nodeId: "ut3" }] });
    expect(res.ok).toBe(false);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("returns an error and writes nothing when the loader produced no suggestions", async () => {
    loaderMock.mockResolvedValue([]);
    const res = await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "def_eric" }] });
    expect(res.ok).toBe(false);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

describe("bulk accept", () => {
  it("writes only the suggestions the SERVER marks strong and still waiting", async () => {
    // Eric's deferral + plan and the 2024 return are strong; Eva's (unverified) is weak; the owner already answered ut-style nodes differently.
    const res = await acceptPrefillSuggestions({ ...base, mode: "bulk", items: [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted.sort()).toEqual(["def_eric", "defamt_eric", "plan_eric", "pyjoint"].sort());
    expect(Object.keys(written())).not.toContain("def_eva");
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("ignores any items a client sends in bulk mode (the server decides)", async () => {
    const res = await acceptPrefillSuggestions({ ...base, mode: "bulk", items: [{ nodeId: "def_eva" }] });
    expect(res.ok).toBe(true);
    expect(Object.keys(written())).not.toContain("def_eva");
  });

  it("skips a node the owner already answered differently, and one already accepted", async () => {
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue(
      stored({
        plan_eric: { v: "no", at: "2026-10-04T10:00:00.000Z", by: "u1" },
        pyjoint: {
          v: "yes",
          at: "2026-10-04T10:00:00.000Z",
          by: "u1",
          src: { kind: "document", field: "return2024.filingStatus", docIds: [DOC_RET], basis: "doc_verified", docValue: "mfj" },
        },
      })
    );
    const res = await acceptPrefillSuggestions({ ...base, mode: "bulk", items: [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted.sort()).toEqual(["def_eric", "defamt_eric"]);
    expect(written().plan_eric).toMatchObject({ v: "no" });
  });

  it("with nothing strong waiting it errors and writes nothing", async () => {
    loaderMock.mockResolvedValue(suggestionsFor([w2doc(DOC_A, ERIC, { box12: box12(["D", 100_000]) }, { verified: false })]));
    const res = await acceptPrefillSuggestions({ ...base, mode: "bulk", items: [] });
    expect(res).toEqual({ ok: false, error: "There is nothing to accept right now" });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});
