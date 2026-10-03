// Pure fixed-asset-register validation and counting helpers. No DB, no "use
// server". The register RECORDS the inputs a CPA needs for Form 4562 /
// Schedule C line 13 / Schedule E line 18. It never computes depreciation,
// picks a MACRS class, or decides Section 179 / bonus depreciation, and it never
// shows a building-basis (cost minus land) figure.

import { z } from "zod";
import { parseDollarsToCents } from "@/lib/money-input";
import { parseIsoDateNoonUtc } from "@/lib/tax-log-dates";

/** Raw input as typed by the owner: money/date fields are STRINGS. */
export const fixedAssetInputSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1, "Description is required")
    .max(200, "Description is too long (200 characters max)"),
  placedInServiceDate: z.string(),
  costBasis: z.string(),
  isRealProperty: z.boolean(),
  landValue: z.string().nullable().optional(),
  businessUsePercent: z
    .number({ invalid_type_error: "Business use must be a whole number from 1 to 100" })
    .int("Business use must be a whole number from 1 to 100")
    .min(1, "Business use must be a whole number from 1 to 100")
    .max(100, "Business use must be a whole number from 1 to 100"),
  invoiceDocumentId: z.string().uuid("Invalid invoice document").nullable().optional(),
  notes: z.string().trim().max(2000, "Notes are too long (2000 characters max)").nullable().optional(),
});

export type FixedAssetInput = z.input<typeof fixedAssetInputSchema>;

export interface NormalizedFixedAsset {
  description: string;
  placedInServiceDate: Date;
  costBasisCents: number;
  isRealProperty: boolean;
  /** Non-null exactly when isRealProperty. */
  landValueCents: number | null;
  businessUsePercent: number;
  invoiceDocumentId: string | null;
  notes: string | null;
}

export type NormalizeFixedAssetResult = { ok: true; value: NormalizedFixedAsset } | { ok: false; error: string };

export function normalizeFixedAssetInput(raw: unknown): NormalizeFixedAssetResult {
  const parsed = fixedAssetInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  const v = parsed.data;

  const placed = parseIsoDateNoonUtc(v.placedInServiceDate);
  if (!placed) return { ok: false, error: "Enter a valid placed-in-service date (YYYY-MM-DD, 2000-2100)" };

  const cost = parseDollarsToCents(v.costBasis);
  if (!cost.ok) return { ok: false, error: `Cost basis: ${cost.error}` };

  let landValueCents: number | null = null;
  if (v.isRealProperty) {
    if (v.landValue == null || v.landValue.trim() === "") {
      return { ok: false, error: "Land value is required for real property (enter 0 only if your CPA says none of the cost is land)" };
    }
    const land = parseDollarsToCents(v.landValue, { allowZero: true });
    if (!land.ok) return { ok: false, error: `Land value: ${land.error}` };
    if (land.cents > cost.cents) return { ok: false, error: "Land value cannot exceed the cost basis" };
    landValueCents = land.cents;
  }

  return {
    ok: true,
    value: {
      description: v.description,
      placedInServiceDate: placed,
      costBasisCents: cost.cents,
      isRealProperty: v.isRealProperty,
      landValueCents,
      businessUsePercent: v.businessUsePercent,
      invoiceDocumentId: v.invoiceDocumentId ?? null,
      notes: v.notes && v.notes !== "" ? v.notes : null,
    },
  };
}

// ── Year inclusion / counting (used by the Forms-page loader) ────────────────

/** An asset placed in service in the tax year or any earlier year still matters for that year. */
export function assetCountsForYear(placedInServiceDate: Date, taxYear: number): boolean {
  return placedInServiceDate.getUTCFullYear() <= taxYear;
}

export interface AssetCountInput {
  entityId: string;
  placedInServiceDate: Date;
  isRealProperty: boolean;
  landValueCents: number | null;
}

/** Non-archived assets (caller filters archivedAt) of one entity that count for the year. */
export function countEkcAssetsForYear(
  assets: readonly AssetCountInput[],
  ekcEntityId: string | null,
  taxYear: number
): number {
  if (!ekcEntityId) return 0;
  return assets.filter((a) => a.entityId === ekcEntityId && assetCountsForYear(a.placedInServiceDate, taxYear)).length;
}

/**
 * Sudden Valley assets that satisfy Schedule E line 18: real property with a
 * recorded land split, placed in service in or before the tax year. Equipment-only
 * entries do not count (the line's source text is the building basis / land split).
 */
export function countBuildingAssetsForYear(
  assets: readonly AssetCountInput[],
  svEntityId: string | null,
  taxYear: number
): number {
  if (!svEntityId) return 0;
  return assets.filter(
    (a) =>
      a.entityId === svEntityId &&
      a.isRealProperty &&
      a.landValueCents !== null &&
      assetCountsForYear(a.placedInServiceDate, taxYear)
  ).length;
}

/**
 * Neutral register-page text for when assets exist but none of them satisfies the
 * Forms-page line (so the page must not say the line is done).
 */
export function uncountedEntriesNote(isSuddenValley: boolean, taxYear: number): string {
  return isSuddenValley
    ? `Assets are recorded, but none is a building with a land value placed in service in or before ${taxYear}, so Schedule E line 18 stays open on the Forms page until you add one or confirm none.`
    : `Assets are recorded, but none was placed in service in or before ${taxYear}, so Schedule C line 13 stays open on the Forms page until you add one or confirm none.`;
}

/**
 * Whether one entity's non-archived assets actually satisfy its Forms-page line:
 * Schedule C line 13 (EK Consulting) needs any asset placed in service in or
 * before the year; Schedule E line 18 (Sudden Valley) needs a real-property asset
 * with a land value, placed in service in or before the year. Uses the same
 * counters as the Forms-page loader so the register page never claims more.
 */
export function entriesSatisfyFormsLine(
  assets: readonly AssetCountInput[],
  entityId: string,
  isSuddenValley: boolean,
  taxYear: number
): boolean {
  return isSuddenValley
    ? countBuildingAssetsForYear(assets, entityId, taxYear) > 0
    : countEkcAssetsForYear(assets, entityId, taxYear) > 0;
}
