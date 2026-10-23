// SANCTIONED EXCEPTION to "every route starts with auth()": the Stripe webhook for EK Consulting invoice payments. Stripe has no session;
// the middleware lets exactly /api/stripe/webhook through (see middleware.ts), and the security boundary is the SIGNATURE: the raw body is
// read first and verified with the endpoint secret (STRIPE_WEBHOOK_SECRET) before anything else is parsed, read or written (a source test
// pins the order). A bad, missing or stale signature is a 400 and changes nothing.
//
// Then: an event whose livemode disagrees with STRIPE_MODE is ignored (200); only five event types are handled; the Checkout Session is
// RE-FETCHED from the API (snapshot payloads can be stale) and a payment is recorded only when it says "paid"; refunds, disputes and
// failed bank payments only raise flags. Every decided event is stored once (StripeEvent, keyed by the Stripe event id) in the same
// transaction as the payment, so a replay or a completed + async pair records ONE payment. A transient failure (Stripe unreachable, a
// database error) answers 500 so Stripe retries; every decided outcome, including "unmatched", answers 200.
//
// Logs: static strings and error NAMES only; never the body, Stripe ids, amounts, the signature or the secret. No AuditLog (no user).

import { NextResponse } from "next/server";
import { loadInvoiceForStripe, loadStripeEventSeen, loadStripePaymentByIntent } from "@/lib/invoicing/pay-build";
import * as store from "@/lib/invoicing/store";
import { decideStripeEvent, isCheckoutEvent, isHandledStripeEvent, paymentMethodFor, type Decision } from "@/lib/invoicing/stripe/apply-event";
import { retrieveCheckoutSession, retrievePaymentIntentFee, verifyStripeEvent, type PaymentIntentFee, type VerifiedStripeEvent } from "@/lib/invoicing/stripe/client";
import { stripePreflight } from "@/lib/invoicing/stripe/preflight";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const reply = (status: number) => NextResponse.json({ received: status === 200 }, { status, headers: { "Cache-Control": "no-store" } });

/** The id of an expandable Stripe field (a string id, or an object with an id). */
function idOf(v: unknown): string | null {
  if (typeof v === "string" && v !== "") return v;
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") return (v as { id: string }).id;
  return null;
}
const centsOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get("stripe-signature");
  const pre = stripePreflight(process.env);
  if (!pre.ok) return reply(503);
  if (!signature) return reply(400);
  let event: VerifiedStripeEvent;
  try {
    event = verifyStripeEvent(raw, signature, (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim());
  } catch {
    return reply(400);
  }

  if (event.livemode !== (pre.mode === "live")) {
    console.warn("stripe webhook: mode mismatch ignored");
    return reply(200);
  }
  if (!isHandledStripeEvent(event.type)) return reply(200);
  const meta = { eventId: event.id, type: event.type, livemode: event.livemode };

  try {
    const objectId = event.object ? idOf(event.object.id) : null;
    if (!event.object || !objectId) {
      await store.recordStripeEventOnly(meta, "unsupported_format");
      return reply(200);
    }
    if (await loadStripeEventSeen(event.id)) return reply(200);

    let decision: Decision;
    if (isCheckoutEvent(event.type)) {
      // Network read BEFORE any transaction; a failure is transient (500, Stripe retries).
      const session = await retrieveCheckoutSession(objectId);
      const invoiceId = session.metadata.invoiceId ?? "";
      const invoice = invoiceId !== "" ? await loadInvoiceForStripe(invoiceId) : null;
      decision = decideStripeEvent({ type: event.type, created: event.created, session, invoice });
    } else {
      const paymentIntentId = idOf(event.object.payment_intent);
      const amountCents = event.type === "charge.refunded" ? centsOf(event.object.amount_refunded) : centsOf(event.object.amount);
      const payment = paymentIntentId ? await loadStripePaymentByIntent(paymentIntentId) : null;
      decision = decideStripeEvent({ type: event.type, paymentIntentId, amountCents, payment });
    }

    switch (decision.action) {
      case "record_payment": {
        let fee: PaymentIntentFee = { feeCents: null, chargeId: null, methodType: null };
        try {
          fee = await retrievePaymentIntentFee(decision.paymentIntentId);
        } catch (err) {
          // The fee is not worth a retry: the payment is recorded with the fee "unknown" and the owner can fetch it later.
          console.warn("stripe webhook: fee not read", err instanceof Error ? err.name : "UnknownError");
        }
        await store.applyStripePayment(meta, {
          entityId: decision.entityId,
          invoiceId: decision.invoiceId,
          amountCents: decision.amountCents,
          paymentIntentId: decision.paymentIntentId,
          sessionId: decision.sessionId,
          receivedOn: decision.receivedOn,
          method: paymentMethodFor(fee.methodType, decision.defaultMethod),
          feeCents: fee.feeCents,
          chargeId: fee.chargeId,
        });
        break;
      }
      case "flag":
        await store.applyStripeFlag(meta, { entityId: decision.entityId, reason: decision.reason, documentIds: decision.documentIds, paymentId: decision.paymentId, amountCents: decision.amountCents });
        break;
      case "noop":
        await store.recordStripeEventOnly(meta, decision.outcome, { entityId: decision.entityId, documentId: decision.documentId });
        break;
      case "unmatched":
        await store.recordStripeEventOnly(meta, decision.outcome);
        break;
    }
    return reply(200);
  } catch (err) {
    console.error("stripe webhook failed", err instanceof Error ? err.name : "UnknownError");
    return reply(500);
  }
}
