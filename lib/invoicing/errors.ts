// Shared error helpers of the invoicing feature. PURE.

import { INVOICING_NOT_SET_UP } from "@/lib/invoicing/constants";

/**
 * A refusal with a plain, STATIC sentence that is safe to show the user (never built from request data, a name, an amount or a
 * secret). Everything else that reaches an action's catch is logged as `err.name` only and shown as a generic failure.
 */
export class InvoicingRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoicingRefusal";
  }
}

const TABLES = ["InvoicingProfile", "Client", "ClientContact", "ReimbursableItem", "BillingDocument", "BillingLine", "BillingPayment", "BillingAllocation", "BillingEvent"];

/** True when the error says one of the invoicing tables (or the database object) does not exist yet: the migration has not been applied. */
export function isMissingInvoicingTable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown; meta?: { code?: unknown } };
  if (e.code === "P2021") return true;
  if (e.meta && e.meta.code === "42P01") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return TABLES.some((t) => msg.includes(t)) && /does not exist|42P01/.test(msg);
}

/** Prisma unique-constraint violation (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

export const GENERIC_FAILURE = "Something went wrong and nothing was saved. Try again.";
export const CHANGED_IN_OTHER_TAB = "This was changed in another tab or window. Reload the page and try again.";

/** Maps whatever an action caught to a user-safe sentence; logs the error NAME only (never message, body or values). */
export function userMessageFor(err: unknown): string {
  if (err instanceof InvoicingRefusal) return err.message;
  if (isMissingInvoicingTable(err)) return INVOICING_NOT_SET_UP;
  console.error("Invoicing action failed", err instanceof Error ? err.name : "UnknownError");
  return GENERIC_FAILURE;
}
