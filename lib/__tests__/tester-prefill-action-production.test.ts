// TESTER: the REAL accept action over production-shaped suggestions (db / auth / loader mocked at the boundary).
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const loaderMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tax-prefill-build", () => ({ loadPrefillSuggestions: loaderMock }));
const mockDb = vi.hoisted(() => {
  const m = {
    entity: { findMany: vi.fn() },
    taxWorkspace: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    taxQuestion: { updateMany: vi.fn() },
    taxQuestionnaire: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  return m;
});
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { acceptPrefillSuggestions } from "@/actions/tax-questionnaire-prefill";
import { ERIC, EVA, box12, returnDoc, suggestionsFor, w2doc } from "@/lib/__tests__/tax-prefill-fixtures";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const RC = "return-completeness";
const AT = "2026-10-03T10:00:00.000Z";
const E1 = "dddddddd-0000-4000-8000-000000000001";
const E2 = "dddddddd-0000-4000-8000-000000000002";
const V1 = "dddddddd-0000-4000-8000-000000000003";
const V2 = "dddddddd-0000-4000-8000-000000000004";
const RET = "dddddddd-0000-4000-8000-000000000005";

function prodDocs() {
  return [
    w2doc(E1, ERIC, { employerName: "NUMU Food Group", employerEIN: "91-9191919", wagesCents: 5_000_000, box12: box12(["DD", 800_000]), retirementPlan: false }),
    w2doc(E2, ERIC, { employerName: "Alpine Bio", employerEIN: "82-8282828", wagesCents: 7_000_000, box12: box12(["DD", 650_000]), retirementPlan: false }),
    w2doc(V1, EVA, { employerName: "Seacoast Mushrooms", employerEIN: "73-7373737", wagesCents: 3_000_000, box12: [], retirementPlan: false }),
    w2doc(V2, EVA, { employerName: "Fox Farm Brewery", employerEIN: "64-6464646", wagesCents: 4_000_000, box12: box12(["D", 54_089]), retirementPlan: true }),
    returnDoc(RET, { filingStatus: "mfj" }),
  ];
}

// The saved answers are re-read INSIDE the transaction (fix for D1), so the tx exposes the same findUnique mock.
const tx = { taxQuestionnaire: { upsert: vi.fn(), findUnique: mockDb.taxQuestionnaire.findUnique }, auditLog: { create: vi.fn() } };
const written = () => (tx.taxQuestionnaire.upsert.mock.calls[0]![0] as { update: { answers: Record<string, Record<string, unknown>> } }).update.answers;

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  // `tx` is a DIFFERENT object from `db`: any write outside $transaction hits a db mock that records it.
  mockDb.$transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx));
  mockDb.entity.findMany.mockResolvedValue([{ id: PERSONAL, name: "Personal", slug: "personal", type: "personal", foundedDate: null, taxStatusNotes: null }]);
  mockDb.taxQuestionnaire.findUnique.mockResolvedValue(null);
  mockDb.taxWorkspace.findUnique.mockResolvedValue(null);
  loaderMock.mockResolvedValue(suggestionsFor(prodDocs()));
});

const base = { taxYear: 2025 as const, questionnaireId: RC, entityId: PERSONAL };

function stored(answers: unknown) {
  return { taxYear: 2025, entityId: PERSONAL, questionnaireId: RC, definitionVersion: 2, answers, note: null };
}

