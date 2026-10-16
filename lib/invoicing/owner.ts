// Who may do ANYTHING that writes in invoicing (owner decision 2026-10-16: Eva has read-only access to the invoicing suite; plan D6 had
// let her draft). PURE wrapper.
//
// REPO FACT: User.role is "owner" for BOTH spouses, so it cannot tell Eric from Eva. The repo's real owner rule is the one used for
// tax-year close and return approval: the user whose full name is contained in the EK Consulting entity name; no single match
// means nobody (fail closed). This reuses that pure rule and only rewrites the refusal text. Anyone else signed in can only VIEW
// (invoices, clients, items, payments) and download an invoice PDF.

import { resolveYearCloser } from "@/lib/tax-year-close/closer";

export interface OwnerResolution {
  allowed: boolean;
  ownerName: string | null;
  /** Plain-language reason when not allowed. */
  reason: string | null;
}

export const NOT_INVOICING_OWNER_MESSAGE =
  "Only the owner's own account can create or change anything in invoicing. You can view invoices, clients, items and payments, and download an invoice PDF.";
export const INVOICING_OWNER_UNKNOWN_MESSAGE =
  "The owner's account could not be identified (no single user matches the consulting entity's name), so owner-only actions are turned off.";

export function resolveInvoicingOwner(users: readonly { id: string; name: string }[], ekcEntityName: string | null, sessionUserId: string): OwnerResolution {
  const r = resolveYearCloser(users, ekcEntityName, sessionUserId);
  if (r.allowed) return { allowed: true, ownerName: r.ownerName, reason: null };
  return { allowed: false, ownerName: r.ownerName, reason: r.ownerName === null ? INVOICING_OWNER_UNKNOWN_MESSAGE : NOT_INVOICING_OWNER_MESSAGE };
}
