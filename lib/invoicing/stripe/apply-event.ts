// What the Stripe webhook does with one verified event (plan P7.6). PURE: no SDK import, no DB, no clock. The route narrows the event
// and the RE-FETCHED Checkout Session into plain objects, loads our invoice / payment rows, and passes them here; the store then applies
// the decision in one transaction (lib/invoicing/store.ts#applyStripeDecision).
//
// Rules:
//  - a payment is recorded only when the re-fetched session says `payment_status === "paid"`: on `checkout.session.completed` (cards)
//    or on `checkout.session.async_payment_succeeded` (US bank account / ACH, which completes "unpaid" first);
//  - the invoice is resolved ONLY from our own metadata (invoiceId + entityId) and `client_reference_id` must equal the invoice id; the
//    invoice must exist with that entity, be an invoice of the allow-listed entity whose invoicing profile is enabled. The "Online
//    payments" toggle being off does NOT block recording: the money was already taken;
//  - an ACH failure, a refund and a dispute only raise a flag for the owner; nothing is ever reversed;
//  - anything we cannot resolve is "unmatched" (answered 200, kept for the owner's review), never guessed.

import type { StripeFlagReason } from "@/lib/invoicing/constants";
import { nyToday } from "@/lib/invoicing/state";

export const HANDLED_STRIPE_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "charge.refunded",
  "charge.dispute.created",
] as const;
export type HandledStripeEvent = (typeof HANDLED_STRIPE_EVENTS)[number];
export type CheckoutEventType = Extract<HandledStripeEvent, `checkout.${string}`>;
export type ChargeEventType = Extract<HandledStripeEvent, `charge.${string}`>;

export function isHandledStripeEvent(type: string): type is HandledStripeEvent {
  return (HANDLED_STRIPE_EVENTS as readonly string[]).includes(type);
}
export function isCheckoutEvent(type: HandledStripeEvent): type is CheckoutEventType {
  return type.startsWith("checkout.");
}

/** The re-fetched Checkout Session, narrowed. */
export interface SessionFacts {
  id: string;
  paymentStatus: string;
  amountTotal: number | null;
  currency: string | null;
  clientReferenceId: string | null;
  metadata: Record<string, string>;
  paymentIntentId: string | null;
}

/** Our invoice as the webhook needs it (loaded by id from the session metadata, then checked here). */
export interface StripeInvoiceRef {
  id: string;
  entityId: string;
  kind: string;
  status: string;
  clientId: string;
  /** The invoice's entity slug is on the invoicing allow-list. */
  allowListed: boolean;
  /** The entity's invoicing profile exists and is enabled. */
  profileEnabled: boolean;
}

/** A recorded Stripe payment found by its PaymentIntent id (for refunds and disputes). */
export interface StripePaymentRef {
  id: string;
  entityId: string;
  /** Invoices it is (still) applied to. */
  invoiceIds: string[];
}

export type DecideInput =
  | { type: CheckoutEventType; created: number; session: SessionFacts; invoice: StripeInvoiceRef | null }
  | { type: ChargeEventType; paymentIntentId: string | null; amountCents: number | null; payment: StripePaymentRef | null };

export type UnmatchedReason = "metadata" | "reference" | "invoice" | "entity" | "currency" | "amount" | "payment_intent" | "status" | "payment";

export type Decision =
  | {
      action: "record_payment";
      outcome: "recorded";
      entityId: string;
      invoiceId: string;
      clientId: string;
      amountCents: number;
      paymentIntentId: string;
      sessionId: string;
      /** America/New_York calendar day of the event (payment success time) at 00:00 UTC. */
      receivedOn: Date;
      /** The method if the charge cannot tell: the event type's usual method. */
      defaultMethod: "card" | "ach";
    }
  | {
      action: "flag";
      outcome: "flagged";
      reason: StripeFlagReason;
      entityId: string;
      documentIds: string[];
      paymentId: string | null;
      amountCents: number | null;
      /** The session's PaymentIntent for a failed bank payment (closes its "processing" row); null for refunds and disputes. */
      paymentIntentId: string | null;
    }
  /** A bank (ACH) payment completed "unpaid": the store writes a "bank_payment_pending" row keyed by its PaymentIntent. */
  | { action: "noop"; outcome: "awaiting_async"; entityId: string; documentId: string; amountCents: number; paymentIntentId: string }
  | { action: "unmatched"; outcome: `unmatched_${UnmatchedReason}` };

