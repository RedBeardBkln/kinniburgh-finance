import { describe, it, expect, vi, beforeEach } from "vitest";

// Tester-added coverage for the DB assembler (lib/tax-forms-build.ts), which the
// Coder left untested. Mocks at the db boundary; every write method throws so a
// stray write on the read-only Forms page path fails loudly.

const dbMocks = vi.hoisted(() => ({
  WRITE_METHODS: ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"],
  readOnlyModel(reads: Record<string, unknown>) {
    const model: Record<string, unknown> = { ...reads };
    for (const m of ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]) {
      model[m] = () => {
        throw new Error(`WRITE ATTEMPTED: ${m}`);
      };
    }
    return model;
  },
  entityFindMany: vi.fn(),
  userFindMany: vi.fn(),
  documentFindMany: vi.fn(),
  workspaceFindMany: vi.fn(),
  mileageCount: vi.fn(),
  accountFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    entity: dbMocks.readOnlyModel({ findMany: dbMocks.entityFindMany }),
    user: dbMocks.readOnlyModel({ findMany: dbMocks.userFindMany }),
    document: dbMocks.readOnlyModel({ findMany: dbMocks.documentFindMany }),
    taxWorkspace: dbMocks.readOnlyModel({ findMany: dbMocks.workspaceFindMany }),
    mileageEntry: dbMocks.readOnlyModel({ count: dbMocks.mileageCount }),
    account: dbMocks.readOnlyModel({ findUnique: dbMocks.accountFindUnique }),
  },
}));

const computeMocks = vi.hoisted(() => ({
  computePL: vi.fn(),
  buildInput: vi.fn(),
  computeReturn: vi.fn(),
}));
vi.mock("@/lib/reports", () => ({ computePL: computeMocks.computePL }));
vi.mock("@/lib/tax-compute-build", () => ({ buildPersonalTaxComputeInput: computeMocks.buildInput }));
vi.mock("@/lib/tax-compute", () => ({ computePersonalTaxReturn: computeMocks.computeReturn }));

import { loadFormsPageData } from "@/lib/tax-forms-build";

const ERIC = { id: "adcaf260-d4f8-47de-b1fe-851173623490", name: "Eric Kinniburgh" };
const EVA = { id: "6da10cc4-1d8c-4551-b8b5-1dec3f5f0913", name: "Eva-Laura Ramirez-Wisiackas" };

// Shaped like the live production entity rows (read-only query during testing).
const ENTITIES = [
  { id: "e-personal", name: "Personal", slug: "personal", type: "personal", foundedDate: null, taxStatusNotes: null },
  {
    id: "e-sv",
    name: "Sudden Valley Property Management, LLC",
    slug: "sudden-valley",
    type: "business",
    foundedDate: new Date("2026-02-01T00:00:00.000Z"),
    taxStatusNotes: null,
  },
  {
    id: "e-ekc",
    name: "Eric Kinniburgh Consulting, LLC",
    slug: "ek-consulting",
    type: "business",
    foundedDate: null,
    taxStatusNotes: "Single-member LLC, disregarded entity — Schedule C on Eric's personal Form 1040.",
  },
  {
    id: "e-mezzo",
    name: "Mezzo",
    slug: "mezzo",
    type: "business",
    foundedDate: null,
    taxStatusNotes: "Not yet formed/registered as of June 2026.",
  },
];

function walkForNonPlain(value: unknown, path = "$"): string[] {
  const bad: string[] = [];
  if (value instanceof Date) bad.push(`${path} is a Date`);
  else if (value !== null && typeof value === "object") {
    const ctor = (value as object).constructor?.name;
    if (ctor && ctor !== "Object" && ctor !== "Array") bad.push(`${path} is a ${ctor}`);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) bad.push(...walkForNonPlain(v, `${path}.${k}`));
  }
  return bad;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.entityFindMany.mockResolvedValue(ENTITIES);
  dbMocks.userFindMany.mockResolvedValue([EVA, ERIC]);
  dbMocks.documentFindMany.mockResolvedValue([]);
  dbMocks.workspaceFindMany.mockResolvedValue([]);
  dbMocks.mileageCount.mockResolvedValue(0);
  dbMocks.accountFindUnique.mockResolvedValue(null);
  computeMocks.computePL.mockResolvedValue({ incomeLines: [], expenseLines: [] });
  computeMocks.buildInput.mockResolvedValue({ error: "should not be called for non-2025" });
});

