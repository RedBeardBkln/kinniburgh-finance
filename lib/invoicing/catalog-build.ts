// Read-only loaders for the lookup data of the invoicing screens: GL accounts, the reimbursable catalog, cost transactions to link,
// W-9 documents. No writes, explicit selects, archived rows excluded, plain strings / numbers out (no Decimal, no Date).

import { db } from "@/lib/db";
import { decimalToCents } from "@/lib/invoicing/cents";
import { billedPriceCents } from "@/lib/invoicing/items";
import { toIsoDate } from "@/lib/invoicing/validate";
import type { GlCodeLite } from "@/lib/invoicing/gl-map";

export interface GlOption {
  id: string;
  code: string;
  name: string;
  type: string;
}

export async function loadGlCodes(entityId: string): Promise<GlOption[]> {
  const rows = await db.glCode.findMany({ where: { entityId, archivedAt: null }, select: { id: true, code: true, name: true, type: true }, orderBy: { code: "asc" } });
  return rows;
}

export async function loadGlCodesLite(entityId: string): Promise<GlCodeLite[]> {
  return db.glCode.findMany({ where: { entityId }, select: { id: true, entityId: true, code: true, name: true, type: true, archivedAt: true } });
}

export interface ItemView {
  id: string;
  name: string;
  unit: string;
  unitCostCents: number;
  pricingMode: string;
  markupBps: number | null;
  billedUnitPriceCents: number | null;
  billedPriceCents: number;
  glCodeId: string;
  glLabel: string;
  taxable: boolean;
}

export async function loadItems(entityId: string): Promise<ItemView[]> {
  const rows = await db.reimbursableItem.findMany({
    where: { entityId, archivedAt: null },
    select: { id: true, name: true, unit: true, unitCostCents: true, pricingMode: true, markupBps: true, billedUnitPriceCents: true, glCodeId: true, taxable: true, glCode: { select: { code: true, name: true } } },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    unit: r.unit,
    unitCostCents: r.unitCostCents,
    pricingMode: r.pricingMode,
    markupBps: r.markupBps,
    billedUnitPriceCents: r.billedUnitPriceCents,
    billedPriceCents: billedPriceCents(r),
    glCodeId: r.glCodeId,
    glLabel: `${r.glCode.code} ${r.glCode.name}`,
    taxable: r.taxable,
  }));
}

export interface CostTransactionOption {
  id: string;
  label: string;
}

/** Recent outflows of the entity a reimbursable line may point at (display + margin only; no accounting effect). */
export async function loadCostTransactionOptions(entityId: string, today: Date): Promise<CostTransactionOption[]> {
  const since = new Date(today.getTime() - 120 * 86_400_000);
  const rows = await db.transaction.findMany({
    where: { entityId, archivedAt: null, transferPairId: null, amount: { lt: 0 }, postedAt: { gte: since } },
    select: { id: true, postedAt: true, amount: true, payeeRaw: true, description: true },
    orderBy: { postedAt: "desc" },
    take: 150,
  });
  return rows.map((r) => ({
    id: r.id,
    label: `${toIsoDate(r.postedAt)}  ${(r.payeeRaw ?? r.description ?? "").slice(0, 40)}  ${(-decimalToCents(r.amount) / 100).toFixed(2)}`,
  }));
}

export interface W9Option {
  id: string;
  label: string;
}

export async function loadW9Documents(entityId: string): Promise<W9Option[]> {
  const rows = await db.document.findMany({
    where: { entityId, docType: "w9", archivedAt: null },
    select: { id: true, documentName: true, notes: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map((r) => ({ id: r.id, label: `${r.documentName ?? r.notes ?? "W-9"} (${toIsoDate(r.createdAt)})` }));
}
