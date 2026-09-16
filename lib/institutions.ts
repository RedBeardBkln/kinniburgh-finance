import { db } from "@/lib/db";
import { Prisma, type Institution } from "@prisma/client";

// ── Institution name normalization + find-or-create resolver ──────────────
// normalizeInstitutionName is pure — unit tested in lib/__tests__/institutions.test.ts.
// resolveOrCreateInstitution is DB-aware — not unit tested directly, matching
// this repo's established DB-boundary-mocking convention (see memory).

/** Trims, collapses internal whitespace, lowercases — for matching/comparison only. */
export function normalizeInstitutionName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export interface PlaidInstitutionFields {
  plaidInstitutionId?: string | null;
  plaidCoverageNotes?: string | null;
}

/**
 * Case-insensitive find-or-create against Institution.name. Trims `rawName`;
 * throws if empty after trimming (never fabricates a name — ground rule 1).
 * If found and `plaidFields` supplies values currently null on the existing
 * row, backfills them (harmless no-op for the manual-entry caller, which
 * passes no plaidFields). If not found, creates a new Institution with the
 * as-typed (trimmed) name.
 */
export async function resolveOrCreateInstitution(
  rawName: string,
  plaidFields?: PlaidInstitutionFields
): Promise<Institution> {
  const trimmed = rawName.trim();
  if (!trimmed) throw new Error("Institution name is required");

  const existing = await db.institution.findFirst({
    where: { name: { equals: trimmed, mode: Prisma.QueryMode.insensitive } },
  });

  if (existing) {
    const patch: Prisma.InstitutionUpdateInput = {};
    if (plaidFields?.plaidInstitutionId && !existing.plaidInstitutionId) {
      patch.plaidInstitutionId = plaidFields.plaidInstitutionId;
    }
    if (plaidFields?.plaidCoverageNotes && !existing.plaidCoverageNotes) {
      patch.plaidCoverageNotes = plaidFields.plaidCoverageNotes;
    }
    if (Object.keys(patch).length === 0) return existing;
    return db.institution.update({ where: { id: existing.id }, data: patch });
  }

  return db.institution.create({
    data: {
      name: trimmed,
      plaidInstitutionId: plaidFields?.plaidInstitutionId ?? null,
      plaidCoverageNotes: plaidFields?.plaidCoverageNotes ?? null,
    },
  });
}
