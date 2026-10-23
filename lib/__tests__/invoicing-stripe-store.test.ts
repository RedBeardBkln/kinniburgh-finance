// The webhook's store functions (plan P7.7) over the in-memory fake db: one transaction, the StripeEvent row before the payment, the
// invoice locked before its balance is read, one payment per PaymentIntent, overpayments and closed invoices kept as visible deposits on
// account, replays answered "already processed", flags that reverse nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});

import { db } from "@/lib/db";
import * as store from "@/lib/invoicing/store";
import { assertSafeEventData } from "@/lib/invoicing/events";

const fake = db as unknown as FakeDb;
const E = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const DOC = "33333333-3333-4333-8333-333333333333";
const meta = (id = "evt_1", type = "checkout.session.completed") => ({ eventId: id, type, livemode: false });
const write = (over: Partial<store.StripePaymentWrite> = {}): store.StripePaymentWrite => ({
  entityId: E,
  invoiceId: DOC,
  amountCents: 10_000,
  paymentIntentId: "pi_1",
  sessionId: "cs_1",
  receivedOn: new Date("2026-10-23T00:00:00Z"),
  method: "card",
  feeCents: 320,
  chargeId: "ch_1",
  ...over,
});

beforeEach(() => {
  vi.restoreAllMocks();
  fake.billingDocument.rows = [{ id: DOC, entityId: E, kind: "invoice", clientId: CLIENT, status: "issued", totalCents: 10_000, issueDate: new Date("2026-10-25T00:00:00Z"), archivedAt: null }];
  for (const t of [fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.stripeEvent]) t.rows = [];
});