const unmatched = (r: UnmatchedReason): Decision => ({ action: "unmatched", outcome: `unmatched_${r}` });

export function decideStripeEvent(input: DecideInput): Decision {
  if (!("session" in input)) {
    if (!input.paymentIntentId || !input.payment) return unmatched("payment");
    return {
      action: "flag",
      outcome: "flagged",
      reason: input.type === "charge.refunded" ? "refunded" : "disputed",
      entityId: input.payment.entityId,
      documentIds: [...new Set(input.payment.invoiceIds)].sort(),
      paymentId: input.payment.id,
      amountCents: input.amountCents !== null && Number.isSafeInteger(input.amountCents) && input.amountCents >= 0 ? input.amountCents : null,
      paymentIntentId: null,
    };
  }

  const s = input.session;
  const invoiceId = s.metadata.invoiceId ?? "";
  const entityId = s.metadata.entityId ?? "";
  if (invoiceId === "" || entityId === "") return unmatched("metadata");
  if (s.clientReferenceId !== invoiceId) return unmatched("reference");
  const inv = input.invoice;
  if (!inv || inv.id !== invoiceId || inv.entityId !== entityId || inv.kind !== "invoice") return unmatched("invoice");
  if (!inv.allowListed || !inv.profileEnabled) return unmatched("entity");

  if (input.type === "checkout.session.async_payment_failed") {
    return { action: "flag", outcome: "flagged", reason: "ach_failed", entityId: inv.entityId, documentIds: [inv.id], paymentId: null, amountCents: s.amountTotal !== null && s.amountTotal > 0 ? s.amountTotal : null, paymentIntentId: s.paymentIntentId };
  }

  if (s.currency !== "usd") return unmatched("currency");
  if (s.amountTotal === null || !Number.isSafeInteger(s.amountTotal) || s.amountTotal <= 0) return unmatched("amount");
  if (!s.paymentIntentId) return unmatched("payment_intent");

  if (s.paymentStatus !== "paid") {
    if (input.type === "checkout.session.completed" && s.paymentStatus === "unpaid") return { action: "noop", outcome: "awaiting_async", entityId: inv.entityId, documentId: inv.id, amountCents: s.amountTotal, paymentIntentId: s.paymentIntentId };
    return unmatched("status");
  }
  return {
    action: "record_payment",
    outcome: "recorded",
    entityId: inv.entityId,
    invoiceId: inv.id,
    clientId: inv.clientId,
    amountCents: s.amountTotal,
    paymentIntentId: s.paymentIntentId,
    sessionId: s.id,
    receivedOn: nyToday(new Date(input.created * 1000)),
    defaultMethod: input.type === "checkout.session.async_payment_succeeded" ? "ach" : "card",
  };
}

/** How a Stripe amount is applied to the invoice it paid, decided under the invoice row lock with the CURRENT balance. */
export function splitStripeAmount(amountCents: number, invoiceStatus: string, balanceCents: number): { allocateCents: number; remainderCents: number; flag: "overpayment" | "invoice_not_open" | null } {
  if (invoiceStatus !== "issued") return { allocateCents: 0, remainderCents: amountCents, flag: "invoice_not_open" };
  if (balanceCents <= 0) return { allocateCents: 0, remainderCents: amountCents, flag: "overpayment" };
  if (amountCents > balanceCents) return { allocateCents: balanceCents, remainderCents: amountCents - balanceCents, flag: "overpayment" };
  return { allocateCents: amountCents, remainderCents: 0, flag: null };
}

/** Our payment method from the charge's payment method type, else the event type's usual one. */
export function paymentMethodFor(methodType: string | null, fallback: "card" | "ach"): "card" | "ach" {
  if (methodType === "card") return "card";
  if (methodType === "us_bank_account") return "ach";
  return fallback;
}
