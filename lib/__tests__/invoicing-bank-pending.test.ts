// A US bank (ACH) payment still processing (stripe-ach-pending-hide-pay): the pure derivation, the business-day math and every sentence.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  BANK_RELEASE_CONFIRM,
  deriveBankPending,
  failedIntentsFrom,
  formatBankDate,
  isOverdue,
  nyDayOf,
  OWNER_BANK_OVERDUE_TEXT,
  ownerBankPendingItemText,
  pendingRowFromEvent,
  publicBankPendingText,
  releasedIdsFrom,
  safeStripeIdOrNull,
  type DeriveInput,
  type PendingRow,
} from "@/lib/invoicing/stripe/bank-pending";

const DOC = "33333333-3333-4333-8333-333333333333";
const DOC2 = "33333333-3333-4333-8333-333333333334";
// Friday 2026-10-23, 15:00 UTC = 11:00 New York.
const FRI = "2026-10-23T15:00:00.000Z";
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const row = (over: Partial<PendingRow> = {}): PendingRow => ({ id: "ev1", documentId: DOC, createdAt: FRI, amountCents: 10_000, paymentIntentId: "pi_1", livemode: false, ...over });
const input = (over: Partial<DeriveInput> = {}): DeriveInput => ({
  pending: [row()],
  paidIntents: new Set(),
  failedIntents: new Set(),
  releasedIds: new Set(),
  mode: "test",
  today: day("2026-10-23"),
  ...over,
});

describe("deriveBankPending", () => {
  it("an open row blocks its invoice, with amount and New York start day", () => {
    const m = deriveBankPending(input());
    expect([...m.keys()]).toEqual([DOC]);
    expect(m.get(DOC)).toEqual({ items: [{ id: "ev1", amountCents: 10_000, startedOn: "2026-10-23", overdue: false, livemode: false }], totalCents: 10_000, startedOn: "2026-10-23", overdue: false });
  });
  it("closed by a payment with its PaymentIntent (any status, the loader passes void ones too), by an ach_failed flag, or by the owner's release", () => {
    expect(deriveBankPending(input({ paidIntents: new Set(["pi_1"]) })).size).toBe(0);
    expect(deriveBankPending(input({ failedIntents: new Set(["pi_1"]) })).size).toBe(0);
    expect(deriveBankPending(input({ releasedIds: new Set(["ev1"]) })).size).toBe(0);
    // Another PaymentIntent's success does not close it.
    expect(deriveBankPending(input({ paidIntents: new Set(["pi_2"]), failedIntents: new Set(["pi_3"]), releasedIds: new Set(["ev9"]) })).size).toBe(1);
  });
  it("a row without a PaymentIntent can only be closed by a release", () => {
    expect(deriveBankPending(input({ pending: [row({ paymentIntentId: null })], paidIntents: new Set(["pi_1"]) })).size).toBe(1);
    expect(deriveBankPending(input({ pending: [row({ paymentIntentId: null })], releasedIds: new Set(["ev1"]) })).size).toBe(0);
  });
  it("mode: a row of the other mode is ignored; no mode (not configured) shows all; an unknown livemode always counts", () => {
    expect(deriveBankPending(input({ mode: "live" })).size).toBe(0);
    expect(deriveBankPending(input({ pending: [row({ livemode: true })], mode: "test" })).size).toBe(0);
    expect(deriveBankPending(input({ pending: [row({ livemode: true })], mode: "live" })).size).toBe(1);
    expect(deriveBankPending(input({ mode: null })).size).toBe(1);
    expect(deriveBankPending(input({ pending: [row({ livemode: null })], mode: "live" })).size).toBe(1);
  });
  it("malformed data gives an open item with an unknown amount (never dropped, never a throw)", () => {
    const parsed = pendingRowFromEvent({ id: "ev1", kind: "bank_payment_pending", documentId: DOC, createdAt: FRI, data: { amountCents: "lots", paymentIntentId: 7, livemode: "yes" } });
    expect(parsed).toEqual({ id: "ev1", documentId: DOC, createdAt: FRI, amountCents: null, paymentIntentId: null, livemode: null });
    const s = deriveBankPending(input({ pending: [parsed] })).get(DOC)!;
    expect(s.totalCents).toBeNull();
    expect(s.items[0]!.amountCents).toBeNull();
    expect(pendingRowFromEvent({ id: "e", kind: "bank_payment_pending", documentId: DOC, createdAt: FRI, data: { amountCents: -5 } }).amountCents).toBeNull();
  });
  it("two rows with the same PaymentIntent count once (the earliest)", () => {
    const m = deriveBankPending(input({ pending: [row({ id: "ev2", createdAt: "2026-10-26T15:00:00.000Z" }), row()] }));
    expect(m.get(DOC)!.items.map((i) => i.id)).toEqual(["ev1"]);
  });
  it("several open payments: summed total, earliest date, per invoice", () => {
    const m = deriveBankPending(
      input({
        pending: [row({ id: "ev2", createdAt: "2026-10-26T15:00:00.000Z", paymentIntentId: "pi_2", amountCents: 2_500 }), row(), row({ id: "ev3", documentId: DOC2, paymentIntentId: "pi_3" })],
        today: day("2026-10-26"),
      })
    );
    expect(m.get(DOC)).toMatchObject({ totalCents: 12_500, startedOn: "2026-10-23", overdue: false });
    expect(m.get(DOC)!.items.map((i) => i.id)).toEqual(["ev1", "ev2"]);
    expect(m.get(DOC2)!.items).toHaveLength(1);
  });
  it("rows with no invoice are ignored", () => {
    expect(deriveBankPending(input({ pending: [row({ documentId: null })] })).size).toBe(0);
  });
  it("an overdue row still blocks (the cap is a label only)", () => {
    const s = deriveBankPending(input({ today: day("2026-11-09") })).get(DOC)!;
    expect(s.overdue).toBe(true);
    expect(s.items[0]!.overdue).toBe(true);
  });
});

