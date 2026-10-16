import { describe, expect, it } from "vitest";
import {
  canTransition,
  canVoidInvoice,
  canVoidPayment,
  deriveInvoiceState,
  nyToday,
  statusesOf,
} from "@/lib/invoicing/state";
import { DOCUMENT_KINDS } from "@/lib/invoicing/constants";
import { canChangeCounter, canSetNextNumber, formatDisplayNumber, formatQuoteNumber, isValidPrefix, isValidQuotePrefix } from "@/lib/invoicing/numbering";
import {
  AGING_BUCKETS,
  agingBucketFor,
  buildAging,
  canAllocate,
  depositsOnAccount,
  invoiceBalanceAsOf,
  unallocatedRemainder,
  type ArAllocation,
  type ArInvoice,
} from "@/lib/invoicing/ar";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("state transitions", () => {
  it("invoice: draft -> issued -> void only", () => {
    expect(canTransition("invoice", "draft", "issued")).toBe(true);
    expect(canTransition("invoice", "issued", "void")).toBe(true);
    for (const [from, to] of [["draft", "void"], ["draft", "draft"], ["issued", "draft"], ["void", "issued"], ["void", "draft"], ["issued", "issued"]] as const) {
      expect(canTransition("invoice", from, to)).toBe(false);
    }
  });
  it("quote matrix, and conversion is a one-way end", () => {
    expect(canTransition("quote", "draft", "sent")).toBe(true);
    expect(canTransition("quote", "sent", "accepted")).toBe(true);
    expect(canTransition("quote", "accepted", "converted")).toBe(true);
    expect(canTransition("quote", "converted", "converted")).toBe(false);
    expect(canTransition("quote", "converted", "void")).toBe(false);
    expect(canTransition("quote", "declined", "accepted")).toBe(false);
    expect(statusesOf("quote")).toContain("converted");
  });
  it("the only document kinds are invoice and quote (no credit memos, no estimates)", () => {
    expect([...DOCUMENT_KINDS]).toEqual(["invoice", "quote"]);
  });
  it("unknown statuses are never allowed", () => {
    expect(canTransition("invoice", "weird", "issued")).toBe(false);
  });
});

describe("derived invoice state", () => {
  const base = { totalCents: 100000, dueDate: d("2026-11-10"), today: d("2026-11-10"), sentAt: null as Date | null, allocatedCents: 0 };
  it("issued not sent -> sent -> partially paid -> paid", () => {
    expect(deriveInvoiceState({ ...base, status: "issued" }).state).toBe("issued_unsent");
    expect(deriveInvoiceState({ ...base, status: "issued", sentAt: d("2026-11-01") }).state).toBe("sent");
    expect(deriveInvoiceState({ ...base, status: "issued", allocatedCents: 1 }).state).toBe("partially_paid");
    const paid = deriveInvoiceState({ ...base, status: "issued", allocatedCents: 100000 });
    expect(paid.state).toBe("paid");
    expect(paid.balanceCents).toBe(0);
  });
  it("due date boundary: due today is NOT overdue, the next NY day is", () => {
    expect(deriveInvoiceState({ ...base, status: "issued" }).overdue).toBe(false);
    const next = deriveInvoiceState({ ...base, status: "issued", today: d("2026-11-11") });
    expect(next.overdue).toBe(true);
    expect(next.daysPastDue).toBe(1);
  });
  it("a fully paid invoice is never overdue; a void or draft has no balance logic", () => {
    expect(deriveInvoiceState({ ...base, status: "issued", allocatedCents: 100000, today: d("2027-01-01") }).overdue).toBe(false);
    expect(deriveInvoiceState({ ...base, status: "void" }).state).toBe("void");
    expect(deriveInvoiceState({ ...base, status: "draft" }).state).toBe("draft");
  });
  it("over-covered balance never goes negative", () => {
    expect(deriveInvoiceState({ ...base, status: "issued", allocatedCents: 120000 }).balanceCents).toBe(0);
  });
});

describe("void rules", () => {
  it("an invoice with active allocations cannot be voided", () => {
    expect(canVoidInvoice("issued", 0)).toEqual({ ok: true });
    expect(canVoidInvoice("issued", 1).ok).toBe(false);
    expect(canVoidInvoice("draft", 0).ok).toBe(false);
    expect(canVoidInvoice("void", 0).ok).toBe(false);
  });
  it("a payment with active applications cannot be voided", () => {
    expect(canVoidPayment("recorded", 0)).toEqual({ ok: true });
    expect(canVoidPayment("recorded", 2).ok).toBe(false);
    expect(canVoidPayment("void", 0).ok).toBe(false);
  });
});

