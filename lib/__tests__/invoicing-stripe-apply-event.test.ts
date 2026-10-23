import { describe, expect, it } from "vitest";
import { decideStripeEvent, paymentMethodFor, splitStripeAmount, type SessionFacts, type StripeInvoiceRef } from "@/lib/invoicing/stripe/apply-event";

// The webhook decision (plan P7.6), as a pure scenario table.

const E = "11111111-1111-4111-8111-111111111111";
const DOC = "33333333-3333-4333-8333-333333333333";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const created = Math.floor(Date.UTC(2026, 9, 23, 15, 0, 0) / 1000);

const session = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  id: "cs_1",
  paymentStatus: "paid",
  amountTotal: 10_000,
  currency: "usd",
  clientReferenceId: DOC,
  metadata: { invoiceId: DOC, entityId: E },
  paymentIntentId: "pi_1",
  ...over,
});
const invoice = (over: Partial<StripeInvoiceRef> = {}): StripeInvoiceRef => ({ id: DOC, entityId: E, kind: "invoice", status: "issued", clientId: CLIENT, allowListed: true, profileEnabled: true, ...over });

describe("checkout events", () => {
  it("card: completed + paid -> record, method card by default", () => {
    const d = decideStripeEvent({ type: "checkout.session.completed", created, session: session(), invoice: invoice() });
    expect(d).toMatchObject({ action: "record_payment", outcome: "recorded", invoiceId: DOC, entityId: E, clientId: CLIENT, amountCents: 10_000, paymentIntentId: "pi_1", sessionId: "cs_1", defaultMethod: "card" });
  });
  it("ACH: completed + unpaid -> awaiting_async; async_payment_succeeded + paid -> record, method ach", () => {
    expect(decideStripeEvent({ type: "checkout.session.completed", created, session: session({ paymentStatus: "unpaid" }), invoice: invoice() })).toEqual({ action: "noop", outcome: "awaiting_async", entityId: E, documentId: DOC, amountCents: 10_000, paymentIntentId: "pi_1" });
    expect(decideStripeEvent({ type: "checkout.session.async_payment_succeeded", created, session: session(), invoice: invoice() })).toMatchObject({ action: "record_payment", defaultMethod: "ach" });
    expect(decideStripeEvent({ type: "checkout.session.async_payment_succeeded", created, session: session({ paymentStatus: "unpaid" }), invoice: invoice() })).toEqual({ action: "unmatched", outcome: "unmatched_status" });
  });
  it("ACH failure -> a flag on the invoice, never a payment", () => {
    expect(decideStripeEvent({ type: "checkout.session.async_payment_failed", created, session: session({ paymentStatus: "unpaid" }), invoice: invoice() })).toEqual({
      action: "flag",
      outcome: "flagged",
      reason: "ach_failed",
      entityId: E,
      documentIds: [DOC],
      paymentId: null,
      amountCents: 10_000,
      paymentIntentId: "pi_1",
    });
  });
  it("the toggle being OFF does not block recording (the money was taken), but a disabled profile or another entity does", () => {
    expect(decideStripeEvent({ type: "checkout.session.completed", created, session: session(), invoice: invoice({ profileEnabled: false }) })).toEqual({ action: "unmatched", outcome: "unmatched_entity" });
    expect(decideStripeEvent({ type: "checkout.session.completed", created, session: session(), invoice: invoice({ allowListed: false }) })).toEqual({ action: "unmatched", outcome: "unmatched_entity" });
  });
  it.each([
    ["missing metadata", { session: session({ metadata: {} }) }, "unmatched_metadata"],
    ["missing entity id", { session: session({ metadata: { invoiceId: DOC } }) }, "unmatched_metadata"],
    ["client_reference_id mismatch", { session: session({ clientReferenceId: "other" }) }, "unmatched_reference"],
    ["unknown invoice", { invoice: null }, "unmatched_invoice"],
    ["entity mismatch", { invoice: invoice({ entityId: "e2" }) }, "unmatched_invoice"],
    ["a quote, not an invoice", { invoice: invoice({ kind: "quote" }) }, "unmatched_invoice"],
    ["non-usd", { session: session({ currency: "eur" }) }, "unmatched_currency"],
    ["zero amount", { session: session({ amountTotal: 0 }) }, "unmatched_amount"],
    ["no amount", { session: session({ amountTotal: null }) }, "unmatched_amount"],
    ["no PaymentIntent", { session: session({ paymentIntentId: null }) }, "unmatched_payment_intent"],
  ])("%s -> unmatched", (_l, over, outcome) => {
    const o = over as { session?: SessionFacts; invoice?: StripeInvoiceRef | null };
    const d = decideStripeEvent({ type: "checkout.session.completed", created, session: o.session ?? session(), invoice: "invoice" in o ? (o.invoice ?? null) : invoice() });
    expect(d).toEqual({ action: "unmatched", outcome });
  });
  it("receivedOn is the America/New_York calendar day of the event", () => {
    const at = (iso: string) => (decideStripeEvent({ type: "checkout.session.completed", created: Math.floor(Date.parse(iso) / 1000), session: session(), invoice: invoice() }) as { receivedOn: Date }).receivedOn.toISOString();
    expect(at("2026-11-01T03:30:00Z")).toBe("2026-10-31T00:00:00.000Z"); // 23:30 New York on Oct 31
    expect(at("2026-11-01T01:00:00Z")).toBe("2026-10-31T00:00:00.000Z"); // 01:00 UTC Nov 1 is still Oct 31 in New York
    expect(at("2026-11-01T05:00:00Z")).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("refunds and disputes", () => {
  const payment = { id: "pay1", entityId: E, invoiceIds: [DOC, DOC] };
  it("flag the payment found by its PaymentIntent and each invoice it is applied to; never a payment change", () => {
    expect(decideStripeEvent({ type: "charge.refunded", paymentIntentId: "pi_1", amountCents: 2_500, payment })).toEqual({ action: "flag", outcome: "flagged", reason: "refunded", entityId: E, documentIds: [DOC], paymentId: "pay1", amountCents: 2_500, paymentIntentId: null });
    expect(decideStripeEvent({ type: "charge.dispute.created", paymentIntentId: "pi_1", amountCents: 10_000, payment })).toMatchObject({ action: "flag", reason: "disputed", amountCents: 10_000, paymentIntentId: null });
  });
  it("an unknown PaymentIntent (or none) is unmatched", () => {
    expect(decideStripeEvent({ type: "charge.refunded", paymentIntentId: "pi_x", amountCents: 1, payment: null })).toEqual({ action: "unmatched", outcome: "unmatched_payment" });
    expect(decideStripeEvent({ type: "charge.dispute.created", paymentIntentId: null, amountCents: 1, payment })).toEqual({ action: "unmatched", outcome: "unmatched_payment" });
  });
});

describe("splitStripeAmount (applied under the invoice lock)", () => {
  it("amount <= balance: all applied", () => expect(splitStripeAmount(5_000, "issued", 10_000)).toEqual({ allocateCents: 5_000, remainderCents: 0, flag: null }));
  it("amount > balance: the balance is applied, the rest is a deposit on account, flagged", () =>
    expect(splitStripeAmount(10_000, "issued", 7_500)).toEqual({ allocateCents: 7_500, remainderCents: 2_500, flag: "overpayment" }));
  it("already paid in full meanwhile: nothing applied, all on account, flagged", () => expect(splitStripeAmount(10_000, "issued", 0)).toEqual({ allocateCents: 0, remainderCents: 10_000, flag: "overpayment" }));
  it("a void invoice: nothing applied, all on account, flagged", () => expect(splitStripeAmount(10_000, "void", 0)).toEqual({ allocateCents: 0, remainderCents: 10_000, flag: "invoice_not_open" }));
});

describe("paymentMethodFor", () => {
  it("maps the charge's method type, else the event's usual method", () => {
    expect(paymentMethodFor("card", "ach")).toBe("card");
    expect(paymentMethodFor("us_bank_account", "card")).toBe("ach");
    expect(paymentMethodFor(null, "ach")).toBe("ach");
    expect(paymentMethodFor("link", "card")).toBe("card");
  });
});
