// Tester (ek-consulting-stripe-pay-link, 2026-10-23): extra end-to-end webhook scenarios through the REAL route, signature, decision,
// store and loaders over the in-memory fake db. Only the two Stripe API reads are mocked. Fills route-level gaps the Coder's suite covers
// only in the pure / store layers: disputes (a Dispute object, not a Charge), ACH failure, resolution mismatches, overpayment, the
// toggle being off, live mode, unknown-PaymentIntent refunds, a void invoice, and that nothing from the event ever reaches a log line.
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});
vi.mock("@/lib/invoicing/stripe/client", async (orig) => {
  const actual = await orig<typeof import("@/lib/invoicing/stripe/client")>();
  return { ...actual, retrieveCheckoutSession: vi.fn(), retrievePaymentIntentFee: vi.fn(), createCheckoutSession: vi.fn() };
});

import { db } from "@/lib/db";
import { POST } from "@/app/api/stripe/webhook/route";
import { retrieveCheckoutSession, retrievePaymentIntentFee, type CheckoutSessionLite } from "@/lib/invoicing/stripe/client";

const fake = db as unknown as FakeDb;
const sessionMock = vi.mocked(retrieveCheckoutSession);
const feeMock = vi.mocked(retrievePaymentIntentFee);
const E = "11111111-1111-4111-8111-111111111111";
const E2 = "44444444-4444-4444-8444-444444444444";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const SECRET = "whsec" + "_" + "q".repeat(32);
const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_MODE"] as const;
const saved: Record<string, string | undefined> = {};

function seed(mode: "test" | "live" = "test", stripePayEnabled = true) {
  process.env.STRIPE_SECRET_KEY = (mode === "live" ? "rk_" + "live_" : "rk_" + "test_") + "y".repeat(24);
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.STRIPE_MODE = mode;
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting", dbaName: null, archivedAt: null }];
  fake.invoicingProfile.rows = [{ id: "p1", entityId: E, enabled: true, stripePayEnabled, publicTokenTtlDays: 90 }];
  fake.client.rows = [{ id: CLIENT, entityId: E, name: "Acme", archivedAt: null }];
  fake.billingDocument.rows = [
    { id: DOC, entityId: E, kind: "invoice", clientId: CLIENT, status: "issued", number: 3100, displayNumber: "3100", archivedAt: null, totalCents: 10_000, issueDate: new Date("2026-10-20T00:00:00Z") },
  ];
  for (const t of [fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.stripeEvent, fake.auditLog, fake.billingAccessToken]) t.rows = [];
}

const session = (over: Partial<CheckoutSessionLite> = {}): CheckoutSessionLite => ({
  id: "cs_test_t1",
  paymentStatus: "paid",
  amountTotal: 10_000,
  currency: "usd",
  livemode: false,
  clientReferenceId: DOC,
  metadata: { invoiceId: DOC, entityId: E },
  paymentIntentId: "pi_test_t1",
  ...over,
});