describe("loadFormsPageData (read-only assembler)", () => {
  it("never invokes the TY2025 engine for another year and performs no writes", async () => {
    const data = await loadFormsPageData(2026);
    expect(computeMocks.buildInput).not.toHaveBeenCalled();
    expect(computeMocks.computeReturn).not.toHaveBeenCalled();
    expect(data.draft).toEqual({ status: "not_computed" });
    expect(data.taxYear).toBe(2026);
  });

  it("works with no Personal workspace for the year (answers empty, flag false), without creating one", async () => {
    const data = await loadFormsPageData(2024);
    expect(data.personalWorkspaceExists).toBe(false);
    const f5695 = data.federal.find((e) => e.id === "form-5695");
    expect(f5695?.applicability).toBe("conditional");
  });

  it("reads planning answers from the existing Personal workspace", async () => {
    dbMocks.workspaceFindMany.mockResolvedValue([
      {
        id: "ws-personal",
        entityId: "e-personal",
        checklistItems: [],
        questions: [{ key: "solar_credit", answer: "yes_unclaimed", skippedReason: null }],
      },
    ]);
    const data = await loadFormsPageData(2026);
    expect(data.personalWorkspaceExists).toBe(true);
    expect(data.federal.find((e) => e.id === "form-5695")?.applicability).toBe("required");
  });

  it("TY2025 engine throwing degrades to 'unavailable', not an exception", async () => {
    computeMocks.buildInput.mockRejectedValue(new Error("boom"));
    const data = await loadFormsPageData(2025);
    expect(data.draft.status).toBe("unavailable");
    expect(data.federal.find((e) => e.id === "schedule-a")?.applicability).toBe("conditional");
  });

  it("TY2025 builder returning {error} degrades to 'unavailable'", async () => {
    computeMocks.buildInput.mockResolvedValue({ error: "no data" });
    const data = await loadFormsPageData(2025);
    expect(data.draft).toEqual({ status: "unavailable", reason: "no data" });
  });

  it("TY2025 success drives Schedule A and Schedule SE from the engine result", async () => {
    computeMocks.buildInput.mockResolvedValue({ input: {} });
    computeMocks.computeReturn.mockReturnValue({
      federal: { deductionMethod: "itemized", selfEmploymentTax: { totalSETax: { gt: () => true } } },
    });
    const data = await loadFormsPageData(2025);
    expect(data.draft.status).toBe("available");
    expect(data.federal.find((e) => e.id === "schedule-a")?.applicability).toBe("required");
    expect(data.federal.find((e) => e.id === "schedule-se")?.applicability).toBe("required");
  });

  it("a failing computePL does not break the page", async () => {
    computeMocks.computePL.mockRejectedValue(new Error("pl failed"));
    await expect(loadFormsPageData(2026)).resolves.toBeDefined();
  });

  it("only reads non-archived documents and selects only id+name for users", async () => {
    await loadFormsPageData(2025);
    const docArgs = dbMocks.documentFindMany.mock.calls[0]![0] as { where: { archivedAt: unknown } };
    expect(docArgs.where.archivedAt).toBeNull();
    const userArgs = dbMocks.userFindMany.mock.calls[0]![0] as { select: Record<string, boolean> };
    expect(Object.keys(userArgs.select).sort()).toEqual(["id", "name"]);
  });

  it("hands back plain data only (no Date/Decimal instances) so it is safe for any component", async () => {
    dbMocks.documentFindMany.mockResolvedValue([
      {
        id: "d1",
        docType: "w2",
        documentName: "W-2 Eric",
        entityId: "e-personal",
        taxYear: 2026,
        extractionStatus: "complete",
        extractionData: { summary: "ok", data: { employerName: "SEACOAST MUSHROOMS" } },
        archivedAt: null,
        subjectType: "person",
        issuerName: null,
        subjectUser: ERIC,
      },
    ]);
    const data = await loadFormsPageData(2026);
    expect(walkForNonPlain(data)).toEqual([]);
    const f1040 = data.federal.find((e) => e.id === "form-1040");
    expect(f1040?.inputs[0]?.personLabel).toBe("Eric");
    expect(f1040?.inputs[0]?.issuer).toBe("SEACOAST MUSHROOMS");
    expect(f1040?.inputs[0]?.issuerIsSuggestion).toBe(true);
  });

  it("production-shaped entities: Sudden Valley flagged for CPA in 2026, none in 2025; Mezzo only not-applicable", async () => {
    const y26 = await loadFormsPageData(2026);
    const e26 = y26.federal.find((e) => e.id === "schedule-e");
    expect(e26?.applicability).toBe("required");
    expect(e26?.confirmWithCpa).toBe(true);
    const y25 = await loadFormsPageData(2025);
    expect(y25.federal.find((e) => e.id === "schedule-e")?.applicability).toBe("not_applicable");
    const mezzo = y25.entities.find((s) => s.slug === "mezzo");
    expect(mezzo?.entries.every((e) => e.applicability === "not_applicable")).toBe(true);
    const sv25 = y25.entities.find((s) => s.slug === "sudden-valley");
    expect(sv25?.activeForYear).toBe(false);
  });

  it("no needs_cpa_input entry from the CPA list is ever 'required', across years and answer sets", async () => {
    for (const year of [2024, 2025, 2026]) {
      const data = await loadFormsPageData(year);
      for (const e of data.needsCpaInput) expect(e.applicability, `${year} ${e.id}`).not.toBe("required");
    }
  });
});
