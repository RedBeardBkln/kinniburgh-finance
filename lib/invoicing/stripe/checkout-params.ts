// Checkout Session parameters for "Pay online" (plan P6). PURE: no SDK import, no DB, no clock (the caller passes `nowMs`).
//
// Every parameter is a function of (invoice id, entity id, display number, balance, time bucket, base URL), so two calls inside the same
// 10-minute bucket for the same balance send IDENTICAL parameters under the SAME idempotency key (a true idempotent replay at Stripe).
//  - mode "payment", `allowed_payment_method_types` card + us_bank_account (in this API version Checkout has no static
//    `payment_method_types` create parameter; the allowed list filters the methods enabled in the Dashboard);
//  - one USD line "Invoice <number>" for the CURRENT balance in cents (the server's figure, never the client's);
//  - our invoice and entity ids in the session metadata, in the PaymentIntent metadata (so refunds and disputes trace back) and as
//    `client_reference_id`;
//  - STATIC success / cancel pages that carry no token (the link token never reaches Stripe);
//  - the session expires 2 hours after the start of its bucket (between 1 h 50 min and 2 h after creation, inside Stripe's
//    30 minutes to 24 hours), to shrink the window in which an old session for an outdated balance can still be paid.

import { CHECKOUT_BUCKET_MS, CHECKOUT_SESSION_LIFETIME_S } from "@/lib/invoicing/constants";

/** The subset of Stripe's SessionCreateParams this feature sends (structurally compatible with the SDK type). */
export interface CheckoutCreateParams {
  mode: "payment";
  allowed_payment_method_types: ("card" | "us_bank_account")[];
  line_items: { quantity: number; price_data: { currency: "usd"; unit_amount: number; product_data: { name: string } } }[];
  client_reference_id: string;
  metadata: { invoiceId: string; entityId: string };
  payment_intent_data: { metadata: { invoiceId: string; entityId: string } };
  success_url: string;
  cancel_url: string;
  expires_at: number;
}

export interface CheckoutInput {
  invoiceId: string;
  entityId: string;
  displayNumber: string;
  balanceCents: number;
  /** The app origin from resolveAppBaseUrl (no trailing slash). */
  baseUrl: string;
  nowMs: number;
}

export function checkoutBucket(nowMs: number): number {
  return Math.floor(nowMs / CHECKOUT_BUCKET_MS);
}

/** The idempotency key (and the `checkout_started` event key) for one invoice, balance and time bucket. */
export function checkoutKey(invoiceId: string, balanceCents: number, bucket: number): string {
  return `checkout:${invoiceId}:${balanceCents}:${bucket}`;
}

export function buildCheckoutParams(i: CheckoutInput): { params: CheckoutCreateParams; idempotencyKey: string; bucket: number } {
  if (!Number.isSafeInteger(i.balanceCents) || i.balanceCents <= 0) throw new Error("checkout amount must be a positive whole number of cents");
  const bucket = checkoutBucket(i.nowMs);
  const bucketStartS = Math.floor((bucket * CHECKOUT_BUCKET_MS) / 1000);
  const base = i.baseUrl.replace(/\/+$/, "");
  const ids = { invoiceId: i.invoiceId, entityId: i.entityId };
  const params: CheckoutCreateParams = {
    mode: "payment",
    allowed_payment_method_types: ["card", "us_bank_account"],
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: i.balanceCents, product_data: { name: `Invoice ${i.displayNumber}` } } }],
    client_reference_id: i.invoiceId,
    metadata: { ...ids },
    payment_intent_data: { metadata: { ...ids } },
    success_url: `${base}/i/paid`,
    cancel_url: `${base}/i/cancelled`,
    expires_at: bucketStartS + CHECKOUT_SESSION_LIFETIME_S,
  };
  return { params, idempotencyKey: checkoutKey(i.invoiceId, i.balanceCents, bucket), bucket };
}
