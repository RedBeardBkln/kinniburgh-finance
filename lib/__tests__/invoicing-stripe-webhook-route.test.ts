// The Stripe webhook route (plan P7, S7), end to end over the in-memory fake db with the REAL signature check (the SDK's
// generateTestHeaderString + constructEvent through lib/invoicing/stripe/client.ts), the real decision, store and loaders. Only the two
// Stripe API reads (session, fee) are mocked. The webhook secret is an obviously fake string built at run time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const CLIENT = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const SECRET = "whsec" + "_" + "z".repeat(32);
const ENV_KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_MODE"] as const;
const saved: Record<string, string | undefined> = {};

function seed() {
  process.env.STRIPE_SECRET_KEY = "rk_" + "test_" + "x".repeat(24);
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.STRIPE_MODE = "test";
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting", dbaName: null, archivedAt: null }];
  fake.invoicingProfile.rows = [{ id: "p1", entityId: E, enabled: true, stripePayEnabled: true, publicTokenTtlDays: 90 }];
  fake.client.rows = [{ id: CLIENT, entityId: E, name: "Acme", archivedAt: null }];
  fake.billingDocument.rows = [{ id: DOC, entityId: E, kind: "invoice", clientId: CLIENT, status: "issued", number: 3100, displayNumber: "3100", archivedAt: null, totalCents: 10_000, issueDate: new Date("2026-10-20T00:00:00Z") }];
  for (const t of [fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.stripeEvent, fake.auditLog, fake.billingAccessToken]) t.rows = [];
}

const session = (over: Partial<CheckoutSessionLite> = {}): CheckoutSessionLite => ({
  id: "cs_test_a1",
  paymentStatus: "paid",
  amountTotal: 10_000,
  currency: "usd",
  livemode: false,
  clientReferenceId: DOC,
  metadata: { invoiceId: DOC, entityId: E },
  paymentIntentId: "pi_test_a1",
  ...over,
});

function eventBody(over: { id?: string; type?: string; livemode?: boolean; created?: number; object?: Record<string, unknown> | null } = {}) {
  const ev: Record<string, unknown> = {
    id: over.id ?? "evt_test_1",
    object: "event",
    type: over.type ?? "checkout.session.completed",
    livemode: over.livemode ?? false,
    created: over.created ?? Math.floor(Date.UTC(2026, 9, 23, 15, 0, 0) / 1000),
    api_version: "2026-09-30.endive",
    data: over.object === null ? {} : { object: over.object ?? { id: "cs_test_a1", object: "checkout.session" } },
  };
  return JSON.stringify(ev);
}

function request(body: string, opts: { signature?: string | null; secret?: string; timestamp?: number } = {}) {
  const sig = opts.signature !== undefined ? opts.signature : Stripe.webhooks.generateTestHeaderString({ payload: body, secret: opts.secret ?? SECRET, timestamp: opts.timestamp });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig !== null) headers["stripe-signature"] = sig;
  return new Request("https://finance.example.test/api/stripe/webhook", { method: "POST", body, headers });
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  seed();
  sessionMock.mockReset();
  feeMock.mockReset();
  sessionMock.mockResolvedValue(session());
  feeMock.mockResolvedValue({ feeCents: 320, chargeId: "ch_test_a1", methodType: "card" });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const nothingWritten = () => {
  expect(fake.stripeEvent.rows).toHaveLength(0);
  expect(fake.billingPayment.rows).toHaveLength(0);
  expect(fake.billingEvent.rows).toHaveLength(0);
};

describe("signature first", () => {
  it("a wrong secret, a tampered body, a missing header and a stale timestamp are 400 and change nothing", async () => {
    const body = eventBody();
    expect((await POST(request(body, { secret: "whsec" + "_" + "w".repeat(32) }))).status).toBe(400);
    const sig = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
    expect((await POST(request(body.replace("evt_test_1", "evt_test_9"), { signature: sig }))).status).toBe(400); // a tampered body
    expect((await POST(request(`${body} `, { signature: sig }))).status).toBe(400);
    expect((await POST(request(body, { signature: null }))).status).toBe(400);
    expect((await POST(request(body, { timestamp: Math.floor(Date.now() / 1000) - 400 }))).status).toBe(400);
    expect(sessionMock).not.toHaveBeenCalled();
    nothingWritten();
  });
  it("an unconfigured environment answers 503 (Stripe retries) and reads nothing", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect((await POST(request(eventBody()))).status).toBe(503);
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    process.env.STRIPE_MODE = "live";
    expect((await POST(request(eventBody()))).status).toBe(503); // a test key with STRIPE_MODE=live is a mode mix-up
    nothingWritten();
  });
  it("a livemode event in test mode is ignored with 200; an unhandled type is 200 with nothing written", async () => {
    expect((await POST(request(eventBody({ livemode: true })))).status).toBe(200);
    expect((await POST(request(eventBody({ type: "customer.created" })))).status).toBe(200);
    expect(sessionMock).not.toHaveBeenCalled();
    nothingWritten();
  });
  it("an event without data.object (e.g. a thin event) is stored as unsupported_format, never paid", async () => {
    expect((await POST(request(eventBody({ object: null })))).status).toBe(200);
    expect(fake.stripeEvent.rows).toMatchObject([{ id: "evt_test_1", outcome: "unsupported_format" }]);
    expect(fake.billingPayment.rows).toHaveLength(0);
  });
});