describe("applyStripePayment", () => {
  it("locks the invoice before reading the balance, writes the StripeEvent row before the payment, all in one transaction", async () => {
    const tx = vi.spyOn(fake, "$transaction");
    const raw = vi.spyOn(fake, "$queryRaw");
    const docRead = vi.spyOn(fake.billingDocument, "findFirst");
    const ev = vi.spyOn(fake.stripeEvent, "create");
    const pay = vi.spyOn(fake.billingPayment, "create");
    const r = await store.applyStripePayment(meta(), write());
    expect(r).toEqual({ status: "applied", outcome: "recorded", paymentId: expect.any(String) });
    expect(tx).toHaveBeenCalledTimes(1);
    expect(String(raw.mock.calls[0]![0].join("?"))).toMatch(/FROM "BillingDocument" WHERE "id" = \? FOR UPDATE/);
    expect(raw.mock.invocationCallOrder[0]!).toBeLessThan(docRead.mock.invocationCallOrder[0]!);
    expect(ev.mock.invocationCallOrder[0]!).toBeLessThan(pay.mock.invocationCallOrder[0]!);
    const p = fake.billingPayment.rows[0]!;
    expect(p).toMatchObject({ source: "stripe", method: "card", amountCents: 10_000, feeCents: 320, stripeFeeStatus: "known", stripePaymentIntentId: "pi_1", stripeCheckoutSessionId: "cs_1", stripeChargeId: "ch_1", createdById: null, requestKey: null, clientId: CLIENT });
    expect(fake.stripeEvent.rows[0]).toMatchObject({ id: "evt_1", outcome: "recorded", entityId: E, documentId: DOC, paymentId: p.id });
    // appliedOn is never before the issue date
    expect(fake.billingAllocation.rows[0]).toMatchObject({ amountCents: 10_000, appliedOn: new Date("2026-10-25T00:00:00Z"), createdById: null });
    for (const e of fake.billingEvent.rows) expect(() => assertSafeEventData(e.data as Record<string, unknown>)).not.toThrow();
    expect(fake.billingEvent.rows.map((e) => e.kind).sort()).toEqual(["allocated", "payment_recorded"]);
  });

  it("the same PaymentIntent from another event is a duplicate_payment (one payment only)", async () => {
    await store.applyStripePayment(meta("evt_1"), write());
    const r = await store.applyStripePayment(meta("evt_2", "checkout.session.async_payment_succeeded"), write());
    expect(r).toMatchObject({ status: "applied", outcome: "duplicate_payment" });
    expect(fake.billingPayment.rows).toHaveLength(1);
    expect(fake.stripeEvent.rows.map((x) => x.outcome)).toEqual(["recorded", "duplicate_payment"]);
  });

  it("a replay of the same event id is 'already processed' and writes nothing", async () => {
    await store.applyStripePayment(meta(), write());
    const before = JSON.stringify([fake.billingPayment.rows, fake.billingAllocation.rows, fake.billingEvent.rows, fake.stripeEvent.rows]);
    expect(await store.applyStripePayment(meta(), write({ paymentIntentId: "pi_other" }))).toEqual({ status: "already_processed" });
    expect(JSON.stringify([fake.billingPayment.rows, fake.billingAllocation.rows, fake.billingEvent.rows, fake.stripeEvent.rows])).toBe(before);
  });

  it("more than the balance: the balance is applied, the rest stays a deposit on account with an overpayment flag", async () => {
    fake.billingAllocation.rows.push({ id: "a0", entityId: E, invoiceId: DOC, paymentId: "manual", amountCents: 2_500, appliedOn: new Date(), voidedAt: null });
    const r = await store.applyStripePayment(meta(), write());
    expect(r).toMatchObject({ outcome: "recorded_with_flag" });
    const mine = fake.billingAllocation.rows.filter((a) => a.paymentId !== "manual");
    expect(mine).toMatchObject([{ amountCents: 7_500 }]);
    expect(fake.billingEvent.rows.find((e) => e.kind === "stripe_flag")).toMatchObject({ eventKey: "stripe:evt_1:overpayment", documentId: DOC, data: { reason: "overpayment", amountCents: 2_500 } });
  });

  it("a void invoice keeps the whole amount unapplied, flagged invoice_not_open", async () => {
    fake.billingDocument.rows[0]!.status = "void";
    await store.applyStripePayment(meta(), write());
    expect(fake.billingPayment.rows).toHaveLength(1);
    expect(fake.billingAllocation.rows).toHaveLength(0);
    expect(fake.billingEvent.rows.find((e) => e.kind === "stripe_flag")!.data).toEqual({ reason: "invoice_not_open", amountCents: 10_000 });
  });

  it("an unknown fee is stored as fee 0 with status unknown (never guessed)", async () => {
    await store.applyStripePayment(meta(), write({ feeCents: null }));
    expect(fake.billingPayment.rows[0]).toMatchObject({ feeCents: 0, stripeFeeStatus: "unknown" });
    expect(fake.billingEvent.rows.find((e) => e.kind === "payment_recorded")!.data).toMatchObject({ feeKnown: false, source: "stripe" });
  });

  it("a failure inside the transaction rolls everything back (the event is not marked processed)", async () => {
    vi.spyOn(fake.billingAllocation, "create").mockRejectedValueOnce(new Error("boom"));
    await expect(store.applyStripePayment(meta(), write())).rejects.toThrow("boom");
    expect(fake.stripeEvent.rows).toHaveLength(0);
    expect(fake.billingPayment.rows).toHaveLength(0);
  });
});

describe("flags and event-only rows", () => {
  it("a flag writes one StripeEvent and one stripe_flag per invoice, and a replay writes nothing", async () => {
    const f = { entityId: E, reason: "refunded" as const, documentIds: [DOC], paymentId: "pay1", amountCents: 500 };
    expect(await store.applyStripeFlag(meta("evt_r", "charge.refunded"), f)).toMatchObject({ status: "applied", outcome: "flagged" });
    expect(await store.applyStripeFlag(meta("evt_r", "charge.refunded"), f)).toEqual({ status: "already_processed" });
    expect(fake.stripeEvent.rows).toHaveLength(1);
    expect(fake.billingEvent.rows).toMatchObject([{ kind: "stripe_flag", documentId: DOC, paymentId: "pay1", actorId: null, data: { reason: "refunded", amountCents: 500 } }]);
  });
  it("event-only rows are idempotent too", async () => {
    expect(await store.recordStripeEventOnly(meta("evt_u"), "unmatched_metadata")).toMatchObject({ status: "applied" });
    expect(await store.recordStripeEventOnly(meta("evt_u"), "unmatched_metadata")).toEqual({ status: "already_processed" });
  });
  it("the owner's review of a flag is recorded once and reverses nothing", async () => {
    await store.applyStripeFlag(meta("evt_r", "charge.refunded"), { entityId: E, reason: "refunded", documentIds: [DOC], paymentId: null, amountCents: 1 });
    const flagId = fake.billingEvent.rows[0]!.id as string;
    await store.markStripeFlagReviewed({ entityId: E, userId: "u1", flagEventId: flagId });
    await store.markStripeFlagReviewed({ entityId: E, userId: "u1", flagEventId: flagId });
    expect(fake.billingEvent.rows.filter((e) => e.kind === "stripe_flag_reviewed")).toMatchObject([{ eventKey: `flag-reviewed:${flagId}`, data: { flagEventId: flagId } }]);
    await expect(store.markStripeFlagReviewed({ entityId: E, userId: "u1", flagEventId: "nope" })).rejects.toThrow("That flag was not found.");
  });
});

