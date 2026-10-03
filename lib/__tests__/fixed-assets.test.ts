import { describe, it, expect } from "vitest";
import {
  normalizeFixedAssetInput,
  assetCountsForYear,
  countEkcAssetsForYear,
  countBuildingAssetsForYear,
  entriesSatisfyFormsLine,
  uncountedEntriesNote,
  type AssetCountInput,
} from "@/lib/fixed-assets";

const base = {
  description: "  Laptop  ",
  placedInServiceDate: "2025-03-01",
  costBasis: "2,400.00",
  isRealProperty: false,
  businessUsePercent: 100,
};

describe("normalizeFixedAssetInput", () => {
  it("normalizes a non-real-property asset and forces land to null", () => {
    const r = normalizeFixedAssetInput({ ...base, landValue: "5000" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.description).toBe("Laptop");
      expect(r.value.costBasisCents).toBe(240000);
      expect(r.value.landValueCents).toBeNull();
      expect(r.value.placedInServiceDate.toISOString()).toBe("2025-03-01T12:00:00.000Z");
      expect(r.value.businessUsePercent).toBe(100);
      expect(r.value.invoiceDocumentId).toBeNull();
      expect(r.value.notes).toBeNull();
    }
  });

  it("requires a land value for real property", () => {
    expect(normalizeFixedAssetInput({ ...base, isRealProperty: true }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, isRealProperty: true, landValue: "" }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, isRealProperty: true, landValue: null }).ok).toBe(false);
  });

  it("rejects land above cost, accepts land equal to cost and land of zero", () => {
    const real = { ...base, isRealProperty: true };
    const over = normalizeFixedAssetInput({ ...real, landValue: "2,400.01" });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toBe("Land value cannot exceed the cost basis");

    const equal = normalizeFixedAssetInput({ ...real, landValue: "2400" });
    expect(equal.ok).toBe(true);
    if (equal.ok) expect(equal.value.landValueCents).toBe(240000);

    const zero = normalizeFixedAssetInput({ ...real, landValue: "0" });
    expect(zero.ok).toBe(true);
    if (zero.ok) expect(zero.value.landValueCents).toBe(0);
  });

  it("validates business use 1..100 as a whole number", () => {
    expect(normalizeFixedAssetInput({ ...base, businessUsePercent: 0 }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, businessUsePercent: 101 }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, businessUsePercent: 37.5 }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, businessUsePercent: 1 }).ok).toBe(true);
    expect(normalizeFixedAssetInput({ ...base, businessUsePercent: 100 }).ok).toBe(true);
    expect(normalizeFixedAssetInput({ ...base, businessUsePercent: "50" }).ok).toBe(false);
  });

  it("rejects cost 0, bad cost, bad date, empty description, bad invoice uuid", () => {
    expect(normalizeFixedAssetInput({ ...base, costBasis: "0" }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, costBasis: "12.345" }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, placedInServiceDate: "2025-02-30" }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, description: "  " }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, invoiceDocumentId: "nope" }).ok).toBe(false);
    expect(normalizeFixedAssetInput(undefined).ok).toBe(false);
  });
});

describe("assetCountsForYear", () => {
  it("includes the placed-in-service year and earlier years", () => {
    expect(assetCountsForYear(new Date("2025-12-31T12:00:00Z"), 2025)).toBe(true);
    expect(assetCountsForYear(new Date("2021-06-01T12:00:00Z"), 2025)).toBe(true);
  });

  it("excludes an asset placed in service the next January 1", () => {
    expect(assetCountsForYear(new Date("2026-01-01T12:00:00Z"), 2025)).toBe(false);
  });
});

