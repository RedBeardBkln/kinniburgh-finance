"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  normalizeDonationInput,
  type DonationActionResult,
  type DonationConflict,
  type DonationInput,
} from "@/lib/donations";
import { findDuplicateDonations, receiptLinkNeedsConfirmation } from "@/lib/donation-receipt";
import { formatCentsDisplay } from "@/lib/tax-extraction-schema";
import { taxYearOfDate, toIsoDateInput } from "@/lib/tax-log-dates";

// Donation log (Schedule A line 11 data source). The log RECORDS gifts; it never
// computes a deductible amount. Tax records are never hard-deleted: archive only.

async function requireAuth(): Promise<{ id: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { id: session.user.id };
}

const idSchema = z.string().uuid("Invalid id");

type Result = DonationActionResult;

function revalidateYears(years: Iterable<number>) {
  for (const y of new Set(years)) {
    revalidatePath(`/tax/donations/${y}`);
    revalidatePath(`/tax/forms/${y}`);
    revalidatePath(`/tax/personal/${y}`);
  }
}

async function resolvePersonalEntityId(): Promise<string | null> {
  const personal = await db.entity.findFirst({
    where: { type: "personal", archivedAt: null },
    select: { id: true },
  });
  return personal?.id ?? null;
}

/** A linked receipt must be a non-archived document filed under the Personal entity. */
async function receiptIsValid(receiptDocumentId: string | null, personalId: string): Promise<boolean> {
  if (!receiptDocumentId) return true;
  const doc = await db.document.findFirst({
    where: { id: receiptDocumentId, archivedAt: null, entityId: personalId },
    select: { id: true },
  });
  return doc !== null;
}

/**
 * The audit trail records ids, cents, kind and dates only - never the free-text
 * notes or recipient. The linked receipt is an id, not free text.
 */
function auditShape(d: {
  id: string;
  amountCents: number;
  kind: string;
  date: Date;
  substantiation: string;
  receiptDocumentId?: string | null;
}) {
  return {
    id: d.id,
    amountCents: d.amountCents,
    kind: d.kind,
    substantiation: d.substantiation,
    date: d.date.toISOString(),
    receiptDocumentId: d.receiptDocumentId ?? null,
  } satisfies Prisma.InputJsonValue;
}

const CONFLICT_SELECT = { id: true, date: true, recipient: true, amountCents: true } as const;

function toConflict(d: { id: string; date: Date; recipient: string; amountCents: number }): DonationConflict {
  return { id: d.id, dateIso: toIsoDateInput(d.date), recipient: d.recipient, amountCents: d.amountCents };
}

/**
 * Double-link guard (warn-and-confirm): a receipt already attached to a
 * non-archived gift needs the owner's explicit confirmation before it documents
 * another one (an annual letter can legitimately support several gifts). Returns
 * the refusal, or null when the save may go ahead. The gift being edited is
 * excluded. Enforced here, server-side, so no form can bypass it.
 */
async function receiptSharedRefusal(
  receiptDocumentId: string,
  excludeDonationId: string | undefined,
  confirmShared: boolean
): Promise<Extract<Result, { ok: false }> | null> {
  const linked = await db.donation.findMany({
    where: { receiptDocumentId, archivedAt: null },
    select: CONFLICT_SELECT,
  });
  if (!receiptLinkNeedsConfirmation(linked, excludeDonationId, confirmShared)) return null;
  const others = linked.filter((l) => l.id !== excludeDonationId);
  return {
    ok: false,
    code: "receipt_already_linked",
    error:
      `This receipt is already attached to ${others.length} other gift${others.length === 1 ? "" : "s"}. ` +
      "Confirm that it also documents this gift (for example a year-end letter listing several gifts).",
    conflicts: others.map(toConflict),
  };
}