// stripe-ach-pending-hide-pay: the processing-bank-payment row and the owner's release.
describe("bank (ACH) payment processing rows", () => {
  const E2 = "11111111-1111-4111-8111-111111111112";
  const achMeta = { eventId: "evt_a", type: "checkout.session.completed", livemode: false };
  const pending = () => fake.billingEvent.rows.find((e) => e.kind === "bank_payment_pending")!;

  it("recordStripeAchPending writes the StripeEvent row and the pending row in one transaction; a replay is already_processed", async () => {
    const tx = vi.spyOn(fake, "$transaction");
    const args = { entityId: E, documentId: DOC, amountCents: 10_000, paymentIntentId: "pi_1" };
    expect(await store.recordStripeAchPending(achMeta, args)).toEqual({ status: "applied", outcome: "awaiting_async", paymentId: null });
    expect(await store.recordStripeAchPending(achMeta, args)).toEqual({ status: "already_processed" });
    expect(tx).toHaveBeenCalledTimes(2);
    expect(fake.stripeEvent.rows).toMatchObject([{ id: "evt_a", outcome: "awaiting_async", entityId: E, documentId: DOC }]);
    expect(fake.billingEvent.rows).toHaveLength(1);
    expect(pending()).toMatchObject({ actorId: null, documentId: DOC, eventKey: "stripe:evt_a:bank_pending", data: { amountCents: 10_000, paymentIntentId: "pi_1", livemode: false } });
  });

  it("a PaymentIntent id the timeline cannot store is omitted (the row is still written) rather than losing it", async () => {
    await store.recordStripeAchPending(achMeta, { entityId: E, documentId: DOC, amountCents: 10_000, paymentIntentId: "p".repeat(81) });
    expect(pending().data).toEqual({ amountCents: 10_000, livemode: false });
    await store.applyStripeFlag({ ...achMeta, eventId: "evt_f" }, { entityId: E, reason: "ach_failed", documentIds: [DOC], paymentId: null, amountCents: 1, paymentIntentId: "bad id" });
    expect(fake.billingEvent.rows.find((e) => e.kind === "stripe_flag")!.data).toEqual({ reason: "ach_failed", amountCents: 1 });
  });

  it("releaseBankPending: one release row through the timeline writer, idempotent, never another entity's or another kind's row", async () => {
    await store.recordStripeAchPending(achMeta, { entityId: E, documentId: DOC, amountCents: 10_000, paymentIntentId: "pi_1" });
    const id = pending().id as string;
    const create = vi.spyOn(fake.billingEvent, "create");
    await store.releaseBankPending({ entityId: E, userId: "u1", pendingEventId: id });
    await store.releaseBankPending({ entityId: E, userId: "u1", pendingEventId: id });
    const rel = fake.billingEvent.rows.filter((e) => e.kind === "bank_payment_released");
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ entityId: E, actorId: "u1", documentId: DOC, eventKey: `bank-released:${id}`, data: { pendingEventId: id } });
    expect(create).toHaveBeenCalled();
    expect(fake.billingPayment.rows).toHaveLength(0);
    await expect(store.releaseBankPending({ entityId: E2, userId: "u1", pendingEventId: id })).rejects.toThrow("That bank payment was not found.");
    await store.applyStripeFlag(meta("evt_r", "charge.refunded"), { entityId: E, reason: "refunded", documentIds: [DOC], paymentId: null, amountCents: 1 });
    const flagId = fake.billingEvent.rows.find((e) => e.kind === "stripe_flag")!.id as string;
    await expect(store.releaseBankPending({ entityId: E, userId: "u1", pendingEventId: flagId })).rejects.toThrow("That bank payment was not found.");
  });
});
