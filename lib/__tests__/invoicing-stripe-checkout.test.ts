// "Pay online": the pure Checkout Session parameters and the token-gated startCheckout action (plan P6, S6). The Stripe client wrapper is
// mocked (no network); the fake db, the token gate, the eligibility rule and the store run for real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/invoicing/stripe/client", () => ({ createCheckoutSession: vi.fn(), retrieveCheckoutSession: vi.fn(), retrievePaymentIntentFee: vi.fn(), verifyStripeEvent: vi.fn() }));

import { db } from "@/lib/db";
import { startCheckout } from "@/actions/public-invoice";
import { mintInvoiceToken } from "@/lib/invoicing/access-token";
import { CHECKOUT_BUCKET_MS } from "@/lib/invoicing/constants";
import { buildCheckoutParams, checkoutKey } from "@/lib/invoicing/stripe/checkout-params";
import { createCheckoutSession } from "@/lib/invoicing/stripe/client";
import { payOnlineEligibility } from "@/lib/invoicing/stripe/eligibility";

const fake = db as unknown as FakeDb;
const createMock = vi.mocked(createCheckoutSession);
const E = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const BASE = "https://finance.example.test";

describe("buildCheckoutParams (pure)", () => {
  const fixed = { invoiceId: DOC, entityId: E, displayNumber: "3100", balanceCents: 75_000, baseUrl: BASE, nowMs: Date.UTC(2026, 9, 23, 15, 7, 30) };
  it("builds the exact parameters for a fixed input", () => {
    const { params, idempotencyKey, bucket } = buildCheckoutParams(fixed);
    const bucketStartS = Math.floor((bucket * CHECKOUT_BUCKET_MS) / 1000);
    expect(params).toEqual({
      mode: "payment",
      allowed_payment_method_types: ["card", "us_bank_account"],
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 75_000, product_data: { name: "Invoice 3100" } } }],
      client_reference_id: DOC,
      metadata: { invoiceId: DOC, entityId: E },
      payment_intent_data: { metadata: { invoiceId: DOC, entityId: E } },
      success_url: `${BASE}/i/paid`,
      cancel_url: `${BASE}/i/cancelled`,
      expires_at: bucketStartS + 7200,
    });
    expect(idempotencyKey).toBe(`checkout:${DOC}:75000:${bucket}`);
    expect(JSON.stringify(params)).not.toMatch(/\/i\/[A-Za-z0-9_-]{20,}/); // no token ever reaches Stripe
  });
  it("two calls in the same bucket give identical parameters and key; another balance or bucket changes the key", () => {
    const a = buildCheckoutParams(fixed);
    const b = buildCheckoutParams({ ...fixed, nowMs: fixed.nowMs + 1000 });
    expect(b).toEqual(a);
    expect(buildCheckoutParams({ ...fixed, balanceCents: 75_001 }).idempotencyKey).not.toBe(a.idempotencyKey);
    expect(buildCheckoutParams({ ...fixed, nowMs: fixed.nowMs + CHECKOUT_BUCKET_MS }).idempotencyKey).not.toBe(a.idempotencyKey);
    expect(checkoutKey(DOC, 1, 2)).toBe(`checkout:${DOC}:1:2`);
  });
  it("expires_at is always 30 minutes to 24 hours after creation, for any moment of the bucket", () => {
    for (let i = 0; i < 2000; i += 1) {
      const nowMs = Date.UTC(2026, 0, 1) + Math.floor(Math.random() * 400 * 86_400_000);
      const { params } = buildCheckoutParams({ ...fixed, nowMs });
      const delta = params.expires_at - nowMs / 1000;
      expect(delta).toBeGreaterThanOrEqual(1800);
      expect(delta).toBeLessThanOrEqual(86_400);
    }
  });
  it("refuses a non-positive or fractional amount", () => {
    for (const b of [0, -1, 1.5]) expect(() => buildCheckoutParams({ ...fixed, balanceCents: b })).toThrow();
  });
});

describe("payOnlineEligibility (pure)", () => {
  const ok = { enabled: true, configured: true, baseUrl: BASE, status: "issued", balanceCents: 100, bankPending: false };
  it("one table of reasons", () => {
    expect(payOnlineEligibility(ok)).toEqual({ ok: true });
    expect(payOnlineEligibility({ ...ok, enabled: false })).toEqual({ ok: false, reason: "off" });
    expect(payOnlineEligibility({ ...ok, configured: false })).toEqual({ ok: false, reason: "not_configured" });
    expect(payOnlineEligibility({ ...ok, baseUrl: null })).toEqual({ ok: false, reason: "no_base_url" });
    expect(payOnlineEligibility({ ...ok, status: "void" })).toEqual({ ok: false, reason: "not_issued" });
    expect(payOnlineEligibility({ ...ok, balanceCents: 0 })).toEqual({ ok: false, reason: "no_balance" });
    expect(payOnlineEligibility({ ...ok, balanceCents: 49 })).toEqual({ ok: false, reason: "below_minimum" });
    expect(payOnlineEligibility({ ...ok, balanceCents: 50 })).toEqual({ ok: true });
    expect(payOnlineEligibility({ ...ok, bankPending: true })).toEqual({ ok: false, reason: "bank_payment_pending" });
  });
});