export async function createDonation(input: DonationInput): Promise<Result> {
  const user = await requireAuth();
  const normalized = normalizeDonationInput(input);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const v = normalized.value;

  // The client never sends an entity id: donations always file under Personal.
  const personalId = await resolvePersonalEntityId();
  if (!personalId) return { ok: false, error: "The Personal entity was not found." };
  if (!(await receiptIsValid(v.receiptDocumentId, personalId))) {
    return { ok: false, error: "That receipt document was not found under Personal." };
  }

  if (v.receiptDocumentId) {
    const refusal = await receiptSharedRefusal(v.receiptDocumentId, undefined, v.confirmSharedReceipt);
    if (refusal) return refusal;
  }

  // Duplicate guard (warn-and-confirm, never a silent block): same calendar day
  // (every date is stored at noon UTC, so equality is the same-day test), same
  // amount and the same charity after normalization.
  const sameDay = await db.donation.findMany({
    where: { entityId: personalId, archivedAt: null, date: v.date },
    select: CONFLICT_SELECT,
  });
  const duplicates = findDuplicateDonations(
    { dateIso: toIsoDateInput(v.date), amountCents: v.amountCents, recipient: v.recipient },
    sameDay.map(toConflict)
  );
  if (duplicates.length > 0 && !v.acknowledgeDuplicate) {
    return {
      ok: false,
      code: "duplicate",
      error:
        `A gift to ${v.recipient} for ${formatCentsDisplay(v.amountCents)} on ${toIsoDateInput(v.date)} is already logged. ` +
        "Save anyway only if this is a different gift.",
      conflicts: duplicates,
    };
  }

  const created = await db.donation.create({
    data: {
      entityId: personalId,
      date: v.date,
      recipient: v.recipient,
      amountCents: v.amountCents,
      kind: v.kind,
      substantiation: v.substantiation,
      receiptDocumentId: v.receiptDocumentId,
      notes: v.notes,
      createdById: user.id,
    },
  });

  await db.auditLog.create({
    data: {
      changedBy: user.id,
      changeType: "donation_create",
      before: Prisma.JsonNull,
      after: auditShape(created),
    },
  });

  revalidateYears([taxYearOfDate(created.date)]);
  return { ok: true, id: created.id };
}

export async function updateDonation(id: string, input: DonationInput): Promise<Result> {
  const user = await requireAuth();
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, error: "Invalid id" };
  const normalized = normalizeDonationInput(input);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const v = normalized.value;

  const existing = await db.donation.findFirst({ where: { id: idParsed.data, archivedAt: null } });
  if (!existing) return { ok: false, error: "Donation not found" };
  if (!(await receiptIsValid(v.receiptDocumentId, existing.entityId))) {
    return { ok: false, error: "That receipt document was not found under Personal." };
  }

  // Only a NEWLY attached receipt is checked: re-saving an unchanged linked gift
  // is never blocked, and links that were already shared are never retro-blocked.
  if (v.receiptDocumentId && v.receiptDocumentId !== existing.receiptDocumentId) {
    const refusal = await receiptSharedRefusal(v.receiptDocumentId, existing.id, v.confirmSharedReceipt);
    if (refusal) return refusal;
  }

  const updated = await db.donation.update({
    where: { id: existing.id },
    data: {
      date: v.date,
      recipient: v.recipient,
      amountCents: v.amountCents,
      kind: v.kind,
      substantiation: v.substantiation,
      receiptDocumentId: v.receiptDocumentId,
      notes: v.notes,
    },
  });

  await db.auditLog.create({
    data: {
      changedBy: user.id,
      changeType: "donation_update",
      before: auditShape(existing),
      after: auditShape(updated),
    },
  });

  revalidateYears([taxYearOfDate(existing.date), taxYearOfDate(updated.date)]);
  return { ok: true, id: updated.id };
}

/** Archive only - there is deliberately no hard delete of a tax record. */
export async function archiveDonation(id: string): Promise<Result> {
  const user = await requireAuth();
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, error: "Invalid id" };

  const existing = await db.donation.findFirst({ where: { id: idParsed.data, archivedAt: null } });
  if (!existing) return { ok: false, error: "Donation not found" };

  await db.donation.update({ where: { id: existing.id }, data: { archivedAt: new Date() } });

  await db.auditLog.create({
    data: {
      changedBy: user.id,
      changeType: "donation_archive",
      before: auditShape(existing),
      after: Prisma.JsonNull,
    },
  });

  revalidateYears([taxYearOfDate(existing.date)]);
  return { ok: true, id: existing.id };
}