describe("recording", () => {
  it("a paid card session records ONE payment; a replay of the same event records nothing more", async () => {
    const body = eventBody();
    expect((await POST(request(body))).status).toBe(200);
    expect((await POST(request(body))).status).toBe(200);
    expect(fake.billingPayment.rows).toHaveLength(1);
    expect(fake.billingPayment.rows[0]).toMatchObject({ source: "stripe", method: "card", amountCents: 10_000, feeCents: 320, stripeFeeStatus: "known", stripePaymentIntentId: "pi_test_a1", createdById: null, requestKey: null });
    expect(fake.billingAllocation.rows).toMatchObject([{ invoiceId: DOC, amountCents: 10_000 }]);
    expect(fake.stripeEvent.rows).toMatchObject([{ id: "evt_test_1", outcome: "recorded" }]);
    expect(sessionMock).toHaveBeenCalledTimes(1); // the replay stopped at the "already processed" check
  });
  it("a Stripe read failure is transient: 500 and nothing written", async () => {
    sessionMock.mockRejectedValueOnce(Object.assign(new Error("down"), { name: "StripeConnectionError" }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await POST(request(eventBody()))).status).toBe(500);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("evt_test_1");
    spy.mockRestore();
    nothingWritten();
  });
  it("a fee read failure still records the payment, with the fee unknown", async () => {
    feeMock.mockRejectedValueOnce(new Error("no permission"));
    expect((await POST(request(eventBody()))).status).toBe(200);
    expect(fake.billingPayment.rows[0]).toMatchObject({ feeCents: 0, stripeFeeStatus: "unknown", method: "card" });
  });
  it("ACH: completed-unpaid waits, async success records once (method ach), and a late completed+paid is a duplicate", async () => {
    sessionMock.mockResolvedValue(session({ paymentStatus: "unpaid" }));
    expect((await POST(request(eventBody({ id: "evt_1" })))).status).toBe(200);
    expect(fake.billingPayment.rows).toHaveLength(0);
    sessionMock.mockResolvedValue(session());
    feeMock.mockResolvedValue({ feeCents: 5, chargeId: "py_1", methodType: "us_bank_account" });
    expect((await POST(request(eventBody({ id: "evt_2", type: "checkout.session.async_payment_succeeded" })))).status).toBe(200);
    expect((await POST(request(eventBody({ id: "evt_3" })))).status).toBe(200);
    expect(fake.billingPayment.rows).toHaveLength(1);
    expect(fake.billingPayment.rows[0]).toMatchObject({ method: "ach" });
    expect(fake.stripeEvent.rows.map((r) => [r.id, r.outcome])).toEqual([
      ["evt_1", "awaiting_async"],
      ["evt_2", "recorded"],
      ["evt_3", "duplicate_payment"],
    ]);
  });
  it("a refund only flags (the payment and its application stay)", async () => {
    await POST(request(eventBody()));
    const body = eventBody({ id: "evt_refund", type: "charge.refunded", object: { id: "ch_test_a1", object: "charge", payment_intent: "pi_test_a1", amount_refunded: 10_000 } });
    expect((await POST(request(body))).status).toBe(200);
    expect(fake.billingPayment.rows[0]!.status).toBe("recorded");
    expect(fake.billingAllocation.rows[0]!.voidedAt).toBeNull();
    expect(fake.billingEvent.rows.filter((e) => e.kind === "stripe_flag").map((e) => e.data)).toEqual([{ reason: "refunded", amountCents: 10_000 }]);
  });
});

describe("source pins", () => {
  const src = readFileSync(join(process.cwd(), "app/api/stripe/webhook/route.ts"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const body = code.slice(code.indexOf("export async function POST"));
  it("reads the raw body, then verifies the signature, before any load / store call or JSON parse", () => {
    const raw = body.indexOf("await req.text()");
    const verify = body.indexOf("verifyStripeEvent(raw, signature");
    expect(raw).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(raw);
    for (const later of [/\bstore\./, /\bload\w+\(/, /JSON\.parse/, /retrieve\w+\(/]) {
      const i = body.search(later);
      if (i !== -1) expect(i, String(later)).toBeGreaterThan(verify);
    }
    expect(code).not.toMatch(/JSON\.parse|req\.json\(\)/);
  });
  it("never calls auth(), opens with the sanctioned-exception comment, exports POST only and runs on Node", () => {
    expect(code).not.toMatch(/\bauth\(\)|@\/lib\/auth/);
    expect(src.trimStart().startsWith("// SANCTIONED EXCEPTION")).toBe(true);
    expect(code).not.toMatch(/export async function (GET|PUT|PATCH|DELETE)/);
    expect(code).toMatch(/export const runtime = "nodejs"/);
    expect(code).toMatch(/export const dynamic = "force-dynamic"/);
  });
  it("logs only static strings and error names", () => {
    for (const m of code.matchAll(/console\.(error|warn|info|log)\(([^;]*)\);/g)) {
      expect(m[2], m[0]).toMatch(/^"[^"]*"(, err instanceof Error \? err\.name : "UnknownError")?$/);
    }
  });
});