describe("startCheckout (token-gated)", () => {
  const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_MODE", "NEXTAUTH_URL", "VERCEL_ENV", "INVOICE_PUBLIC_BASE_URL"] as const;
  const saved: Record<string, string | undefined> = {};
  let token = "";
  function seed() {
    process.env.STRIPE_SECRET_KEY = "sk_" + "test_" + "x".repeat(24);
    process.env.STRIPE_WEBHOOK_SECRET = "whsec" + "_" + "y".repeat(24);
    process.env.STRIPE_MODE = "test";
    process.env.NEXTAUTH_URL = BASE;
    delete process.env.VERCEL_ENV;
    delete process.env.INVOICE_PUBLIC_BASE_URL;
    fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting", dbaName: null, archivedAt: null }];
    fake.invoicingProfile.rows = [{ id: "p1", entityId: E, enabled: true, stripePayEnabled: true, publicTokenTtlDays: 90 }];
    fake.client.rows = [{ id: CLIENT, entityId: E, name: "Acme", archivedAt: null }];
    fake.billingDocument.rows = [
      { id: DOC, entityId: E, kind: "invoice", clientId: CLIENT, status: "issued", number: 3100, displayNumber: "3100", archivedAt: null, totalCents: 10_000, subtotalCents: 10_000, discountCents: 0, sendCount: 0, sentAt: null, dueDate: null, issueDate: new Date("2026-10-20T00:00:00Z"), createdAt: new Date("2026-10-20T00:00:00Z"), updatedAt: new Date("2026-10-20T00:00:00Z") },
    ];
    fake.billingAllocation.rows = [{ id: "al1", entityId: E, invoiceId: DOC, paymentId: "p", amountCents: 2_500, appliedOn: new Date(), voidedAt: null }];
    for (const t of [fake.billingAccessToken, fake.billingEvent, fake.auditLog, fake.stripeEvent]) t.rows = [];
    const m = mintInvoiceToken();
    token = m.token;
    fake.billingAccessToken.rows.push({ id: "tok1", entityId: E, documentId: DOC, tokenHash: m.tokenHash, mintKey: null, purpose: "email", expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, viewCount: 0, firstViewedAt: null });
  }
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    seed();
    createMock.mockReset();
    createMock.mockResolvedValue({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("creates a session for the SERVER's current balance and records one checkout_started event per key", async () => {
    const r = await startCheckout(token);
    expect(r).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    expect(createMock).toHaveBeenCalledTimes(1);
    const [params, key] = createMock.mock.calls[0]!;
    expect(params.line_items[0]!.price_data.unit_amount).toBe(7_500);
    expect(params.client_reference_id).toBe(DOC);
    expect(key).toMatch(new RegExp(`^checkout:${DOC}:7500:\\d+$`));
    await startCheckout(token);
    expect(createMock.mock.calls[1]![1]).toBe(key); // same bucket, same balance -> same idempotency key
    const ev = fake.billingEvent.rows.filter((e) => e.kind === "checkout_started");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actorId: null, documentId: DOC, eventKey: key, data: { amountCents: 7_500 } });
    expect(fake.auditLog.rows).toHaveLength(0);
  });

  it.each([
    ["online payments off", () => (fake.invoicingProfile.rows[0]!.stripePayEnabled = false)],
    ["Stripe not configured", () => delete process.env.STRIPE_SECRET_KEY],
    ["no public address", () => delete process.env.NEXTAUTH_URL],
    ["an invalid INVOICE_PUBLIC_BASE_URL (no fallback to NEXTAUTH_URL)", () => (process.env.INVOICE_PUBLIC_BASE_URL = "https://pay.example.test/path")],
    ["a void invoice", () => (fake.billingDocument.rows[0]!.status = "void")],
    ["nothing due", () => (fake.billingAllocation.rows[0]!.amountCents = 10_000)],
    ["less than $0.50 due", () => (fake.billingAllocation.rows[0]!.amountCents = 9_951)],
    ["before the Phase-2 migration", () => delete fake.invoicingProfile.rows[0]!.stripePayEnabled],
  ])("refuses (%s) without calling Stripe", async (_label, change) => {
    change();
    const r = await startCheckout(token);
    expect(r).toEqual({ ok: false, error: "Online payment is not available for this invoice. Please contact the sender." });
    expect(createMock).not.toHaveBeenCalled();
    expect(fake.billingEvent.rows).toHaveLength(0);
  });

  it("a Stripe error gives the static sentence and logs only the error name", async () => {
    const err = new Error("secret detail that must not leak");
    err.name = "StripeConnectionError";
    createMock.mockRejectedValueOnce(err);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await startCheckout(token);
    expect(r).toEqual({ ok: false, error: "Online payment is not available right now. Please try again later." });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("StripeConnectionError");
    expect(logged).not.toContain("secret detail");
    expect(logged).not.toContain(token);
    spy.mockRestore();
    expect(fake.billingEvent.rows).toHaveLength(0);
  });

  it("with INVOICE_PUBLIC_BASE_URL set, Checkout returns to /i/paid and /i/cancelled on that origin", async () => {
    process.env.INVOICE_PUBLIC_BASE_URL = "https://pay.example.test";
    expect(await startCheckout(token)).toMatchObject({ ok: true });
    const [params] = createMock.mock.calls[0]!;
    expect(params.success_url).toBe("https://pay.example.test/i/paid");
    expect(params.cancel_url).toBe("https://pay.example.test/i/cancelled");
  });

  it("a non-https URL from Stripe is never handed to the browser", async () => {
    createMock.mockResolvedValueOnce({ id: "cs_x", url: "javascript:alert(1)" });
    expect(await startCheckout(token)).toEqual({ ok: false, error: "Online payment is not available right now. Please try again later." });
  });

  // stripe-ach-pending-hide-pay: a bank payment still processing pauses online payment on the server.
  describe("a bank (ACH) payment still processing", () => {
    const PAUSED = "A bank payment for this invoice is still processing, so online payment is paused. Please check back later or contact the sender.";
    const addPending = (over: Record<string, unknown> = {}) =>
      fake.billingEvent.rows.push({ id: "bp1", entityId: E, kind: "bank_payment_pending", actorId: null, documentId: DOC, paymentId: null, clientId: null, eventKey: "stripe:evt_1:bank_pending", createdAt: new Date(), data: { amountCents: 7_500, paymentIntentId: "pi_b1", livemode: false }, ...over });
    const started = () => fake.billingEvent.rows.filter((e) => e.kind === "checkout_started");

    it("refuses with its own sentence, never calls Stripe and records no checkout_started", async () => {
      addPending();
      expect(await startCheckout(token)).toEqual({ ok: false, error: PAUSED });
      expect(createMock).not.toHaveBeenCalled();
      expect(started()).toHaveLength(0);
    });
    it("still refuses past the 10-business-day cap (the cap is a label, never a re-enable)", async () => {
      addPending({ createdAt: new Date(Date.now() - 60 * 86_400_000) });
      expect(await startCheckout(token)).toEqual({ ok: false, error: PAUSED });
      expect(createMock).not.toHaveBeenCalled();
    });
    it.each([
      ["the payment was recorded (any status)", () => fake.billingPayment.rows.push({ id: "pay_b", entityId: E, status: "void", stripePaymentIntentId: "pi_b1", amountCents: 7_500 })],
      ["the bank payment failed", () => fake.billingEvent.rows.push({ id: "f1", entityId: E, kind: "stripe_flag", documentId: DOC, createdAt: new Date(), data: { reason: "ach_failed", amountCents: 7_500, paymentIntentId: "pi_b1" } })],
      ["the owner stopped waiting", () => fake.billingEvent.rows.push({ id: "r1", entityId: E, kind: "bank_payment_released", documentId: DOC, createdAt: new Date(), data: { pendingEventId: "bp1" } })],
      ["the row is a test-mode row and Stripe is live", () => {
        process.env.STRIPE_SECRET_KEY = "sk_" + "live_" + "x".repeat(24);
        process.env.STRIPE_MODE = "live";
      }],
    ])("proceeds once closed: %s", async (_l, close) => {
      addPending();
      close();
      const r = await startCheckout(token);
      expect(r).toMatchObject({ ok: true });
      expect(createMock).toHaveBeenCalledTimes(1);
    });
    it("open, uncompleted Checkout Sessions (checkout_started rows only) never block", async () => {
      fake.billingEvent.rows.push({ id: "cs1", entityId: E, kind: "checkout_started", documentId: DOC, createdAt: new Date(), eventKey: "checkout:x", data: { amountCents: 7_500 } });
      expect(await startCheckout(token)).toMatchObject({ ok: true });
    });
    it("a failed read fails CLOSED: the static unavailable sentence and no Stripe call", async () => {
      addPending();
      const real = fake.billingPayment.findMany.bind(fake.billingPayment);
      // Only the pending check's own read (payments by PaymentIntent) fails.
      const spy = vi.spyOn(fake.billingPayment, "findMany").mockImplementation(async (args) => {
        if (args && args.where && "stripePaymentIntentId" in args.where) throw Object.assign(new Error("db"), { name: "PrismaClientUnknownRequestError" });
        return real(args);
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await startCheckout(token)).toEqual({ ok: false, error: "Online payment is not available right now. Please try again later." });
      expect(createMock).not.toHaveBeenCalled();
      expect(started()).toHaveLength(0);
      spy.mockRestore();
      log.mockRestore();
    });
  });
});