describe("New York calendar day", () => {
  it("late evening in New York is still that day even though UTC has rolled over", () => {
    // 2026-11-10 23:30 EST = 2026-11-11 04:30 UTC
    expect(nyToday(new Date("2026-11-11T04:30:00Z")).toISOString().slice(0, 10)).toBe("2026-11-10");
    expect(nyToday(new Date("2026-11-11T05:30:00Z")).toISOString().slice(0, 10)).toBe("2026-11-11");
  });
});

describe("numbering", () => {
  it("formats with prefix and padding and never truncates", () => {
    expect(formatDisplayNumber("", 3100, 0)).toBe("3100");
    expect(formatDisplayNumber("INV-", 42, 5)).toBe("INV-00042");
    expect(formatDisplayNumber("INV-", 10000, 4)).toBe("INV-10000");
    expect(formatDisplayNumber("X-", 7, 0)).toBe("X-7");
  });
  it("quote numbers print as Q-2001 (pure format function); invoices keep no prefix", () => {
    expect(formatQuoteNumber("Q-", 2001)).toBe("Q-2001");
    expect(formatQuoteNumber("Q-", 2001, 0)).toBe("Q-2001");
    expect(formatQuoteNumber("Q-", 2002, 0)).toBe("Q-2002");
    expect(formatQuoteNumber("Q-", 7, 5)).toBe("Q-00007");
    expect(formatQuoteNumber("Q-", 123456, 4)).toBe("Q-123456"); // never truncated
    expect(formatDisplayNumber("", 3100, 0)).toBe("3100");
    // the two series can never print the same text
    expect(formatQuoteNumber("Q-", 3100)).not.toBe(formatDisplayNumber("", 3100, 0));
  });
  it("a quote prefix is required (never empty) and must be a valid prefix", () => {
    expect(isValidQuotePrefix("Q-")).toBe(true);
    expect(isValidQuotePrefix("")).toBe(false);
    expect(isValidQuotePrefix("   ")).toBe(false);
    expect(isValidQuotePrefix("a<b")).toBe(false);
    expect(isValidQuotePrefix("Q".repeat(13))).toBe(false);
  });
  it("L-2: a quote prefix is trimmed, has a non-digit, and differs from the invoice prefix", () => {
    // digits only would print "3" + 2001 as 32001, indistinguishable from an invoice number
    expect(isValidQuotePrefix("3")).toBe(false);
    expect(isValidQuotePrefix("2026")).toBe(false);
    expect(isValidQuotePrefix("3-")).toBe(true);
    expect(isValidQuotePrefix("Q3")).toBe(true);
    // leading / trailing spaces would print "Q- 2001"
    expect(isValidQuotePrefix("Q- ")).toBe(false);
    expect(isValidQuotePrefix(" Q-")).toBe(false);
    expect(isValidQuotePrefix("Q-")).toBe(true);
    // never equal to the invoice prefix (case-insensitive, invoice prefix trimmed); both empty is refused by the non-empty rule
    expect(isValidQuotePrefix("INV-", "INV-")).toBe(false);
    expect(isValidQuotePrefix("inv-", "INV-")).toBe(false);
    expect(isValidQuotePrefix("INV-", " INV- ")).toBe(false);
    expect(isValidQuotePrefix("Q-", "INV-")).toBe(true);
    expect(isValidQuotePrefix("Q-", "")).toBe(true);
    expect(isValidQuotePrefix("", "")).toBe(false);
    // the existing 12-character limit still holds
    expect(isValidQuotePrefix("Q".repeat(12))).toBe(true);
    expect(isValidQuotePrefix("Q".repeat(13))).toBe(false);
  });
  it("the counter can only go up", () => {
    expect(canSetNextNumber(3100, null)).toEqual({ ok: true });
    expect(canSetNextNumber(0, null).ok).toBe(false);
    expect(canSetNextNumber(3105, 3105).ok).toBe(false);
    expect(canSetNextNumber(3106, 3105).ok).toBe(true);
    expect(canChangeCounter(3110, 3105, null).ok).toBe(false);
    expect(canChangeCounter(3110, 3110, 3109).ok).toBe(true);
    expect(canChangeCounter(3110, 3120, 3109).ok).toBe(true);
  });
  it("prefix rules", () => {
    expect(isValidPrefix("")).toBe(true);
    expect(isValidPrefix("INV-")).toBe(true);
    expect(isValidPrefix("a<b")).toBe(false);
    expect(isValidPrefix("x".repeat(13))).toBe(false);
  });
});

const inv = (id: string, clientId: string, total: number, issue: string, due: string, extra: Partial<ArInvoice> = {}): ArInvoice => ({
  id,
  clientId,
  displayNumber: id,
  status: "issued",
  issueDate: d(issue),
  dueDate: d(due),
  totalCents: total,
  voidedAt: null,
  ...extra,
});