describe("failedIntentsFrom / releasedIdsFrom", () => {
  it("only ach_failed flags with a PaymentIntent; only release rows' pendingEventId", () => {
    const rows = [
      { id: "f1", kind: "stripe_flag", documentId: DOC, createdAt: FRI, data: { reason: "ach_failed", amountCents: 1, paymentIntentId: "pi_1" } },
      { id: "f2", kind: "stripe_flag", documentId: DOC, createdAt: FRI, data: { reason: "refunded", amountCents: 1, paymentIntentId: "pi_2" } },
      { id: "f3", kind: "stripe_flag", documentId: DOC, createdAt: FRI, data: { reason: "ach_failed", amountCents: 1 } },
      { id: "r1", kind: "bank_payment_released", documentId: DOC, createdAt: FRI, data: { pendingEventId: "ev1" } },
      { id: "r2", kind: "stripe_flag_reviewed", documentId: DOC, createdAt: FRI, data: { pendingEventId: "ev2" } },
    ];
    expect([...failedIntentsFrom(rows)]).toEqual(["pi_1"]);
    expect([...releasedIdsFrom(rows)]).toEqual(["ev1"]);
  });
  it("safeStripeIdOrNull keeps id-like tokens up to 80 characters only", () => {
    expect(safeStripeIdOrNull("pi_3Abc")).toBe("pi_3Abc");
    expect(safeStripeIdOrNull("p".repeat(80))).toBe("p".repeat(80));
    expect(safeStripeIdOrNull("p".repeat(81))).toBeNull();
    expect(safeStripeIdOrNull("pi 1")).toBeNull();
    expect(safeStripeIdOrNull("")).toBeNull();
    expect(safeStripeIdOrNull(5)).toBeNull();
  });
});

