"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeFixedAssetInput, type FixedAssetInput } from "@/lib/fixed-assets";
import { taxYearOfDate } from "@/lib/tax-log-dates";

// Fixed-asset register (Form 4562 / Schedule C line 13 / Schedule E line 18
// INPUTS). The register RECORDS what the owner entered; it never computes
// depreciation, picks a MACRS class or decides Section 179 / bonus. Tax records
// are never hard-deleted: archive only.

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

const idSchema = z.string().uuid("Invalid id");

type Result = { ok: true; id: string } | { ok: false; error: string };

function revalidateYears(years: Iterable<number>) {
  // The asset's placed-in-service year and the current year (the years the
  // Forms page / register are most likely being viewed for).
  const all = new Set<number>(years);
  all.add(new Date().getUTCFullYear());
  for (const y of all) {
    revalidatePath(`/tax/fixed-assets/${y}`);
    revalidatePath(`/tax/forms/${y}`);
    revalidatePath(`/tax/personal/${y}`);
  }
}

/** A linked invoice must be a non-archived document of the SAME entity as the asset. */
async function invoiceIsValid(invoiceDocumentId: string | null, entityId: string): Promise<boolean> {
  if (!invoiceDocumentId) return true;
  const doc = await db.document.findFirst({
    where: { id: invoiceDocumentId, archivedAt: null, entityId },
    select: { id: true },
  });
  return doc !== null;
}

/** Audit rows record ids, cents, dates and flags only - never the free-text description or notes. */
function auditShape(a: {
  id: string;
  entityId: string;
  costBasisCents: number;
  landValueCents: number | null;
  isRealProperty: boolean;
  businessUsePercent: number;
  placedInServiceDate: Date;
}) {
  return {
    id: a.id,
    entityId: a.entityId,
    costBasisCents: a.costBasisCents,
    landValueCents: a.landValueCents,
    isRealProperty: a.isRealProperty,
    businessUsePercent: a.businessUsePercent,
    placedInServiceDate: a.placedInServiceDate.toISOString(),
  } satisfies Prisma.InputJsonValue;
}

export async function createFixedAsset(input: FixedAssetInput & { entityId: string }): Promise<Result> {
  const user = await requireAuth();
  const entityParsed = idSchema.safeParse(input?.entityId);
  if (!entityParsed.success) return { ok: false, error: "Choose a business entity" };
  const normalized = normalizeFixedAssetInput(input);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const v = normalized.value;

  // Business entities only (Personal assets are not supported yet).
  const entity = await db.entity.findFirst({
    where: { id: entityParsed.data, archivedAt: null, type: "business" },
    select: { id: true },
  });
  if (!entity) return { ok: false, error: "Fixed assets can only be recorded for a business entity." };
  if (!(await invoiceIsValid(v.invoiceDocumentId, entity.id))) {
    return { ok: false, error: "That invoice document was not found under this entity." };
  }

  const created = await db.fixedAsset.create({
    data: {
      entityId: entity.id,
      description: v.description,
      placedInServiceDate: v.placedInServiceDate,
      costBasisCents: v.costBasisCents,
      isRealProperty: v.isRealProperty,
      landValueCents: v.landValueCents,
      businessUsePercent: v.businessUsePercent,
      invoiceDocumentId: v.invoiceDocumentId,
      notes: v.notes,
      createdById: user.id,
    },
  });

  await db.auditLog.create({
    data: {
      changedBy: user.id,
      changeType: "fixed_asset_create",
      before: Prisma.JsonNull,
      after: auditShape(created),
    },
  });

  revalidateYears([taxYearOfDate(created.placedInServiceDate)]);
  return { ok: true, id: created.id };
}

/** The entity of an asset cannot change on update. */
export async function updateFixedAsset(id: string, input: FixedAssetInput): Promise<Result> {
  const user = await requireAuth();
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, error: "Invalid id" };
  const normalized = normalizeFixedAssetInput(input);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const v = normalized.value;

  const existing = await db.fixedAsset.findFirst({ where: { id: idParsed.data, archivedAt: null } });
  if (!existing) return { ok: false, error: "Fixed asset not found" };
  if (!(await invoiceIsValid(v.invoiceDocumentId, existing.entityId))) {
    return { ok: false, error: "That invoice document was not found under this entity." };
  }

  const updated = await db.fixedAsset.update({
    where: { id: existing.id },
    data: {
      description: v.description,
      placedInServiceDate: v.placedInServiceDate,
      costBasisCents: v.costBasisCents,
      isRealProperty: v.isRealProperty,
      landValueCents: v.landValueCents,
      businessUsePercent: v.businessUsePercent,
      invoiceDocumentId: v.invoiceDocumentId,
      notes: v.notes,
    },
  });

  await db.auditLog.create({
    data: {
      changedBy: user.id,
      changeType: "fixed_asset_update",
      before: auditShape(existing),
      after: auditShape(updated),
    },
  });

  revalidateYears([taxYearOfDate(existing.placedInServiceDate), taxYearOfDate(updated.placedInServiceDate)]);
  return { ok: true, id: updated.id };
}

/** Archive only - there is deliberately no hard delete of a tax record. */
export async function archiveFixedAsset(id: string): Promise<Result> {
  const user = await requireAuth();
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, error: "Invalid id" };

  const existing = await db.fixedAsset.findFirst({ where: { id: idParsed.data, archivedAt: null } });
  if (!existing) return { ok: false, error: "Fixed asset not found" };

  await db.fixedAsset.update({ where: { id: existing.id }, data: { archivedAt: new Date() } });

  await db.auditLog.create({
    data: {
      changedBy: user.id,
      changeType: "fixed_asset_archive",
      before: auditShape(existing),
      after: Prisma.JsonNull,
    },
  });

  revalidateYears([taxYearOfDate(existing.placedInServiceDate)]);
  return { ok: true, id: existing.id };
}
