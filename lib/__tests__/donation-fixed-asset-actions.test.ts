import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Mocks at the db/auth boundary (repo convention: no integrated DB tests).
const authMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockDb = vi.hoisted(() => ({
  entity: { findFirst: vi.fn() },
  document: { findFirst: vi.fn() },
  donation: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  fixedAsset: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
  auditLog: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { createDonation, updateDonation, archiveDonation } from "@/actions/donations";
import { createFixedAsset, updateFixedAsset, archiveFixedAsset } from "@/actions/fixed-assets";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL = "22222222-2222-4222-8222-222222222222";
const BUSINESS = "33333333-3333-4333-8333-333333333333";
const DOC = "44444444-4444-4444-8444-444444444444";
const ROW = "55555555-5555-4555-8555-555555555555";

const donationInput = {
  date: "2025-06-15",
  recipient: "Food Bank",
  amount: "250.00",
  kind: "cash" as const,
  substantiation: "written_acknowledgment" as const,
  notes: "private note",
};
const assetInput = {
  entityId: BUSINESS,
  description: "Laptop",
  placedInServiceDate: "2025-03-01",
  costBasis: "2400.00",
  isRealProperty: false,
  businessUsePercent: 100,
  notes: "private note",
};

const donationRow = {
  id: ROW,
  entityId: PERSONAL,
  date: new Date("2025-06-15T12:00:00Z"),
  recipient: "Food Bank",
  amountCents: 25000,
  kind: "cash",
  substantiation: "written_acknowledgment",
  receiptDocumentId: null,
  notes: "private note",
};
const assetRow = {
  id: ROW,
  entityId: BUSINESS,
  description: "Laptop",
  placedInServiceDate: new Date("2025-03-01T12:00:00Z"),
  costBasisCents: 240000,
  isRealProperty: false,
  landValueCents: null,
  businessUsePercent: 100,
  invoiceDocumentId: null,
  notes: "private note",
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: USER } });
  mockDb.entity.findFirst.mockResolvedValue({ id: PERSONAL });
  mockDb.document.findFirst.mockResolvedValue({ id: DOC });
  mockDb.donation.create.mockResolvedValue(donationRow);
  mockDb.donation.findFirst.mockResolvedValue(donationRow);
  mockDb.donation.findMany.mockResolvedValue([]);
  mockDb.donation.update.mockResolvedValue(donationRow);
  mockDb.fixedAsset.create.mockResolvedValue(assetRow);
  mockDb.fixedAsset.findFirst.mockResolvedValue(assetRow);
  mockDb.fixedAsset.update.mockResolvedValue(assetRow);
  mockDb.auditLog.create.mockResolvedValue({});
});

describe("auth gate", () => {
  it("every exported action rejects an unauthenticated caller before touching the db", async () => {
    authMock.mockResolvedValue(null);
    await expect(createDonation(donationInput)).rejects.toThrow("Unauthorized");
    await expect(updateDonation(ROW, donationInput)).rejects.toThrow("Unauthorized");
    await expect(archiveDonation(ROW)).rejects.toThrow("Unauthorized");
    await expect(createFixedAsset(assetInput)).rejects.toThrow("Unauthorized");
    await expect(updateFixedAsset(ROW, assetInput)).rejects.toThrow("Unauthorized");
    await expect(archiveFixedAsset(ROW)).rejects.toThrow("Unauthorized");
    expect(mockDb.entity.findFirst).not.toHaveBeenCalled();
    expect(mockDb.donation.create).not.toHaveBeenCalled();
    expect(mockDb.fixedAsset.create).not.toHaveBeenCalled();
  });

  it("source check: every exported function starts with `await requireAuth()` (incl. clearTaxQuestionAnswerByKey)", () => {
    for (const file of ["actions/donations.ts", "actions/fixed-assets.ts", "actions/tax-planning.ts"]) {
      const src = readFileSync(resolve(__dirname, "../../", file), "utf8").replace(/\r\n/g, "\n");
      const names =
        file === "actions/tax-planning.ts"
          ? ["clearTaxQuestionAnswerByKey"]
          : [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
      expect(names.length, file).toBeGreaterThan(0);
      for (const name of names) {
        const start = src.indexOf(`export async function ${name}`);
        const body = src.slice(src.indexOf("{\n", start) + 2, src.indexOf("{\n", start) + 120);
        expect(body.trimStart().startsWith("const user = await requireAuth();") || body.trimStart().startsWith("await requireAuth();"), `${file} ${name}`).toBe(true);
      }
    }
  });

  it("source check: no hard delete of the new tax tables and no `any`", () => {
    for (const file of ["actions/donations.ts", "actions/fixed-assets.ts"]) {
      const src = readFileSync(resolve(__dirname, "../../", file), "utf8");
      expect(src, file).not.toMatch(/\.delete\(|\.deleteMany\(/);
      expect(src, file).not.toMatch(/:\s*any\b|as any\b/);
    }
  });

  it("source check: clearTaxQuestionAnswerByKey is allow-listed to the three none-confirmation keys", () => {
    const src = readFileSync(resolve(__dirname, "../../actions/tax-planning.ts"), "utf8");
    expect(src).toMatch(/NONE_CONFIRMATION_KEY_LIST\.includes\(key\)/);
  });
});

describe("donation actions", () => {
  it("files under the server-resolved Personal entity, stores cents, records createdById", async () => {
    const res = await createDonation(donationInput);
    expect(res).toEqual({ ok: true, id: ROW });
    expect(mockDb.entity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { type: "personal", archivedAt: null } })
    );
    const data = mockDb.donation.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.entityId).toBe(PERSONAL);
    expect(data.amountCents).toBe(25000);
    expect(data.createdById).toBe(USER);
    expect((data.date as Date).toISOString()).toBe("2025-06-15T12:00:00.000Z");
  });

  it("writes an audit row without the free-text notes or recipient", async () => {
    await createDonation(donationInput);
    const audit = mockDb.auditLog.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(audit.changeType).toBe("donation_create");
    expect(audit.changedBy).toBe(USER);
    expect(JSON.stringify(audit)).not.toContain("private note");
    expect(JSON.stringify(audit)).not.toContain("Food Bank");
  });

  it("rejects invalid input without writing, and a receipt not filed under Personal", async () => {
    expect(await createDonation({ ...donationInput, amount: "12.345" })).toEqual({ ok: false, error: expect.any(String) });
    expect(mockDb.donation.create).not.toHaveBeenCalled();

    mockDb.document.findFirst.mockResolvedValue(null);
    const res = await createDonation({ ...donationInput, receiptDocumentId: DOC });
    expect(res.ok).toBe(false);
    expect(mockDb.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DOC, archivedAt: null, entityId: PERSONAL } })
    );
    expect(mockDb.donation.create).not.toHaveBeenCalled();
  });

  it("update/archive guard on archivedAt: null and report 'not found' otherwise", async () => {
    mockDb.donation.findFirst.mockResolvedValue(null);
    expect(await updateDonation(ROW, donationInput)).toEqual({ ok: false, error: "Donation not found" });
    expect(await archiveDonation(ROW)).toEqual({ ok: false, error: "Donation not found" });
    expect(mockDb.donation.findFirst).toHaveBeenCalledWith({ where: { id: ROW, archivedAt: null } });
    expect(mockDb.donation.update).not.toHaveBeenCalled();
  });

  it("archive sets archivedAt (soft delete) and audits it", async () => {
    expect(await archiveDonation(ROW)).toEqual({ ok: true, id: ROW });
    const upd = mockDb.donation.update.mock.calls[0]![0] as { data: { archivedAt: Date } };
    expect(upd.data.archivedAt).toBeInstanceOf(Date);
    expect(mockDb.donation.delete).not.toHaveBeenCalled();
    expect(mockDb.auditLog.create.mock.calls[0]![0].data.changeType).toBe("donation_archive");
  });
});

