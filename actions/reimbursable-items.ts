"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit, sessionUser, type ActionError } from "@/lib/invoicing/action-kit";
import { PRICING_MODES } from "@/lib/invoicing/constants";
import { userMessageFor } from "@/lib/invoicing/errors";
import { requireInvoicingEntity, requireInvoicingOwner } from "@/lib/invoicing/gate-build";
import { validateItem } from "@/lib/invoicing/items";
import * as store from "@/lib/invoicing/store";

// Reimbursable-items catalog (plan task 1.6). CATALOG ONLY: there is no quantity-on-hand anywhere. Every export starts with
// `await requireAuth();` (a test pins it) and
// is OWNER-ONLY (fail closed; Eva and any other signed-in non-owner can only view the catalog).
//
// UNCONFIRMED DEFAULT (owner question Q7): items are billed GROSS. The cost stays an ordinary expense (the bank / card
// transaction, untouched); the invoice line bills the price (cost plus an optional markup, or a fixed price) and posts to the
// income account chosen on the item (default: the profile's "Billable Expense Income"). The net alternative is not built, and the
// tax treatment of gross versus net is unverified ("needs a professional's input"). `taxable` is a stored flag; nothing is calculated.

async function requireAuth(): Promise<{ id: string; name: string | null }> {
  return sessionUser();
}

const itemSchema = z.object({
  slug: z.string().min(1).max(60),
  name: z.string().max(200),
  unit: z.string().max(60),
  unitCost: z.string().max(20),
  pricingMode: z.enum(PRICING_MODES),
  markupPercent: z.string().max(10).optional().nullable(),
  billedUnitPrice: z.string().max(20).optional().nullable(),
  glCodeId: z.string().uuid(),
  taxable: z.boolean().optional(),
});
export type ItemInput = z.input<typeof itemSchema>;

function revalidate(slug: string) {
  revalidatePath(`/business/${slug}/items`);
  revalidatePath(`/business/${slug}/invoices`);
}

export async function createItem(input: ItemInput): Promise<{ success: true; id: string } | ActionError> {
  const user = await requireAuth();
  const parsed = itemSchema.safeParse(input);
  if (!parsed.success) return { error: "Some of the item details are invalid." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const v = validateItem(parsed.data);
    if (!v.ok) return { error: v.error };
    const id = await store.createItem(entity.id, user.id, v.value);
    await audit(user.id, "invoicing_item_create", { entityId: entity.id, itemId: id });
    revalidate(parsed.data.slug);
    return { success: true, id };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

export async function updateItem(input: ItemInput & { id: string }): Promise<{ success: true } | ActionError> {
  const user = await requireAuth();
  const parsed = itemSchema.extend({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { error: "Some of the item details are invalid." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    const v = validateItem(parsed.data);
    if (!v.ok) return { error: v.error };
    await store.updateItem(entity.id, parsed.data.id, v.value);
    await audit(user.id, "invoicing_item_update", { entityId: entity.id, itemId: parsed.data.id });
    revalidate(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}

/** Archives an item (it leaves the picker; invoice lines keep their own snapshot of cost, markup and price). Nothing is deleted. */
export async function archiveItem(input: { slug: string; id: string }): Promise<{ success: true } | ActionError> {
  const user = await requireAuth();
  const parsed = z.object({ slug: z.string().min(1).max(60), id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { error: "Invalid request." };
  try {
    const { entity } = await requireInvoicingEntity(parsed.data.slug);
    await requireInvoicingOwner(user.id, entity.name);
    await store.archiveItem(entity.id, parsed.data.id);
    await audit(user.id, "invoicing_item_archive", { entityId: entity.id, itemId: parsed.data.id });
    revalidate(parsed.data.slug);
    return { success: true };
  } catch (err) {
    return { error: userMessageFor(err) };
  }
}
