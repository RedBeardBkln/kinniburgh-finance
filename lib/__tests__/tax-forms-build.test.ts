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
  donationCount: vi.fn(),
  fixedAssetFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    entity: dbMocks.readOnlyModel({ findMany: dbMocks.entityFindMany }),
    user: dbMocks.readOnlyModel({ findMany: dbMocks.userFindMany }),
    document: dbMocks.readOnlyModel({ findMany: dbMocks.documentFindMany }),
    taxWorkspace: dbMocks.readOnlyModel({ findMany: dbMocks.workspaceFindMany }),
    mileageEntry: dbMocks.readOnlyModel({ count: dbMocks.mileageCount }),
    account: dbMocks.readOnlyModel({ findUnique: dbMocks.accountFindUnique }),
    donation: dbMocks.readOnlyModel({ count: dbMocks.donationCount }),
    fixedAsset: dbMocks.readOnlyModel({ findMany: dbMocks.fixedAssetFindMany }),
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
  dbMocks.donationCount.mockResolvedValue(0);
  dbMocks.fixedAssetFindMany.mockResolvedValue([]);
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

  it("reads effective values (owner corrections) + verification, and selects only the extraction columns it needs", async () => {
    const row = (over: Record<string, unknown>) => ({
      id: "w2-1",
      docType: "w2",
      documentName: "W-2",
      entityId: "e-personal",
      taxYear: 2026,
      extractionStatus: "complete",
      extractionData: { schemaVersion: 2, summary: "", data: { employerName: "Acme", wagesCents: 1000000, federalWithheldCents: null } },
      extractionCorrections: null,
      extractionConfirmedAt: null,
      extractionError: null,
      updatedAt: new Date("2026-10-01T00:00:00Z"),
      archivedAt: null,
      subjectType: null,
      issuerName: null,
      subjectUser: null,
      ...over,
    });
    // The AI read no federal withholding; the owner entered it and confirmed.
    dbMocks.documentFindMany.mockResolvedValue([
      row({
        extractionCorrections: { version: 1, fields: { federalWithheldCents: { value: 200000, aiValue: null } }, events: [] },
        extractionConfirmedAt: new Date("2026-10-02T00:00:00Z"),
      }),
    ]);
    const verified = await loadFormsPageData(2026);
    const withholding = verified.federal
      .find((e) => e.id === "form-1040")
      ?.fields.find((f) => f.line === "Payments/withholding (line 25)");
    expect(withholding?.haveData).toBe(true); // only the owner's correction supplies it
    expect(withholding?.basis).toBe("verified");
    const ref = verified.federal.find((e) => e.id === "form-1040")?.inputs[0];
    expect(ref?.verified).toBe(true);
    expect(ref?.extraction?.kind).toBe("verified");
    expect(ref?.reviewHref).toBe("/documents/w2-1/review");

    // Same correction but not confirmed -> used (verified-else-AI) and labelled unverified.
    dbMocks.documentFindMany.mockResolvedValue([
      row({ extractionCorrections: { version: 1, fields: { federalWithheldCents: { value: 200000, aiValue: null } }, events: [] } }),
    ]);
    const unverified = await loadFormsPageData(2026);
    const w2 = unverified.federal
      .find((e) => e.id === "form-1040")
      ?.fields.find((f) => f.line === "Payments/withholding (line 25)");
    expect(w2?.haveData).toBe(true);
    expect(w2?.basis).toBe("unverified");
    expect(unverified.extractionBasis.unverified).toBe(1);

    // The query asks for the extraction columns the loader needs (read-only select).
    const args = dbMocks.documentFindMany.mock.calls[0]![0] as { select: Record<string, unknown> };
    for (const col of ["extractionCorrections", "extractionConfirmedAt", "extractionError", "updatedAt"]) {
      expect(args.select[col], col).toBe(true);
    }
  });

  it("donation log and fixed-asset register feed the three previously-unfillable lines (read-only, archived excluded)", async () => {
    const lineOf = (data: Awaited<ReturnType<typeof loadFormsPageData>>, formId: string, line: string) =>
      data.federal.find((e) => e.id === formId)?.fields.find((f) => f.line === line);

    // Nothing recorded: all three missing.
    const none = await loadFormsPageData(2026);
    expect(lineOf(none, "schedule-a", "Gifts to charity (line 11)")?.haveData).toBe(false);
    expect(lineOf(none, "schedule-c", "Depreciation (line 13)")?.haveData).toBe(false);
    expect(lineOf(none, "schedule-e", "Depreciation (line 18)")?.haveData).toBe(false);

    dbMocks.donationCount.mockResolvedValue(2);
    dbMocks.fixedAssetFindMany.mockResolvedValue([
      // EKC equipment placed in service in 2025 counts for 2026; a 2027 asset does not.
      { entityId: "e-ekc", placedInServiceDate: new Date("2025-03-01T12:00:00Z"), isRealProperty: false, landValueCents: null },
      { entityId: "e-ekc", placedInServiceDate: new Date("2027-01-01T12:00:00Z"), isRealProperty: false, landValueCents: null },
      // SV real property with a land split counts for line 18; SV equipment alone would not.
      { entityId: "e-sv", placedInServiceDate: new Date("2026-02-10T12:00:00Z"), isRealProperty: true, landValueCents: 6_000_000 },
    ]);
    const have = await loadFormsPageData(2026);
    expect(lineOf(have, "schedule-a", "Gifts to charity (line 11)")?.haveData).toBe(true);
    expect(lineOf(have, "schedule-c", "Depreciation (line 13)")?.haveData).toBe(true);
    expect(lineOf(have, "schedule-e", "Depreciation (line 18)")?.haveData).toBe(true);

    // SV equipment-only leaves line 18 missing.
    dbMocks.fixedAssetFindMany.mockResolvedValue([
      { entityId: "e-sv", placedInServiceDate: new Date("2026-02-10T12:00:00Z"), isRealProperty: false, landValueCents: null },
    ]);
    const equipOnly = await loadFormsPageData(2026);
    expect(lineOf(equipOnly, "schedule-e", "Depreciation (line 18)")?.haveData).toBe(false);

    // Queries exclude archived rows; the donation window is half-open [Jan 1, next Jan 1).
    const donationArgs = dbMocks.donationCount.mock.calls[0]![0] as {
      where: { entityId: string; archivedAt: unknown; date: { gte: Date; lt: Date } };
    };
    expect(donationArgs.where.entityId).toBe("e-personal");
    expect(donationArgs.where.archivedAt).toBeNull();
    expect(donationArgs.where.date.gte.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(donationArgs.where.date.lt.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    const assetArgs = dbMocks.fixedAssetFindMany.mock.calls[0]![0] as { where: { archivedAt: unknown; entityId: { in: string[] } } };
    expect(assetArgs.where.archivedAt).toBeNull();
    expect(assetArgs.where.entityId.in.sort()).toEqual(["e-ekc", "e-sv"]);
  });

  it("a confirmed 'none' answer satisfies the lines without any rows", async () => {
    dbMocks.workspaceFindMany.mockResolvedValue([
      {
        id: "ws-personal",
        entityId: "e-personal",
        checklistItems: [],
        questions: [
          { key: "donations_none", answer: "none", skippedReason: null },
          { key: "fixed_assets_ekc", answer: "none", skippedReason: null },
          { key: "fixed_assets_sv", answer: "some", skippedReason: null },
        ],
      },
    ]);
    const data = await loadFormsPageData(2026);
    const lineOf = (formId: string, line: string) =>
      data.federal.find((e) => e.id === formId)?.fields.find((f) => f.line === line);
    expect(lineOf("schedule-a", "Gifts to charity (line 11)")?.haveData).toBe(true);
    expect(lineOf("schedule-c", "Depreciation (line 13)")?.haveData).toBe(true);
    expect(lineOf("schedule-e", "Depreciation (line 18)")?.haveData).toBe(false); // "some" is not a confirmation
  });

  it("production-shaped entities: Sudden Valley flagged for CPA in 2026, none in 2025; Mezzo only not-applicable", async () => {
    const y26 = await loadFormsPageData(2026);
    const e26 = y26.federal.find((e) => e.id === "schedule-e");
    expect(e26?.applicability).toBe("required");
    expect(e26?.confirmWithCpa).toBe(true);
    const y25 = await loadFormsPageData(2025);
    // Sudden Valley does not exist in 2025: no Schedule E card and no entity block at all.
    expect(y25.federal.find((e) => e.id === "schedule-e")).toBeUndefined();
    const mezzo = y25.entities.find((s) => s.slug === "mezzo");
    expect(mezzo?.entries.every((e) => e.applicability === "not_applicable")).toBe(true);
    expect(y25.entities.find((s) => s.slug === "sudden-valley")).toBeUndefined();
  });

  it("no needs_cpa_input entry from the CPA list is ever 'required', across years and answer sets", async () => {
    for (const year of [2024, 2025, 2026]) {
      const data = await loadFormsPageData(year);
      for (const e of data.needsCpaInput) expect(e.applicability, `${year} ${e.id}`).not.toBe("required");
    }
  });
});
