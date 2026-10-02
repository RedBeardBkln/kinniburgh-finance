import { describe, it, expect } from "vitest";
import { entitiesForYear, isEntityActiveForYear, type EntityYearInput } from "@/lib/tax-entities";

function ent(over: Partial<EntityYearInput> = {}): EntityYearInput {
  return { type: "business", foundedDate: null, taxStatusNotes: null, ...over };
}

describe("isEntityActiveForYear", () => {
  it("always includes the personal entity", () => {
    expect(isEntityActiveForYear(ent({ type: "personal" }), 1999)).toBe(true);
    expect(isEntityActiveForYear(ent({ type: "personal", foundedDate: new Date("2030-01-01") }), 2025)).toBe(true);
  });

  it("includes a business founded in or before the tax year (UTC year boundary)", () => {
    const founded = ent({ foundedDate: new Date("2026-02-01T00:00:00Z") });
    expect(isEntityActiveForYear(founded, 2025)).toBe(false);
    expect(isEntityActiveForYear(founded, 2026)).toBe(true);
    expect(isEntityActiveForYear(founded, 2027)).toBe(true);
  });

  it("treats Jan 1 UTC of the founding year as that year", () => {
    const jan1 = ent({ foundedDate: new Date("2026-01-01T00:00:00Z") });
    expect(isEntityActiveForYear(jan1, 2026)).toBe(true);
    const dec31 = ent({ foundedDate: new Date("2025-12-31T23:59:59Z") });
    expect(isEntityActiveForYear(dec31, 2025)).toBe(true);
    expect(isEntityActiveForYear(dec31, 2024)).toBe(false);
  });

  it("includes a business with no foundedDate by default", () => {
    expect(isEntityActiveForYear(ent(), 2025)).toBe(true);
    expect(isEntityActiveForYear(ent({ taxStatusNotes: "Single-member LLC, disregarded" }), 2020)).toBe(true);
  });

  it("excludes a business with no foundedDate whose notes say 'not yet formed' (case-insensitive)", () => {
    expect(isEntityActiveForYear(ent({ taxStatusNotes: "Not yet formed/registered as of June 2026." }), 2026)).toBe(false);
    expect(isEntityActiveForYear(ent({ taxStatusNotes: "NOT YET FORMED" }), 2026)).toBe(false);
  });

  it("foundedDate wins over the 'not yet formed' note", () => {
    const e = ent({ foundedDate: new Date("2020-05-01"), taxStatusNotes: "not yet formed" });
    expect(isEntityActiveForYear(e, 2025)).toBe(true);
  });
});

describe("entitiesForYear", () => {
  const personal = { name: "Personal", ...ent({ type: "personal" }) };
  const ekc = { name: "EKC", ...ent() };
  const sv = { name: "SV", ...ent({ foundedDate: new Date("2026-02-01") }) };
  const mezzo = { name: "Mezzo", ...ent({ taxStatusNotes: "Not yet formed" }) };

  it("matches the legacy /tax page behaviour for 2025 and 2026", () => {
    expect(entitiesForYear([personal, ekc, sv, mezzo], 2025).map((e) => e.name)).toEqual(["Personal", "EKC"]);
    expect(entitiesForYear([personal, ekc, sv, mezzo], 2026).map((e) => e.name)).toEqual(["Personal", "EKC", "SV"]);
  });

  it("preserves the extra properties of the input entities", () => {
    const [first] = entitiesForYear([personal], 2025);
    expect(first?.name).toBe("Personal");
  });
});
