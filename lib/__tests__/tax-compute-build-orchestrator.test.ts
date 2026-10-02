import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

// Pass 3: the DB-aware orchestrator buildPersonalTaxComputeInput must hand the
// pure resolvers EFFECTIVE extraction values (owner corrections overlaid) and
// provenance. Mocked at the db / entity / reports boundary; strictly read-only.

const mocks = vi.hoisted(() => ({
  documentFindMany: vi.fn(),
  paystubFindMany: vi.fn(),
  workspaceFindUnique: vi.fn(),
  questionFindMany: vi.fn(),
  mileageFindMany: vi.fn(),
  getEntityBySlug: vi.fn(),
  computePL: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    document: { findMany: mocks.documentFindMany },
    paystub: { findMany: mocks.paystubFindMany },
    taxWorkspace: { findUnique: mocks.workspaceFindUnique },
    taxQuestion: { findMany: mocks.questionFindMany },
    mileageEntry: { findMany: mocks.mileageFindMany },
  },
}));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: mocks.getEntityBySlug }));
vi.mock("@/lib/reports", () => ({ computePL: mocks.computePL }));

import { buildPersonalTaxComputeInput } from "@/lib/tax-compute-build";

const legacyW2 = {
  id: "w2-1",
  docType: "w2",
  taxYear: 2025,
  extractionStatus: "complete",
  extractionData: {
    docType: "w2",
    summary: "W-2",
    data: { employerName: "Acme", wagesCents: 10000000, federalWithheldCents: 1000000, stateWithheldCents: 300000, medicareWagesCents: 10000000 },
  },
  extractionCorrections: null,
  extractionConfirmedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEntityBySlug.mockImplementation(async (slug: string) => ({ id: `e-${slug}`, slug }));
  mocks.paystubFindMany.mockResolvedValue([]);
  mocks.workspaceFindUnique.mockResolvedValue(null);
  mocks.questionFindMany.mockResolvedValue([]);
  mocks.mileageFindMany.mockResolvedValue([]);
  mocks.computePL.mockResolvedValue({ totalIncome: new Decimal(0), totalExpenses: new Decimal(0) });
});

describe("buildPersonalTaxComputeInput (loader boundary)", () => {
  it("legacy-shaped documents give exactly the stored numbers, labelled unverified + older format", async () => {
    mocks.documentFindMany.mockResolvedValue([legacyW2]);
    const resolved = await buildPersonalTaxComputeInput(2025);
    if ("error" in resolved) throw new Error(resolved.error);
    expect(resolved.input.wages.toString()).toBe(new Decimal(10000000).div(100).toString());
    expect(resolved.input.federalWithholdingCents).toBe(1000000);
    expect(resolved.input.ctWithholdingCents).toBe(300000);
    const gaps = resolved.buildGaps.join("\n");
    expect(gaps).toContain("unverified AI extractions");
    expect(gaps).toContain("older extraction format");
  });

  it("an owner correction overrides the AI value that reaches the draft; a verified doc loses the unverified note", async () => {
    mocks.documentFindMany.mockResolvedValue([
      {
        ...legacyW2,
        extractionCorrections: {
          version: 1,
          fields: { wagesCents: { value: 11000000, aiValue: 10000000, correctedAt: "t", correctedById: "u" } },
          events: [],
        },
        extractionConfirmedAt: new Date("2026-10-02T00:00:00Z"),
      },
    ]);
    const resolved = await buildPersonalTaxComputeInput(2025);
    if ("error" in resolved) throw new Error(resolved.error);
    expect(resolved.input.wages.toString()).toBe(new Decimal(11000000).div(100).toString());
    expect(resolved.buildGaps.join("\n")).not.toContain("unverified AI extractions");
  });

  it("never writes: only read methods are mocked, and the personal documents query keeps the archivedAt guard", async () => {
    mocks.documentFindMany.mockResolvedValue([]);
    await buildPersonalTaxComputeInput(2025);
    const args = mocks.documentFindMany.mock.calls[0]![0] as { where: { archivedAt: unknown } };
    expect(args.where.archivedAt).toBeNull();
  });
});
