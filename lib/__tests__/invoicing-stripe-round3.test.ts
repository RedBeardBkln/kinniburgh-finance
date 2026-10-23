// Review round 3 (N-1, N-2): the flag loader keeps the NEWEST rows under its cap, and a fully paid invoice never reads
// "less than $0.50 is due".
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});

import { db } from "@/lib/db";
import { loadInvoiceStripeFlags } from "@/lib/invoicing/pay-build";
import { payLinkSendNote, payOnlineEligibility } from "@/lib/invoicing/stripe/eligibility";

const fake = db as unknown as FakeDb;

beforeEach(() => vi.restoreAllMocks());

describe("flag loader (N-1)", () => {
  it("asks for the newest rows first under its cap and still shows open flags oldest-first", async () => {
    const rows = [
      { id: "f2", kind: "stripe_flag", documentId: "d1", paymentId: null, createdAt: new Date("2026-10-22T10:00:00Z"), data: { reason: "overpayment", amountCents: 500 } },
      { id: "f1", kind: "stripe_flag", documentId: "d1", paymentId: null, createdAt: new Date("2026-10-20T10:00:00Z"), data: { reason: "overpayment", amountCents: 100 } },
    ];
    const spy = vi.spyOn(fake.billingEvent, "findMany").mockResolvedValue(rows as never);
    vi.spyOn(fake.billingDocument, "findMany").mockResolvedValue([{ id: "d1", displayNumber: "3100" }] as never);
    const flags = await loadInvoiceStripeFlags("e1", "d1");
    const args = spy.mock.calls[0]![0] as { orderBy: unknown; take: number };
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(args.take).toBe(2000);
    expect(flags.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(flags.every((f) => f.invoiceNumber === "3100")).toBe(true);
  });

  it("the loader source no longer orders the capped flag read oldest-first", () => {
    const src = readFileSync(join(process.cwd(), "lib/invoicing/pay-build.ts"), "utf8");
    const fn = src.slice(src.indexOf("async function flagRows"), src.indexOf("async function withNumbers"));
    expect(fn).toContain("take: 2000");
    expect(fn).not.toContain('orderBy: { createdAt: "asc" }');
  });
});

describe("payLinkSendNote (N-2)", () => {
  const base = { enabled: true, configured: true, baseUrl: "https://app.example", status: "issued", bankPending: false };

  it("a fully paid invoice says it is paid, never 'less than $0.50'", () => {
    const note = payLinkSendNote(true, payOnlineEligibility({ ...base, balanceCents: 0 }));
    expect(note).toBe("No pay link: this invoice is paid in full, nothing is due.");
    expect(note).not.toContain("$0.50");
  });

  it("only a balance of 1 to 49 cents gets the minimum sentence", () => {
    expect(payLinkSendNote(true, payOnlineEligibility({ ...base, balanceCents: 49 }))).toBe("No pay link: less than $0.50 is due on this invoice.");
    expect(payLinkSendNote(true, payOnlineEligibility({ ...base, balanceCents: 1 }))).toContain("$0.50");
  });

  it("eligible, not set up, not issued and off", () => {
    expect(payLinkSendNote(true, payOnlineEligibility({ ...base, balanceCents: 5000 }))).toContain("View and pay online");
    expect(payLinkSendNote(true, payOnlineEligibility({ ...base, configured: false, balanceCents: 5000 }))).toContain("not set up");
    expect(payLinkSendNote(true, payOnlineEligibility({ ...base, baseUrl: null, balanceCents: 5000 }))).toContain("not set up");
    const voided = payLinkSendNote(true, payOnlineEligibility({ ...base, status: "void", balanceCents: 5000 }));
    expect(voided).toBe("No pay link: only an issued invoice can be paid online.");
    expect(payLinkSendNote(false, payOnlineEligibility({ ...base, enabled: false, balanceCents: 5000 }))).toBeNull();
  });

  it("a bank payment still processing: its own sentence; no_balance wins over it, it wins over below_minimum", () => {
    expect(payLinkSendNote(true, payOnlineEligibility({ ...base, bankPending: true, balanceCents: 5000 }))).toBe("No pay link: a bank payment for this invoice is still processing.");
    expect(payOnlineEligibility({ ...base, bankPending: true, balanceCents: 0 })).toEqual({ ok: false, reason: "no_balance" });
    expect(payOnlineEligibility({ ...base, bankPending: true, balanceCents: 49 })).toEqual({ ok: false, reason: "bank_payment_pending" });
    expect(payOnlineEligibility({ ...base, bankPending: true, status: "void", balanceCents: 5000 })).toEqual({ ok: false, reason: "not_issued" });
  });

  it("the invoice page uses the helper instead of its own sentence", () => {
    const src = readFileSync(join(process.cwd(), "app/business/[slug]/invoices/[id]/page.tsx"), "utf8");
    expect(src).toContain("payLinkSendNote(onlineOn, eligible, ");
    expect(src).not.toContain("less than $0.50");
  });
});