describe("business days", () => {
  it("skips weekends; a Saturday start counts from Monday", () => {
    expect(addBusinessDays("2026-10-23", 1)).toBe("2026-10-26"); // Fri -> Mon
    expect(addBusinessDays("2026-10-23", 10)).toBe("2026-11-06"); // Fri -> Fri two weeks on
    expect(addBusinessDays("2026-10-24", 1)).toBe("2026-10-26"); // Sat -> Mon
    expect(addBusinessDays("2026-10-24", 10)).toBe("2026-11-06");
    expect(addBusinessDays("2026-10-26", 0)).toBe("2026-10-26");
  });
  it("overdue only after business day 10: day 10 is not, the next business day is", () => {
    expect(isOverdue("2026-10-23", "2026-11-06")).toBe(false); // business day 10
    expect(isOverdue("2026-10-23", "2026-11-09")).toBe(true); // business day 11
    expect(isOverdue("2026-10-24", "2026-11-06")).toBe(false);
    expect(isOverdue("2026-10-24", "2026-11-09")).toBe(true);
    expect(isOverdue("2026-10-23", "2026-10-23")).toBe(false);
  });
  it("the start day is the New York calendar day", () => {
    expect(nyDayOf("2026-10-24T02:30:00.000Z")).toBe("2026-10-23"); // 22:30 New York
    expect(nyDayOf("2026-10-24T05:00:00.000Z")).toBe("2026-10-24");
  });
});

describe("sentences", () => {
  const one = deriveBankPending(input()).get(DOC)!;
  const two = deriveBankPending(input({ pending: [row(), row({ id: "ev2", paymentIntentId: "pi_2", amountCents: 2_500, createdAt: "2026-10-26T15:00:00.000Z" })], today: day("2026-10-26") })).get(DOC)!;
  const unknown = deriveBankPending(input({ pending: [row({ amountCents: null })] })).get(DOC)!;
  const late = deriveBankPending(input({ today: day("2026-11-09") })).get(DOC)!;
  const lateTwo = deriveBankPending(input({ pending: [row(), row({ id: "ev2", paymentIntentId: "pi_2", amountCents: 2_500 })], today: day("2026-11-09") })).get(DOC)!;
  it("public: one, several, unknown amount, overdue", () => {
    expect(publicBankPendingText(one)).toBe("A bank payment of $100.00 is processing (started Oct 23, 2026); it usually takes up to 4 business days.");
    expect(publicBankPendingText(two)).toBe("Bank payments totalling $125.00 are processing (first started Oct 23, 2026); they usually take up to 4 business days.");
    expect(publicBankPendingText(unknown)).toBe("A bank payment is processing (started Oct 23, 2026); it usually takes up to 4 business days.");
    expect(publicBankPendingText(late)).toBe("A bank payment of $100.00 started Oct 23, 2026 is still being confirmed. Please contact us before paying again.");
    expect(publicBankPendingText(lateTwo)).toBe("Bank payments totalling $125.00, first started Oct 23, 2026, are still being confirmed. Please contact us before paying again.");
  });
  it("owner: the item line and the overdue sentence", () => {
    expect(ownerBankPendingItemText(one.items[0]!)).toBe("$100.00, started Oct 23, 2026; it usually takes up to 4 business days.");
    expect(ownerBankPendingItemText(unknown.items[0]!)).toBe("amount unknown, started Oct 23, 2026; it usually takes up to 4 business days.");
    expect(OWNER_BANK_OVERDUE_TEXT).toBe("Bank payment processing for more than 10 business days: check it in Stripe.");
  });
  it("no sentence mentions a fee, a surcharge or a Stripe id", () => {
    const all = [one, two, unknown, late, lateTwo].map(publicBankPendingText).concat([ownerBankPendingItemText(one.items[0]!), OWNER_BANK_OVERDUE_TEXT, BANK_RELEASE_CONFIRM]);
    for (const s of all) {
      expect(s).not.toMatch(/\bfee|surcharge/i);
      expect(s).not.toMatch(/\b(pi|cs|ch|evt)_/);
    }
  });
  it("formatBankDate", () => {
    expect(formatBankDate("2026-01-05")).toBe("Jan 5, 2026");
    expect(formatBankDate("nonsense")).toBe("nonsense");
  });
});

describe("source pins", () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  it("bank-pending.ts is pure (no db, next/*, auth or clock)", () => {
    const src = read("lib/invoicing/stripe/bank-pending.ts");
    expect(src).not.toMatch(/from "@\/lib\/db"|from "next\/|from "@\/lib\/auth"|from "@prisma\/client"/);
    expect(src).not.toMatch(/Date\.now\(\)|new Date\(\)/);
  });
  it("the Checkout parameters are unchanged by the ACH-preferred wording", () => {
    expect(read("lib/invoicing/stripe/checkout-params.ts")).not.toContain("ACH_PREFERRED");
  });
});
