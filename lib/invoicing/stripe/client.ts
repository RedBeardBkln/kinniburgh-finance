// The ONLY file that imports the `stripe` SDK (a guard test pins it). Server only: never import it from a "use client" component.
//
// Rules kept here:
//  - the API version is pinned to the SDK's own (`STRIPE_API_VERSION`; a test compares it with the installed SDK, so an SDK bump
//    without a review of this constant fails);
//  - the client is created lazily from STRIPE_SECRET_KEY only after the pre-flight passes; the key is never logged, returned or stored;
//  - webhook signatures are verified with `constructEvent(raw, signature, secret)` WITHOUT a tolerance argument, so the SDK's default
//    300-second tolerance applies (passing 0 would SKIP the timestamp check);
//  - every function returns a narrow plain object (no SDK type leaks to callers), and nothing here logs anything: callers log
//    `err.name` only.

import Stripe from "stripe";
import { stripePreflight } from "@/lib/invoicing/stripe/preflight";
import type { CheckoutCreateParams } from "@/lib/invoicing/stripe/checkout-params";

export const STRIPE_API_VERSION = "2026-09-30.endive" as const;

let cached: { key: string; client: Stripe } | null = null;

function client(): Stripe {
  const pre = stripePreflight(process.env);
  if (!pre.ok) {
    const e = new Error("Stripe is not configured");
    e.name = "StripeNotConfigured";
    throw e;
  }
  const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (cached && cached.key === key) return cached.client;
  const c = new Stripe(key, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 20_000 });
  cached = { key, client: c };
  return c;
}

/** A verified webhook event, narrowed to the fields the handler reads. `object` is `data.object` (null when absent, e.g. a thin event). */
export interface VerifiedStripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  /** Unix seconds. */
  created: number;
  object: Record<string, unknown> | null;
}

/** Verifies the `Stripe-Signature` header over the EXACT raw body and parses the event. Throws on any mismatch (bad, stale, missing). */
export function verifyStripeEvent(raw: string, signature: string, secret: string): VerifiedStripeEvent {
  const event = Stripe.webhooks.constructEvent(raw, signature, secret);
  const data = (event as unknown as { data?: { object?: unknown } }).data;
  const object = data && typeof data.object === "object" && data.object !== null && !Array.isArray(data.object) ? (data.object as Record<string, unknown>) : null;
  return { id: event.id, type: event.type, livemode: event.livemode, created: event.created, object };
}

/** Creates a Checkout Session (idempotent per key). Returns its hosted URL. */
export async function createCheckoutSession(params: CheckoutCreateParams, idempotencyKey: string): Promise<{ id: string; url: string | null }> {
  const s = await client().checkout.sessions.create(params, { idempotencyKey });
  return { id: s.id, url: s.url };
}

export interface CheckoutSessionLite {
  id: string;
  paymentStatus: string;
  amountTotal: number | null;
  currency: string | null;
  livemode: boolean;
  clientReferenceId: string | null;
  metadata: Record<string, string>;
  paymentIntentId: string | null;
}

/** Re-reads a Checkout Session from the API (snapshot payloads can be stale: the API is the truth). */
export async function retrieveCheckoutSession(id: string): Promise<CheckoutSessionLite> {
  const s = await client().checkout.sessions.retrieve(id);
  const pi = s.payment_intent;
  return {
    id: s.id,
    paymentStatus: s.payment_status,
    amountTotal: s.amount_total,
    currency: s.currency,
    livemode: s.livemode,
    clientReferenceId: s.client_reference_id,
    metadata: { ...(s.metadata ?? {}) },
    paymentIntentId: typeof pi === "string" ? pi : pi ? pi.id : null,
  };
}

export interface PaymentIntentFee {
  /** The Stripe fee in cents, or null when it is not known yet (no charge or balance transaction). */
  feeCents: number | null;
  chargeId: string | null;
  /** The charge's payment method type, e.g. "card" or "us_bank_account". */
  methodType: string | null;
}

/** Reads the fee of a PaymentIntent's latest charge through its balance transaction. */
export async function retrievePaymentIntentFee(paymentIntentId: string): Promise<PaymentIntentFee> {
  const pi = await client().paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
  const charge = pi.latest_charge;
  if (!charge || typeof charge === "string") return { feeCents: null, chargeId: typeof charge === "string" ? charge : null, methodType: null };
  const bt = charge.balance_transaction;
  const methodType = charge.payment_method_details?.type ?? null;
  if (!bt || typeof bt === "string") return { feeCents: null, chargeId: charge.id, methodType };
  return { feeCents: Number.isSafeInteger(bt.fee) && bt.fee >= 0 ? bt.fee : null, chargeId: charge.id, methodType };
}