describe("accept action, production-shaped household", () => {
  it("bulk writes exactly Eva's plan + deferral (+amount in cents) and pyjoint; never Eric's weak 'no'/'none'; one tx, one audit; no direct db writes", async () => {
    const res = await acceptPrefillSuggestions({ ...base, mode: "bulk", items: [] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.accepted.sort()).toEqual(["def_eva", "defamt_eva", "plan_eva", "pyjoint"]);
    const a = written();
    expect(a.defamt_eva).toMatchObject({ v: 54_089, by: USER, src: { kind: "document", field: "w2.box12.deferrals", docValue: 54_089, basis: "doc_verified" } });
    expect(a.plan_eva).toMatchObject({ v: "yes" });
    expect(a.pyjoint).toMatchObject({ v: "yes", src: { docIds: [RET], docValue: "mfj" } });
    expect(a.plan_eric).toBeUndefined();
    expect(a.def_eric).toBeUndefined();
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    for (const m of [mockDb.taxQuestionnaire.upsert, mockDb.taxQuestionnaire.update, mockDb.taxWorkspace.create, mockDb.taxWorkspace.upsert, mockDb.taxQuestion.updateMany, mockDb.auditLog.create]) {
      expect(m).not.toHaveBeenCalled();
    }
  });

  it("no EIN / employer name / wages in anything written (answers JSON or audit)", async () => {
    await acceptPrefillSuggestions({ ...base, mode: "bulk", items: [] });
    const blob = JSON.stringify([tx.taxQuestionnaire.upsert.mock.calls, tx.auditLog.create.mock.calls]);
    for (const bad of ["91-9191919", "82-8282828", "73-7373737", "64-6464646", "NUMU", "Alpine", "Seacoast", "Fox Farm", "4000000", "5000000", "extractionData"]) expect(blob).not.toContain(bad);
  });

  it("Eric's weak 'none' / 'no' can still be accepted one click at a time (explicit), recorded weak-free of names", async () => {
    const res = await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "def_eric" }, { nodeId: "plan_eric" }] });
    expect(res).toEqual({ ok: true, accepted: ["def_eric", "plan_eric"] });
    expect(written().def_eric).toMatchObject({ v: "none", src: { docValue: 0 } });
    expect(written().plan_eric).toMatchObject({ v: "no" });
  });

  it("an owner-typed answer that differs is skipped by bulk, and 'Use the document value' (items) overwrites both nodes and audits the previous value", async () => {
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue(
      stored({ def_eva: { v: "some", at: AT, by: "u1" }, defamt_eva: { v: 139_398, at: AT, by: "u1" }, plan_eva: { v: "yes", at: AT, by: "u1" } })
    );
    const bulk = await acceptPrefillSuggestions({ ...base, mode: "bulk", items: [] });
    expect(bulk.ok).toBe(true);
    if (bulk.ok) expect(bulk.accepted).not.toContain("defamt_eva"); // her typed $1,393.98 is never silently replaced
    tx.taxQuestionnaire.upsert.mockClear();
    tx.auditLog.create.mockClear();
    const res = await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "def_eva" }] });
    expect(res.ok).toBe(true);
    expect(written().defamt_eva).toMatchObject({ v: 54_089, src: { docValue: 54_089 } });
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).toContain("139398"); // previous value kept in the audit row
  });

  it("bulk with every strong suggestion already answered says nothing to accept and writes nothing", async () => {
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue(
      stored({ plan_eva: { v: "no", at: AT, by: "u1" }, def_eva: { v: "none", at: AT, by: "u1" }, pyjoint: { v: "no", at: AT, by: "u1" } })
    );
    const res = await acceptPrefillSuggestions({ ...base, mode: "bulk", items: [] });
    expect(res).toEqual({ ok: false, error: "There is nothing to accept right now" });
    expect(tx.taxQuestionnaire.upsert).not.toHaveBeenCalled();
  });

  it("the other tax years / a forged documentIds list for another person's W-2 are rejected", async () => {
    for (const id of [E1, E2]) {
      const res = await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "def_eva", documentIds: [id] }] });
      expect(res.ok).toBe(false);
    }
    const dup = await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "def_eva", documentIds: [V2, V2, V2] }] });
    expect(dup.ok).toBe(true); // duplicates collapse, still only V2's $540.89
    expect(written().defamt_eva).toMatchObject({ v: 54_089, src: { docIds: [V2] } });
  });
});

describe("D1 (fixed): an answer saved by the other household member while the suggestion loader runs is not lost", () => {
  // The saved answers are read again inside the transaction, after the (slow) loader returned, and only the
  // accepted nodes are merged into that fresh copy.
  it("items mode keeps the answer saved during the loader", async () => {
    const OTHER = { age_eric: { v: "no", at: AT, by: "u-eva" } };
    // before the loader runs the row is empty; the other member saves while the loader is running
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue(stored({}));
    loaderMock.mockImplementation(async () => {
      mockDb.taxQuestionnaire.findUnique.mockResolvedValue(stored(OTHER));
      return suggestionsFor(prodDocs());
    });
    const res = await acceptPrefillSuggestions({ ...base, mode: "items", items: [{ nodeId: "pyjoint" }] });
    expect(res.ok).toBe(true);
    expect(written().age_eric).toEqual(OTHER.age_eric);
    expect(written().pyjoint).toBeDefined();
  });

  it("bulk mode decides what is still waiting from the fresh copy (a node answered meanwhile is not overwritten)", async () => {
    const OTHER = { pyjoint: { v: "no", at: AT, by: "u-eva" } };
    mockDb.taxQuestionnaire.findUnique.mockResolvedValue(stored({}));
    loaderMock.mockImplementation(async () => {
      mockDb.taxQuestionnaire.findUnique.mockResolvedValue(stored(OTHER));
      return suggestionsFor(prodDocs());
    });
    const res = await acceptPrefillSuggestions({ ...base, mode: "bulk", items: [] });
    expect(res.ok).toBe(true);
    expect(written().pyjoint).toEqual(OTHER.pyjoint);
    expect(Object.keys(written())).toEqual(expect.arrayContaining(["plan_eva", "def_eva", "defamt_eva"]));
  });
});