describe("A/R aging buckets (boundaries)", () => {
  it("0, 1, 30, 31, 60, 61, 90, 91 days past due", () => {
    const cases: [number, string][] = [[-5, "current"], [0, "current"], [1, "d1_30"], [30, "d1_30"], [31, "d31_60"], [60, "d31_60"], [61, "d61_90"], [90, "d61_90"], [91, "d90_plus"]];
    for (const [days, bucket] of cases) expect(agingBucketFor(days)).toBe(bucket);
    expect(AGING_BUCKETS).toHaveLength(5);
  });
  it("buckets by days past the DUE date as of the date picked", () => {
    const asOf = d("2026-12-31");
    const invoices = [
      inv("A", "c1", 10000, "2026-12-01", "2026-12-31"), // 0 -> current
      inv("B", "c1", 20000, "2026-11-01", "2026-11-30"), // 31 -> d31_60
      inv("C", "c2", 30000, "2026-09-01", "2026-10-01"), // 91 -> d90_plus
    ];
    const r = buildAging(invoices, [], asOf);
    expect(r.totals.current).toBe(10000);
    expect(r.totals.d31_60).toBe(20000);
    expect(r.totals.d90_plus).toBe(30000);
    expect(r.totals.totalCents).toBe(60000);
    expect(r.byClient.get("c1")?.totalCents).toBe(30000);
    expect(r.byClient.get("c2")?.totalCents).toBe(30000);
    expect(r.rows[0]!.invoiceId).toBe("C"); // oldest first
  });
});

describe("A/R balances", () => {
  const i1 = inv("I1", "c1", 100000, "2026-11-05", "2026-11-05");
  it("partial payments reduce the balance from the day they are applied", () => {
    const allocs: ArAllocation[] = [{ invoiceId: "I1", amountCents: 40000, appliedOn: d("2026-11-20"), voidedAt: null }];
    expect(invoiceBalanceAsOf(i1, allocs, d("2026-11-19"))).toBe(100000);
    expect(invoiceBalanceAsOf(i1, allocs, d("2026-11-20"))).toBe(60000);
  });
  it("a voided allocation counts until the day it was voided", () => {
    const allocs: ArAllocation[] = [{ invoiceId: "I1", amountCents: 100000, appliedOn: d("2026-11-20"), voidedAt: d("2026-12-05") }];
    expect(invoiceBalanceAsOf(i1, allocs, d("2026-12-04"))).toBe(0);
    expect(invoiceBalanceAsOf(i1, allocs, d("2026-12-05"))).toBe(100000);
  });
  it("a voided invoice leaves the books from its void date; drafts never count; not yet issued does not count", () => {
    const voided = inv("V", "c1", 5000, "2026-11-05", "2026-11-05", { status: "void", voidedAt: d("2026-11-25") });
    expect(invoiceBalanceAsOf(voided, [], d("2026-11-24"))).toBe(5000);
    expect(invoiceBalanceAsOf(voided, [], d("2026-11-25"))).toBe(0);
    expect(invoiceBalanceAsOf(inv("D", "c1", 5000, "2026-11-05", "2026-11-05", { status: "draft" }), [], d("2026-12-01"))).toBe(0);
    expect(invoiceBalanceAsOf(i1, [], d("2026-11-04"))).toBe(0);
  });
  it("several applications of deposits (allocations of payments) reduce the balance together", () => {
    const allocs: ArAllocation[] = [
      { invoiceId: "I1", amountCents: 30000, appliedOn: d("2026-11-10"), voidedAt: null },
      { invoiceId: "I1", amountCents: 20000, appliedOn: d("2026-11-12"), voidedAt: null },
    ];
    expect(invoiceBalanceAsOf(i1, allocs, d("2026-11-30"))).toBe(50000);
  });
});

describe("deposits on account", () => {
  it("unapplied payment remainders add up per client; void sources are ignored", () => {
    expect(unallocatedRemainder(10000, [4000, 3000])).toBe(3000);
    expect(unallocatedRemainder(10000, [10000])).toBe(0);
    const credit = depositsOnAccount([
      { clientId: "c1", amountCents: 10000, allocationAmountsCents: [4000], active: true },
      { clientId: "c1", amountCents: 5000, allocationAmountsCents: [], active: true },
      { clientId: "c1", amountCents: 9999, allocationAmountsCents: [], active: false },
      { clientId: "c2", amountCents: 2000, allocationAmountsCents: [2000], active: true },
    ]);
    expect(credit.get("c1")).toBe(11000);
    expect(credit.has("c2")).toBe(false);
  });
  it("allocation limits: invoice balance and source remainder", () => {
    expect(canAllocate(100, 100, 100).ok).toBe(true);
    expect(canAllocate(101, 100, 200).ok).toBe(false);
    expect(canAllocate(101, 200, 100).ok).toBe(false);
    expect(canAllocate(0, 100, 100).ok).toBe(false);
  });
});