describe("fixed-asset actions", () => {
  it("accepts only a non-archived BUSINESS entity (Personal / unknown ids are rejected)", async () => {
    mockDb.entity.findFirst.mockResolvedValue(null);
    const res = await createFixedAsset(assetInput);
    expect(res.ok).toBe(false);
    expect(mockDb.entity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: BUSINESS, archivedAt: null, type: "business" } })
    );
    expect(mockDb.fixedAsset.create).not.toHaveBeenCalled();
  });

  it("creates with cents, forced-null land for non-real-property, and an audit row without notes", async () => {
    mockDb.entity.findFirst.mockResolvedValue({ id: BUSINESS });
    const res = await createFixedAsset({ ...assetInput, landValue: "999" });
    expect(res).toEqual({ ok: true, id: ROW });
    const data = mockDb.fixedAsset.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.costBasisCents).toBe(240000);
    expect(data.landValueCents).toBeNull();
    expect(data.createdById).toBe(USER);
    const audit = mockDb.auditLog.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(audit.changeType).toBe("fixed_asset_create");
    expect(JSON.stringify(audit)).not.toContain("private note");
    expect(JSON.stringify(audit)).not.toContain("Laptop");
  });

  it("requires a land value for real property and rejects land above cost", async () => {
    mockDb.entity.findFirst.mockResolvedValue({ id: BUSINESS });
    expect((await createFixedAsset({ ...assetInput, isRealProperty: true })).ok).toBe(false);
    expect((await createFixedAsset({ ...assetInput, isRealProperty: true, landValue: "2400.01" })).ok).toBe(false);
    expect(mockDb.fixedAsset.create).not.toHaveBeenCalled();
  });

  it("an invoice must be a non-archived document of the SAME entity", async () => {
    mockDb.entity.findFirst.mockResolvedValue({ id: BUSINESS });
    mockDb.document.findFirst.mockResolvedValue(null);
    const res = await createFixedAsset({ ...assetInput, invoiceDocumentId: DOC });
    expect(res.ok).toBe(false);
    expect(mockDb.document.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DOC, archivedAt: null, entityId: BUSINESS } })
    );
  });

  it("update cannot move the entity and archive is a soft delete", async () => {
    const { entityId: _entityId, ...patch } = assetInput;
    void _entityId;
    expect(await updateFixedAsset(ROW, patch)).toEqual({ ok: true, id: ROW });
    const data = mockDb.fixedAsset.update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("entityId");

    mockDb.fixedAsset.update.mockClear();
    expect(await archiveFixedAsset(ROW)).toEqual({ ok: true, id: ROW });
    const upd = mockDb.fixedAsset.update.mock.calls[0]![0] as { data: { archivedAt: Date } };
    expect(upd.data.archivedAt).toBeInstanceOf(Date);
    expect(mockDb.fixedAsset.delete).not.toHaveBeenCalled();
  });
});