describe("countEkcAssetsForYear / countBuildingAssetsForYear", () => {
  const EKC = "ekc-id";
  const SV = "sv-id";
  const a = (over: Partial<AssetCountInput>): AssetCountInput => ({
    entityId: EKC,
    placedInServiceDate: new Date("2025-03-01T12:00:00Z"),
    isRealProperty: false,
    landValueCents: null,
    ...over,
  });

  it("counts EKC assets in or before the year, ignoring other entities and later assets", () => {
    const assets = [
      a({}),
      a({ placedInServiceDate: new Date("2020-01-01T12:00:00Z") }),
      a({ placedInServiceDate: new Date("2026-01-01T12:00:00Z") }),
      a({ entityId: SV }),
    ];
    expect(countEkcAssetsForYear(assets, EKC, 2025)).toBe(2);
    expect(countEkcAssetsForYear(assets, null, 2025)).toBe(0);
  });

  it("counts only Sudden Valley real property with a land split", () => {
    const assets = [
      a({ entityId: SV, isRealProperty: true, landValueCents: 5_000_000 }),
      a({ entityId: SV, isRealProperty: true, landValueCents: 0 }),
      a({ entityId: SV, isRealProperty: true, landValueCents: null }),
      a({ entityId: SV, isRealProperty: false }),
      a({ entityId: SV, isRealProperty: true, landValueCents: 1, placedInServiceDate: new Date("2026-01-01T12:00:00Z") }),
      a({ entityId: EKC, isRealProperty: true, landValueCents: 1 }),
    ];
    expect(countBuildingAssetsForYear(assets, SV, 2025)).toBe(2);
    expect(countBuildingAssetsForYear(assets, SV, 2026)).toBe(3);
    expect(countBuildingAssetsForYear(assets, null, 2025)).toBe(0);
  });
});

describe("entriesSatisfyFormsLine / uncountedEntriesNote (register banner honesty)", () => {
  const EKC = "ekc-id";
  const SV = "sv-id";
  const a = (over: Partial<AssetCountInput>): AssetCountInput => ({
    entityId: SV,
    placedInServiceDate: new Date("2025-03-01T12:00:00Z"),
    isRealProperty: false,
    landValueCents: null,
    ...over,
  });

  it("Sudden Valley: equipment-only and real property without a land value do not satisfy line 18", () => {
    expect(entriesSatisfyFormsLine([a({})], SV, true, 2025)).toBe(false);
    expect(entriesSatisfyFormsLine([a({ isRealProperty: true, landValueCents: null })], SV, true, 2025)).toBe(false);
  });

  it("Sudden Valley: a building placed in service after the viewed year does not satisfy it", () => {
    const later = a({ isRealProperty: true, landValueCents: 100, placedInServiceDate: new Date("2026-01-01T12:00:00Z") });
    expect(entriesSatisfyFormsLine([later], SV, true, 2025)).toBe(false);
    expect(entriesSatisfyFormsLine([later], SV, true, 2026)).toBe(true);
  });

  it("Sudden Valley: a building with land value 0 placed in the year satisfies it", () => {
    expect(entriesSatisfyFormsLine([a({ isRealProperty: true, landValueCents: 0 })], SV, true, 2025)).toBe(true);
  });

  it("EK Consulting: an asset placed in the year (or earlier) satisfies line 13; one placed after does not", () => {
    const e = (over: Partial<AssetCountInput>) => a({ entityId: EKC, ...over });
    expect(entriesSatisfyFormsLine([e({})], EKC, false, 2025)).toBe(true);
    expect(
      entriesSatisfyFormsLine([e({ placedInServiceDate: new Date("2026-06-01T12:00:00Z") })], EKC, false, 2025)
    ).toBe(false);
    expect(entriesSatisfyFormsLine([], EKC, false, 2025)).toBe(false);
  });

  it("the neutral note never says the line is done", () => {
    expect(uncountedEntriesNote(true, 2025)).toContain("line 18 stays open");
    expect(uncountedEntriesNote(false, 2025)).toContain("line 13 stays open");
    expect(uncountedEntriesNote(true, 2025)).not.toMatch(/treats this line as done/);
  });
});
