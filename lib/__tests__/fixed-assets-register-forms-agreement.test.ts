import { describe, it, expect } from "vitest";
import {
  countBuildingAssetsForYear,
  countEkcAssetsForYear,
  entriesSatisfyFormsLine,
  uncountedEntriesNote,
  type AssetCountInput,
} from "@/lib/fixed-assets";
import { computePersonalFormPlan, type PersonalFormPlanInput } from "@/lib/tax-form-plan";

// Round 2 (B1) agreement test: the fixed-asset register page's "entries satisfy the
// line" boolean must equal the REAL Forms-page predicate for the same asset set.
// The Forms page is fed the exact way lib/tax-forms-build.ts feeds it (the two
// counters); the register page uses entriesSatisfyFormsLine. Both are driven through
// computePersonalFormPlan so a change to the real predicate breaks this test.

const EKC = "ekc-id";
const SV = "sv-id";

const EMPTY: PersonalFormPlanInput = {
  documents: [],
  questions: [],
  ekConsultingPL: null,
  suddenValleyPL: null,
  ekConsultingMileageCount: 0,
  solarLoanOriginalCostCents: null,
  donationCount: 0,
  ekConsultingFixedAssetCount: 0,
  suddenValleyBuildingAssetCount: 0,
};

function formsLine(assets: AssetCountInput[], taxYear: number, line: "Depreciation (line 13)" | "Depreciation (line 18)") {
  const plan = computePersonalFormPlan({
    ...EMPTY,
    ekConsultingFixedAssetCount: countEkcAssetsForYear(assets, EKC, taxYear),
    suddenValleyBuildingAssetCount: countBuildingAssetsForYear(assets, SV, taxYear),
  });
  const field = plan.flatMap((f) => f.fields).find((f) => f.line === line);
  if (!field) throw new Error(`line not found: ${line}`);
  return field.haveData;
}

function asset(
  entityId: string,
  placed: string,
  isRealProperty: boolean,
  landValueCents: number | null
): AssetCountInput {
  return { entityId, placedInServiceDate: new Date(`${placed}T12:00:00Z`), isRealProperty, landValueCents };
}

const DATES = ["2019-06-01", "2024-12-31", "2025-01-01", "2025-12-31", "2026-01-01", "2026-06-15"];
const YEARS = [2024, 2025, 2026];

describe("register banner agrees with the Forms-page predicate (no questions answered)", () => {
  it("EKC: every date x year x property-type combination", () => {
    for (const d of DATES) {
      for (const real of [false, true]) {
        for (const land of [null, 0, 500000]) {
          for (const y of YEARS) {
            const assets = [asset(EKC, d, real, land)];
            expect(entriesSatisfyFormsLine(assets, EKC, false, y), `${d} real=${real} land=${land} y=${y}`).toBe(
              formsLine(assets, y, "Depreciation (line 13)")
            );
          }
        }
      }
    }
  });

  it("Sudden Valley: every date x year x property-type x land combination", () => {
    for (const d of DATES) {
      for (const real of [false, true]) {
        for (const land of [null, 0, 500000]) {
          for (const y of YEARS) {
            const assets = [asset(SV, d, real, land)];
            expect(entriesSatisfyFormsLine(assets, SV, true, y), `${d} real=${real} land=${land} y=${y}`).toBe(
              formsLine(assets, y, "Depreciation (line 18)")
            );
          }
        }
      }
    }
  });

  it("mixed multi-asset sets across both entities agree per line", () => {
    const sets: AssetCountInput[][] = [
      [],
      [asset(SV, "2025-03-01", false, null), asset(EKC, "2026-02-01", false, null)],
      [asset(SV, "2025-03-01", true, null), asset(SV, "2026-03-01", true, 100)],
      [asset(EKC, "2025-03-01", true, 100), asset(SV, "2025-03-01", true, 0)],
      [asset(SV, "2024-03-01", false, null), asset(SV, "2024-03-01", true, null), asset(EKC, "2030-01-01", false, null)],
    ];
    for (const assets of sets) {
      for (const y of YEARS) {
        expect(entriesSatisfyFormsLine(assets, EKC, false, y)).toBe(formsLine(assets, y, "Depreciation (line 13)"));
        expect(entriesSatisfyFormsLine(assets, SV, true, y)).toBe(formsLine(assets, y, "Depreciation (line 18)"));
      }
    }
  });

  it("an entity's assets never satisfy the other entity's line", () => {
    const evAssets = [asset(EKC, "2025-01-01", true, 100)];
    expect(entriesSatisfyFormsLine(evAssets, SV, true, 2025)).toBe(false);
    expect(formsLine(evAssets, 2025, "Depreciation (line 18)")).toBe(false);
    const svAssets = [asset(SV, "2025-01-01", true, 100)];
    expect(entriesSatisfyFormsLine(svAssets, EKC, false, 2025)).toBe(false);
    expect(formsLine(svAssets, 2025, "Depreciation (line 13)")).toBe(false);
  });
});

describe("uncountedEntriesNote is shown only where rows exist and the line is unsatisfied, and never claims done", () => {
  it("note text never claims the line is done / confirmed, and names the right line and year", () => {
    for (const sv of [true, false]) {
      const n = uncountedEntriesNote(sv, 2025);
      expect(n).not.toMatch(/treats this line as done|is done|complete|satisfied/i);
      expect(n).toContain("2025");
      expect(n).toContain(sv ? "line 18" : "line 13");
      expect(n).toContain("stays open");
    }
  });
});