function body(over: { id?: string; type?: string; livemode?: boolean; object?: Record<string, unknown> } = {}) {
  return JSON.stringify({
    id: over.id ?? "evt_t_1",
    object: "event",
    type: over.type ?? "checkout.session.completed",
    livemode: over.livemode ?? false,
    created: Math.floor(Date.UTC(2026, 9, 23, 15, 0, 0) / 1000),
    api_version: "2026-09-30.endive",
    data: { object: over.object ?? { id: "cs_test_t1", object: "checkout.session" } },
  });
}
const req = (b: string) =>
  new Request("https://finance.example.test/api/stripe/webhook", {
    method: "POST",
    body: b,
    headers: { "content-type": "application/json", "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload: b, secret: SECRET }) },
  });

let logSpies: { mock: { calls: unknown[][] }; mockRestore: () => void }[] = [];
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  seed();
  sessionMock.mockReset();
  feeMock.mockReset();
  sessionMock.mockResolvedValue(session());
  feeMock.mockResolvedValue({ feeCents: 320, chargeId: "ch_test_t1", methodType: "card" });
  logSpies = (["error", "warn", "log", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => {
  // Nothing from an event (ids, amounts, the secret) ever reaches a log line.
  const logged = JSON.stringify(logSpies.flatMap((s) => s.mock.calls));
  for (const needle of ["evt_t_", "pi_test_", "cs_test_", "ch_test_", "dp_test_", SECRET, "10000", "12500"]) expect(logged).not.toContain(needle);
  for (const s of logSpies) s.mockRestore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const outcomes = () => fake.stripeEvent.rows.map((r) => r.outcome);
const flags = () => fake.billingEvent.rows.filter((e) => e.kind === "stripe_flag").map((e) => e.data);

describe("webhook end-to-end (tester additions)", () => {
  it("a dispute (a Dispute object: amount + payment_intent) only flags the payment and its invoice; a replay adds nothing", async () => {
    expect((await POST(req(body()))).status).toBe(200);
    const b = body({ id: "evt_t_dispute", type: "charge.dispute.created", object: { id: "dp_test_1", object: "dispute", payment_intent: "pi_test_t1", charge: "ch_test_t1", amount: 10_000 } });
    expect((await POST(req(b))).status).toBe(200);
    expect(fake.billingPayment.rows).toHaveLength(1);
    expect(fake.billingPayment.rows[0]!.status).toBe("recorded");
    expect(fake.billingAllocation.rows.every((a) => !a.voidedAt)).toBe(true);
    expect(flags()).toEqual([{ reason: "disputed", amountCents: 10_000 }]);
    expect(fake.billingEvent.rows.find((e) => e.kind === "stripe_flag")!.documentId).toBe(DOC);
    expect((await POST(req(b))).status).toBe(200);
    expect(flags()).toHaveLength(1);
  });

  it("an ACH failure flags the invoice and records no payment", async () => {
    sessionMock.mockResolvedValue(session({ paymentStatus: "unpaid" }));
    expect((await POST(req(body({ id: "evt_t_fail", type: "checkout.session.async_payment_failed" })))).status).toBe(200);
    expect(fake.billingPayment.rows).toHaveLength(0);
    // The failed bank payment now carries its PaymentIntent (it closes that payment's "processing" row; stripe-ach-pending-hide-pay).
    expect(flags()).toEqual([{ reason: "ach_failed", amountCents: 10_000, paymentIntentId: "pi_test_t1" }]);
    expect(outcomes()).toEqual(["flagged"]);
  });

  it("another entity, another client_reference_id, a non-USD currency, no metadata, a zero amount or no_payment_required are unmatched (200, nothing paid)", async () => {
    const cases: [Partial<CheckoutSessionLite>, string][] = [
      [{ metadata: { invoiceId: DOC, entityId: E2 } }, "unmatched_invoice"],
      [{ clientReferenceId: "55555555-5555-4555-8555-555555555555" }, "unmatched_reference"],
      [{ currency: "eur" }, "unmatched_currency"],
      [{ metadata: {} }, "unmatched_metadata"],
      [{ amountTotal: 0 }, "unmatched_amount"],
      [{ paymentStatus: "no_payment_required" }, "unmatched_status"],
    ];
    let i = 0;
    for (const [over, outcome] of cases) {
      sessionMock.mockResolvedValueOnce(session(over));
      expect((await POST(req(body({ id: `evt_t_u${i++}` })))).status).toBe(200);
      expect(fake.stripeEvent.rows.at(-1)!.outcome, outcome).toBe(outcome);
    }
    expect(fake.billingPayment.rows).toHaveLength(0);
    expect(fake.billingAllocation.rows).toHaveLength(0);
  });

  it("an overpayment applies the balance and leaves the rest on account with a flag (integer cents)", async () => {
    sessionMock.mockResolvedValue(session({ amountTotal: 12_500 }));
    expect((await POST(req(body()))).status).toBe(200);
    expect(fake.billingPayment.rows[0]).toMatchObject({ amountCents: 12_500, source: "stripe" });
    expect(fake.billingAllocation.rows).toMatchObject([{ amountCents: 10_000 }]);
    expect(flags()).toEqual([{ reason: "overpayment", amountCents: 2_500 }]);
    expect(outcomes()).toEqual(["recorded_with_flag"]);
  });

  it("with Online payments switched OFF the money already taken is still recorded", async () => {
    seed("test", false);
    expect((await POST(req(body()))).status).toBe(200);
    expect(fake.billingPayment.rows).toHaveLength(1);
  });

  it("live mode: a test-mode event is ignored, a live event is processed", async () => {
    seed("live");
    expect((await POST(req(body({ livemode: false })))).status).toBe(200);
    expect(fake.stripeEvent.rows).toHaveLength(0);
    expect(sessionMock).not.toHaveBeenCalled();
    expect((await POST(req(body({ id: "evt_t_live", livemode: true })))).status).toBe(200);
    expect(fake.billingPayment.rows).toHaveLength(1);
  });

  it("a refund for a PaymentIntent we never recorded is stored as unmatched_payment and changes nothing", async () => {
    const b = body({ id: "evt_t_ref", type: "charge.refunded", object: { id: "ch_test_x", object: "charge", payment_intent: "pi_test_unknown", amount_refunded: 500 } });
    expect((await POST(req(b))).status).toBe(200);
    expect(outcomes()).toEqual(["unmatched_payment"]);
    expect(fake.billingEvent.rows).toHaveLength(0);
  });

  it("a void invoice: the whole amount stays unapplied for the client, flagged invoice_not_open", async () => {
    fake.billingDocument.rows[0]!.status = "void";
    expect((await POST(req(body()))).status).toBe(200);
    expect(fake.billingPayment.rows).toHaveLength(1);
    expect(fake.billingAllocation.rows).toHaveLength(0);
    expect(flags()).toEqual([{ reason: "invoice_not_open", amountCents: 10_000 }]);
  });

  it("a signature made with ANOTHER endpoint's secret is refused even with a fresh timestamp", async () => {
    const b = body();
    const sig = Stripe.webhooks.generateTestHeaderString({ payload: b, secret: "whsec" + "_" + "r".repeat(32) });
    const r = await POST(new Request("https://finance.example.test/api/stripe/webhook", { method: "POST", body: b, headers: { "stripe-signature": sig } }));
    expect(r.status).toBe(400);
    expect(fake.stripeEvent.rows).toHaveLength(0);
    expect(sessionMock).not.toHaveBeenCalled();
  });
});
