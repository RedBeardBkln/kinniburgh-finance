// Shared error helpers of the invoicing feature. PURE.

import { INVOICING_NOT_SET_UP, PAY_FEATURE_NOT_SET_UP } from "@/lib/invoicing/constants";

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

const PAY_TABLES = ["BillingAccessToken", "StripeEvent"];
const PAY_COLUMNS = ["stripePayEnabled", "publicTokenTtlDays", "stripePaymentIntentId", "stripeChargeId", "stripeCheckoutSessionId", "stripeFeeStatus"];

/**
 * True when the error says the Phase-2 (online payments) database update is missing: a missing table (P2021 / 42P01) or a missing
 * column (P2022 / 42703). Phase-2 loaders then answer "not set up" and nothing Phase-2 is offered; Phase-1 semantics
 * (`isMissingInvoicingTable`) are unchanged.
 */
export function isMissingPayFeature(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown; meta?: { code?: unknown } };
  if (e.code === "P2021" || e.code === "P2022") return true;
  if (e.meta && (e.meta.code === "42P01" || e.meta.code === "42703")) return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return mentionsPayFeature(err) && /does not exist|42P01|42703/.test(msg);
}

/** True when the error is a missing COLUMN (Prisma P2022 / Postgres 42703), as opposed to a missing table. */
export function isMissingColumn(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; meta?: { code?: unknown } };
  return e.code === "P2022" || (e.meta !== undefined && e.meta !== null && e.meta.code === "42703");
}

/** True when the error's message or meta names a Phase-2 table or column. */
function mentionsPayFeature(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { message?: unknown; meta?: unknown };
  const text = `${typeof e.message === "string" ? e.message : ""} ${e.meta && typeof e.meta === "object" ? JSON.stringify(e.meta) : ""}`;
  return [...PAY_TABLES, ...PAY_COLUMNS].some((t) => text.includes(t));
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
  if (isMissingPayFeature(err) && ((err as { code?: unknown }).code === "P2022" || mentionsPayFeature(err))) return PAY_FEATURE_NOT_SET_UP;
  if (isMissingInvoicingTable(err)) return INVOICING_NOT_SET_UP;
  console.error("Invoicing action failed", err instanceof Error ? err.name : "UnknownError");
  return GENERIC_FAILURE;
}
