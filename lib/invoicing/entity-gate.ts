// Which entities may use invoicing (plan D5). PURE, no DB import (the sidebar and tests import it). The slug allow-list is the
// code-reviewed half of the gate; the other half is an InvoicingProfile row with `enabled = true` for the entity, checked by
// lib/invoicing/gate-build.ts#requireInvoicingEntity. Adding another entity later = add its slug here and run setup for it.

export const INVOICING_SLUGS: readonly string[] = ["ek-consulting"];

export function isInvoicingSlug(slug: string | null | undefined): boolean {
  return typeof slug === "string" && INVOICING_SLUGS.includes(slug);
}
