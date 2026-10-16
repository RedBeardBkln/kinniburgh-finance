// Reimbursable-items catalog rules (plan 1.6, decision D4). PURE, client-safe.
//
// UNCONFIRMED DEFAULT (owner question Q7, not answered): reimbursables are billed with the GROSS method. The cost stays a normal
// expense (the bank / card Transaction, coded to its own expense account, untouched); the invoice line bills the price (cost plus
// an optional markup, or a fixed price) and posts to the income account "Billable Expense Income". The P&L shows both and the margin
// is billed income minus cost. The NET alternative (credit the expense account instead) is NOT built. The tax treatment of gross
// versus net is unverified and "needs a professional's input". Nothing here calculates tax; `taxable` is a stored flag only.
// There is deliberately NO quantity-on-hand anywhere (catalog only).

import { parseDollarsToCents } from "@/lib/money-input";
import { MAX_MARKUP_BPS, MAX_NAME, PRICING_MODES, type PricingMode } from "@/lib/invoicing/constants";
import { markupPriceCents, parsePercentToBps } from "@/lib/invoicing/money";
import { cleanText, isUuid, type Checked } from "@/lib/invoicing/validate";

export const REIMBURSABLE_GROSS_DEFAULT_NOTE =
  "Unconfirmed default: reimbursable items are billed gross. The cost stays an ordinary expense and the billed price is income. Tax treatment is not decided here and needs a professional's input.";

export interface ItemInput {
  name: string;
  unit: string;
  /** Dollars. */
  unitCost: string;
  pricingMode: string;
  /** Percent text, e.g. "15" (markup mode). A markup of 0 is allowed (pass-through at cost). */
  markupPercent?: string | null;
  /** Dollars (fixed_price mode). */
  billedUnitPrice?: string | null;
  glCodeId: string;
  taxable?: boolean;
}

export interface ValidatedItem {
  name: string;
  unit: string;
  unitCostCents: number;
  pricingMode: PricingMode;
  markupBps: number | null;
  billedUnitPriceCents: number | null;
  glCodeId: string;
  taxable: boolean;
}

export function validateItem(input: ItemInput): Checked<ValidatedItem> {
  const name = cleanText(input.name, { label: "Name", max: MAX_NAME, required: true });
  if (!name.ok) return name;
  const unit = cleanText(input.unit, { label: "Unit", max: 20, required: true });
  if (!unit.ok) return unit;
  const cost = parseDollarsToCents(input.unitCost, { allowZero: true });
  if (!cost.ok) return { ok: false, error: `Unit cost: ${cost.error}` };
  if (!(PRICING_MODES as readonly string[]).includes(input.pricingMode)) return { ok: false, error: "Choose markup or fixed price." };
  if (!isUuid(input.glCodeId)) return { ok: false, error: "Choose an income account." };
  let markupBps: number | null = null;
  let billed: number | null = null;
  if (input.pricingMode === "markup") {
    const text = (input.markupPercent ?? "").trim();
    if (text === "" || /^0+(\.0+)?$/.test(text)) {
      markupBps = 0;
    } else {
      markupBps = parsePercentToBps(text);
      if (markupBps === null) return { ok: false, error: "Markup must be a percent like 15 or 12.5 (up to 2 decimals, at most 100)." };
    }
    if (markupBps > MAX_MARKUP_BPS) return { ok: false, error: "That markup is too large." };
  } else {
    const p = parseDollarsToCents(input.billedUnitPrice ?? "");
    if (!p.ok) return { ok: false, error: `Billed price: ${p.error}` };
    billed = p.cents;
  }
  return {
    ok: true,
    value: {
      name: name.value ?? "",
      unit: unit.value ?? "",
      unitCostCents: cost.cents,
      pricingMode: input.pricingMode as PricingMode,
      markupBps,
      billedUnitPriceCents: billed,
      glCodeId: input.glCodeId,
      taxable: input.taxable === true,
    },
  };
}

/** The price the catalog item bills per unit. */
export function billedPriceCents(item: { pricingMode: string; unitCostCents: number; markupBps: number | null; billedUnitPriceCents: number | null }): number {
  if (item.pricingMode === "fixed_price") return item.billedUnitPriceCents ?? item.unitCostCents;
  return markupPriceCents(item.unitCostCents, item.markupBps ?? 0);
}

/** Margin per unit (billed minus cost) for display; never an accounting entry. */
export function marginPerUnitCents(item: { pricingMode: string; unitCostCents: number; markupBps: number | null; billedUnitPriceCents: number | null }): number {
  return billedPriceCents(item) - item.unitCostCents;
}
