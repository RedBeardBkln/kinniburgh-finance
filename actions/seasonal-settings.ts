"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { todayForNewYork } from "@/lib/upcoming-ledger";
import { containsPrivateIdentifier } from "@/lib/tax-facts/validate";
import {
  appendOilPrice,
  markOilPriceRemoved,
  oilExcludedKey,
  oilPriceKey,
  parseOilPrices,
  serializeOilPrices,
  validateOilPriceInput,
} from "@/lib/seasonal-energy-prices";
import { applyToggle, descriptorOf, parseMarks, serializeMarks, signatureOf } from "@/lib/seasonal-energy-marks";
import { lineKindOfTag, payeeKindOf, siteFactsFor } from "@/lib/seasonal-energy";

// Owner actions for the Seasonal bills card on /forecast (lib/seasonal-energy.ts): the heating-oil price per gallon the
// owner types, per entity. Every export starts with `await requireAuth();` (a test pins it). The price list lives in an
// AppSetting JSON value (key `oil_price_history:<entityId>`, capped at 60 entries; removal only marks an entry removed),
// so there is no table and no migration. Last write wins: the owner is the only editor, and two tabs saving in the same
// instant could lose one entry (the card then simply shows the list as saved). The AuditLog row carries ids and counts
// only, never a price, date or note (the price list is financial data and the note is free text).

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return session.user;
}

type Result = { success: true } | { error: string };

const addSchema = z.object({
  entityId: z.string().uuid(),
  effectiveOn: z.string().max(10),
  pricePerGal: z.union([z.string().max(20), z.number()]),
  note: z.string().max(500).optional(),
});

const notOilSchema = z.object({
  entityId: z.string().uuid(),
  transactionId: z.string().uuid(),
  notOil: z.boolean(),
});

const removeSchema = z.object({
  entityId: z.string().uuid(),
  id: z.string().min(1).max(100),
});

async function entityExists(entityId: string): Promise<boolean> {
  const row = await db.entity.findFirst({ where: { id: entityId, archivedAt: null }, select: { id: true } });
  return row !== null;
}

async function readEntries(entityId: string): Promise<ReturnType<typeof parseOilPrices>> {
  const row = await db.appSetting.findUnique({ where: { key: oilPriceKey(entityId) }, select: { value: true } });
  return parseOilPrices(row?.value);
}

async function writeEntries(entityId: string, json: string): Promise<void> {
  const key = oilPriceKey(entityId);
  await db.appSetting.upsert({ where: { key }, update: { value: json }, create: { key, value: json } });
}

export async function addOilPrice(input: { entityId: string; effectiveOn: string; pricePerGal: string | number; note?: string }): Promise<Result> {
  const user = await requireAuth();
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request" };
  const { entityId, effectiveOn, pricePerGal, note } = parsed.data;

  const checked = validateOilPriceInput({ effectiveOn, pricePerGal, note }, todayForNewYork(new Date()));
  if (!checked.ok) return { error: checked.error };
  if (checked.value.note !== undefined && containsPrivateIdentifier(checked.value.note)) {
    return { error: "The note looks like it holds a personal number; please leave that out." };
  }
  if (!(await entityExists(entityId))) return { error: "Invalid request" };

  const current = await readEntries(entityId);
  if (current.corrupt) return { error: "The saved price list could not be read, so nothing was changed." };
  const id = randomUUID();
  const next = appendOilPrice(current.entries, { id, ...checked.value, addedAt: new Date().toISOString() });
  if (!next.ok) return { error: next.error };
  await writeEntries(entityId, serializeOilPrices(next.value));

  await db.auditLog.create({
    data: { changedBy: user.id as string, changeType: "oil_price_add", before: Prisma.JsonNull, after: { entityId, entryId: id, entries: next.value.length } },
  });
  revalidatePath("/forecast");
  return { success: true };
}

export async function removeOilPrice(input: { entityId: string; id: string }): Promise<Result> {
  const user = await requireAuth();
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request" };
  const { entityId, id } = parsed.data;
  if (!(await entityExists(entityId))) return { error: "Invalid request" };

  const current = await readEntries(entityId);
  if (current.corrupt) return { error: "The saved price list could not be read, so nothing was changed." };
  const next = markOilPriceRemoved(current.entries, id);
  if (!next.ok) return { error: next.error };
  await writeEntries(entityId, serializeOilPrices(next.value));

  await db.auditLog.create({
    data: { changedBy: user.id as string, changeType: "oil_price_remove", before: Prisma.JsonNull, after: { entityId, entryId: id, entries: next.value.length } },
  });
  revalidatePath("/forecast");
  return { success: true };
}

