// The owner's view of a bank (ACH) payment still processing (stripe-ach-pending-hide-pay): the list on the invoice page and the Online
// payments page, its owner-only "Stop waiting for this payment" button, and the page wiring.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/actions/invoices", () => ({ markStripeFlagReviewed: vi.fn(), releaseBankPending: vi.fn() }));
vi.mock("@/actions/billing-payments", () => ({ linkPayoutDeposit: vi.fn(), refreshStripeFee: vi.fn(), searchPayoutCandidates: vi.fn() }));

import { BankPendingList, type BankPendingRow } from "@/components/invoicing/online-payments";

(globalThis as unknown as { React: typeof React }).React = React;
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
const DOC = "33333333-3333-4333-8333-333333333333";
const row = (over: Partial<BankPendingRow> = {}): BankPendingRow => ({ id: "ev1", documentId: DOC, invoiceNumber: "3100", amountCents: 10_000, startedOn: "2026-10-23", overdue: false, livemode: false, ...over });

describe("BankPendingList", () => {
  it("the owner sees amount, start date, the invoice link, a Test mode chip and the release button", () => {
    const h = renderToStaticMarkup(<BankPendingList slug="ek-consulting" rows={[row()]} canEdit showInvoice />);
    expect(h).toContain("Bank payment processing: $100.00, started Oct 23, 2026; it usually takes up to 4 business days.");
    expect(h).toContain(`/business/ek-consulting/invoices/${DOC}`);
    expect(h).toContain("3100");
    expect(h).toContain("Test mode");
    expect(h).toContain("Stop waiting for this payment");
  });
  it("Eva (not the owner) reads the same text without the button", () => {
    const h = renderToStaticMarkup(<BankPendingList slug="ek-consulting" rows={[row()]} canEdit={false} showInvoice={false} />);
    expect(h).toContain("Bank payment processing: $100.00");
    expect(h).not.toContain("Stop waiting");
    expect(h).not.toContain("<button");
  });
  it("an overdue payment carries the 'check it in Stripe' sentence; a live row has no Test mode chip; none says so", () => {
    const h = renderToStaticMarkup(<BankPendingList slug="ek-consulting" rows={[row({ overdue: true, livemode: true })]} canEdit showInvoice={false} />);
    expect(h).toContain("Bank payment processing for more than 10 business days: check it in Stripe.");
    expect(h).not.toContain("Test mode");
    expect(renderToStaticMarkup(<BankPendingList slug="ek-consulting" rows={[]} canEdit showInvoice />)).toContain("None.");
  });
});

describe("page wiring", () => {
  it("the invoice page: timeline labels, fixed send notices, the processing card and the unreadable line", () => {
    const src = read("app/business/[slug]/invoices/[id]/page.tsx");
    expect(src).toContain('bank_payment_pending: "Bank payment processing (ACH)"');
    expect(src).toContain('bank_payment_released: "Stopped waiting for a bank payment"');
    expect(src).toMatch(/ok_bankpending: \{ ok: true/);
    expect(src).toMatch(/ok_nolinkcheck: \{ ok: true/);
    expect(src).toContain("Bank payment processing</CardTitle>");
    expect(src).toContain("OWNER_BANK_PENDING_UNREADABLE");
    expect(src).toContain("bankPending: bankPendingFailed || bankPending !== null");
  });
  it("the Online payments page lists them and survives a failed read", () => {
    const src = read("app/business/[slug]/invoicing/payments-online/page.tsx");
    expect(src).toContain("Bank payments processing</CardTitle>");
    expect(src).toContain("overview.bankPendingFailed");
    expect(src).toContain("<BankPendingList");
  });
  it("the release button confirms first with the plan's sentence", () => {
    const src = read("components/invoicing/online-payments.tsx");
    expect(src).toMatch(/window\.confirm\(BANK_RELEASE_CONFIRM\)/);
  });
});
