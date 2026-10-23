// Payout linking, fee refresh and open flags (plan P8, P9, S8): the pure payout scorer and flag reducer, and the store rules over the
// in-memory fake db (one deposit for several payments only with known Stripe fees; the fee moves unknown -> known once and never after a
// deposit link).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});

import { db } from "@/lib/db";
import * as store from "@/lib/invoicing/store";
import { scorePayoutDeposits, type DepositCandidate } from "@/lib/invoicing/deposit-match";
import { openStripeFlags, type FlagEventInput } from "@/lib/invoicing/stripe/flags";

const fake = db as unknown as FakeDb;
const E = "11111111-1111-4111-8111-111111111111";
const OTHER = "11111111-1111-4111-8111-111111111112";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const DEP = "55555555-5555-4555-8555-555555555555";
const P = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, "0")}`;
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

describe("scorePayoutDeposits (pure)", () => {
  const latest = new Date("2026-10-20T00:00:00Z");
  const c = (id: string, cents: number, daysAfter: number, text = "", linked = 0): DepositCandidate => ({ transactionId: id, postedAt: new Date(latest.getTime() + daysAfter * 86_400_000), amountCents: cents, text, alreadyLinkedNetCents: linked });
  it("an exact match of the net sum comes first; Stripe in the text adds to the score", () => {
    const out = scorePayoutDeposits(19_360, latest, [c("a", 50_000, 2), c("b", 19_360, 3), c("c", 19_360, 3, "STRIPE TRANSFER")]);
    expect(out.map((o) => o.transactionId)).toEqual(["c", "b", "a"]);
    expect(out[0]!.reasons).toContain("the deposit text mentions Stripe");
    expect(out[1]!.reasons).toContain("same as the total after Stripe fees");
  });
  it("respects the window (from a day before the latest payment) and the deposit's remaining capacity", () => {
    const out = scorePayoutDeposits(10_000, latest, [c("early", 10_000, -3), c("late", 10_000, 30), c("full", 10_000, 1, "", 5_000), c("ok", 15_000, 1, "", 5_000)]);
    expect(out.map((o) => o.transactionId)).toEqual(["ok"]);
    expect(out[0]).toMatchObject({ remainingCents: 10_000, reasons: expect.arrayContaining(["fills the rest of a shared deposit"]) });
  });
});

describe("openStripeFlags (pure)", () => {
  const ev = (id: string, kind: string, data: Record<string, string | number | null>, at = "2026-10-23T10:00:00.000Z"): FlagEventInput => ({ id, kind, documentId: "d1", paymentId: null, createdAt: at, data });
  it("a review closes the flag it names; a review of a non-flag is ignored; unknown reasons are dropped", () => {
    const flags = openStripeFlags([
      ev("f1", "stripe_flag", { reason: "overpayment", amountCents: 250 }),
      ev("f2", "stripe_flag", { reason: "refunded", amountCents: null }, "2026-10-23T11:00:00.000Z"),
      ev("f3", "stripe_flag", { reason: "not-a-reason" }),
      ev("r1", "stripe_flag_reviewed", { flagEventId: "f1" }),
      ev("r2", "stripe_flag_reviewed", { flagEventId: "x-not-a-flag" }),
      ev("e1", "emailed", { recipientCount: 1 }),
    ]);
    expect(flags.map((f) => [f.id, f.reason, f.amountCents])).toEqual([["f2", "refunded", null]]);
    expect(flags[0]!.label).toMatch(/Refunded in Stripe/);
  });
});

function seedPayments() {
  fake.transaction.rows = [{ id: DEP, entityId: E, archivedAt: null, transferPairId: null, pending: false, amount: new Prisma.Decimal("193.60"), postedAt: new Date("2026-10-22T00:00:00Z") }];
  const pay = (n: number, over: Record<string, unknown> = {}) => ({
    id: P(n), entityId: E, clientId: CLIENT, method: "card", receivedOn: new Date("2026-10-20T00:00:00Z"), amountCents: 10_000, feeCents: 320, source: "stripe", stripeFeeStatus: "known",
    status: "recorded", depositTransactionId: null, stripePaymentIntentId: `pi_${n}`, ...over,
  });
  fake.billingPayment.rows = [pay(1), pay(2), pay(3, { stripeFeeStatus: "unknown", feeCents: 0 }), pay(4, { entityId: OTHER }), pay(5, { status: "void" }), pay(6, { depositTransactionId: DEP, amountCents: 100, feeCents: 0 }), pay(7, { source: "manual", stripeFeeStatus: null, method: "check", feeCents: 0, amountCents: 1_000 })];
  for (const t of [fake.billingEvent, fake.billingAllocation]) t.rows = [];
}

beforeEach(() => seedPayments());

describe("linkDepositToPayments", () => {
  it("links one deposit to several Stripe payments with known fees (sum of nets below the deposit is fine)", async () => {
    fake.billingPayment.rows.find((p) => p.id === P(6))!.depositTransactionId = null; // nothing else on the deposit
    await store.linkDepositToPayments({ entityId: E, userId: U, depositTransactionId: DEP, paymentIds: [P(2), P(1)] });
    expect(fake.billingPayment.rows.filter((p) => p.depositTransactionId === DEP).map((p) => p.id).sort()).toEqual([P(1), P(2)]);
    expect(fake.billingEvent.rows.map((e) => [e.kind, e.paymentId, (e.data as { batchSize: number }).batchSize]).sort()).toEqual([
      ["deposit_linked", P(1), 2],
      ["deposit_linked", P(2), 2],
    ]);
  });
  it.each([
    ["an unknown-fee Stripe payment", [P(1), P(3)], /Fetch the Stripe fee first/],
    ["a payment of another entity", [P(1), P(4)], /not found/],
    ["a void payment", [P(5)], /voided payment/],
    ["an already linked payment", [P(6)], /already has a bank deposit/],
  ])("refuses %s", async (_l, ids, msg) => {
    await expect(store.linkDepositToPayments({ entityId: E, userId: U, depositTransactionId: DEP, paymentIds: ids })).rejects.toThrow(msg);
    expect(fake.billingEvent.rows).toHaveLength(0);
  });
  it("refuses when the nets exceed what is left of the deposit, and refuses a pending deposit", async () => {
    // 2 x 96.80 = 193.60 net, but payment 6 already uses 1.00 of the 193.60 deposit
    await expect(store.linkDepositToPayments({ entityId: E, userId: U, depositTransactionId: DEP, paymentIds: [P(1), P(2)] })).rejects.toThrow(/already fully matched/);
    fake.transaction.rows[0]!.pending = true;
    await expect(store.linkDepositToPayments({ entityId: E, userId: U, depositTransactionId: DEP, paymentIds: [P(1)] })).rejects.toThrow(/pending/);
    expect(fake.billingPayment.rows.filter((p) => p.depositTransactionId === DEP).map((p) => p.id)).toEqual([P(6)]);
  });
  it("a manual payment can be part of the batch (no fee rule for it)", async () => {
    await store.linkDepositToPayments({ entityId: E, userId: U, depositTransactionId: DEP, paymentIds: [P(1), P(7)] });
    expect(fake.billingPayment.rows.find((p) => p.id === P(7))!.depositTransactionId).toBe(DEP);
  });
});

describe("the single-payment linkDeposit", () => {
  it("refuses an unknown-fee Stripe payment, accepts a known-fee one and leaves manual payments as before", async () => {
    await expect(store.linkDeposit({ entityId: E, userId: U, paymentId: P(3), depositTransactionId: DEP })).rejects.toThrow(/Fetch the Stripe fee first/);
    await store.linkDeposit({ entityId: E, userId: U, paymentId: P(1), depositTransactionId: DEP });
    await store.linkDeposit({ entityId: E, userId: U, paymentId: P(7), depositTransactionId: DEP });
    expect(fake.billingPayment.rows.filter((p) => p.depositTransactionId === DEP).map((p) => p.id).sort()).toEqual([P(1), P(6), P(7)]);
  });
});

describe("refreshStripeFee", () => {
  it("moves the fee from unknown to known exactly once", async () => {
    await store.refreshStripeFee({ entityId: E, userId: U, paymentId: P(3), feeCents: 320 });
    expect(fake.billingPayment.rows.find((p) => p.id === P(3))).toMatchObject({ feeCents: 320, stripeFeeStatus: "known" });
    expect(fake.billingEvent.rows).toMatchObject([{ kind: "fee_recorded", paymentId: P(3), data: { feeCents: 320 } }]);
    await expect(store.refreshStripeFee({ entityId: E, userId: U, paymentId: P(3), feeCents: 1 })).rejects.toThrow(/already known/);
    expect(fake.billingPayment.rows.find((p) => p.id === P(3))!.feeCents).toBe(320);
  });
  it("is refused once a deposit is linked, for a manual payment, and for an impossible fee", async () => {
    fake.billingPayment.rows.find((p) => p.id === P(3))!.depositTransactionId = DEP;
    await expect(store.refreshStripeFee({ entityId: E, userId: U, paymentId: P(3), feeCents: 320 })).rejects.toThrow(/bank deposit is already linked/);
    await expect(store.refreshStripeFee({ entityId: E, userId: U, paymentId: P(7), feeCents: 1 })).rejects.toThrow(/not found/);
    fake.billingPayment.rows.find((p) => p.id === P(3))!.depositTransactionId = null;
    await expect(store.refreshStripeFee({ entityId: E, userId: U, paymentId: P(3), feeCents: 10_001 })).rejects.toThrow(/cannot be right/);
  });
});