/**
 * The owner marks one payment in a property's OIL history "not heating oil" (a furnace repair, a service call, a charge
 * for another property) or counts it again. The row must be one the model counts in that history: a McCarthy heating / oil
 * payee, or (on the property's own books only) a row tagged with an oil budget line. It must exist, not be archived, and
 * belong to the site's own books or, for a McCarthy payee only, to the entity the owner named for this house
 * (lib/seasonal-energy.ts site facts); no other entity's row is ever accepted.
 *
 * A mark is DURABLE (lib/seasonal-energy-marks.ts): besides the transaction id it keeps a signature (account, cents, payee,
 * date), so the posted row that replaces a pending bank row inherits the mark. Marking a row whose pending predecessor is
 * already stored (a stale id with an alike signature) replaces that entry in the same slot. Idempotent in both directions,
 * capped at 200 entries. Only ids and signature parts are saved in the AppSetting; the transaction is never changed; the
 * AuditLog row carries ids and the list size only.
 */
export async function setMcCarthyNotOil(input: { entityId: string; transactionId: string; notOil: boolean }): Promise<Result> {
  const user = await requireAuth();
  const parsed = notOilSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid request" };
  const { entityId, transactionId, notOil } = parsed.data;

  const tx = await db.transaction.findFirst({
    where: { id: transactionId, archivedAt: null },
    select: {
      id: true,
      entityId: true,
      accountId: true,
      amount: true,
      postedAt: true,
      payeeNormalized: true,
      payeeRaw: true,
      description: true,
      tags: { select: { tag: { select: { name: true } } } },
    },
  });
  if (!tx) return { error: "That transaction was not found." };
  const payee = [tx.payeeNormalized, tx.payeeRaw, tx.description].filter((s): s is string => typeof s === "string" && s !== "").join(" ");
  const payeeKind = payeeKindOf(payee);
  // The same rule the model uses: the payee decides the kind first, a tag decides only when the payee says nothing.
  const kind = payeeKind ?? tx.tags.map((t) => lineKindOfTag(t.tag.name)).find((k) => k !== null) ?? null;
  if (kind !== "oil") return { error: "Only payments counted in this property's oil history can be marked this way." };

  const entities = await db.entity.findMany({
    where: { id: { in: [entityId, tx.entityId] }, archivedAt: null },
    select: { id: true, slug: true },
  });
  const site = entities.find((e) => e.id === entityId);
  const owner = entities.find((e) => e.id === tx.entityId);
  if (!site || !owner) return { error: "Invalid request" };
  const allowedOther = siteFactsFor(site.slug)?.oilFromEntitySlugs ?? [];
  if (tx.entityId !== entityId && !(payeeKind === "oil" && owner.slug !== null && allowedOther.includes(owner.slug))) {
    return { error: "That payment does not belong to this property's oil history." };
  }

  const key = oilExcludedKey(entityId);
  const row = await db.appSetting.findUnique({ where: { key }, select: { value: true } });
  const current = parseMarks(row?.value);
  if (current.corrupt) return { error: "The saved list could not be read, so nothing was changed." };
  // Stored marks whose transaction still exists are decisions about real rows; the others are pending rows the bank replaced.
  const alive =
    current.marks.length === 0
      ? []
      : await db.transaction.findMany({ where: { id: { in: current.marks.map((m) => m.id) }, archivedAt: null }, select: { id: true } });
  const target = { id: transactionId, sig: signatureOf({ id: transactionId, accountId: tx.accountId, amount: tx.amount.toString(), payee: descriptorOf(tx), date: tx.postedAt }) };
  const next = applyToggle(current.marks, target, notOil, new Set(alive.map((a) => a.id)));
  if (!next.ok) return { error: next.error };
  const json = serializeMarks(next.value);
  if (json !== serializeMarks(current.marks)) {
    await db.appSetting.upsert({ where: { key }, update: { value: json }, create: { key, value: json } });
    await db.auditLog.create({
      data: {
        changedBy: user.id as string,
        changeType: notOil ? "oil_row_excluded" : "oil_row_included",
        before: Prisma.JsonNull,
        after: { entityId, transactionId, entries: next.value.length },
      },
    });
  }
  revalidatePath("/forecast");
  return { success: true };
}
