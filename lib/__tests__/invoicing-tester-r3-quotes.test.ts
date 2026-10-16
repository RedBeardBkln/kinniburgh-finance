// Tester round 3 (ek-consulting-invoicing): quote numbering config (naming, prefix, first number 2001, counters) through the REAL owner actions on the
// fake db, plus the pure helpers. The quote workflow is not built; these checks cover only setup, validation, counters and display.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase-storage", () => ({ uploadLogoFile: vi.fn(), downloadLogoFile: vi.fn() }));

import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import * as setup from "@/actions/invoicing-setup";
import * as invoices from "@/actions/invoices";
import * as clients from "@/actions/clients";
import { formatDisplayNumber, formatQuoteNumber, isValidDocumentNumber, isValidPrefix, isValidQuotePrefix } from "@/lib/invoicing/numbering";
import { MAX_DOC_NUMBER } from "@/lib/invoicing/constants";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const E = "11111111-1111-4111-8111-111111111111";
const ERIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SLUG = "ek-consulting";
const G = {
  ar: "10000000-0000-4000-8000-000000000001", unearned: "10000000-0000-4000-8000-000000000002", discounts: "10000000-0000-4000-8000-000000000003",
  billableIncome: "10000000-0000-4000-8000-000000000004", processingFees: "10000000-0000-4000-8000-000000000005",
};
const base = {
  slug: SLUG, goLiveOn: "2026-10-01", invoicePrefix: "", nextInvoiceNumber: 3100, quotePrefix: "Q-", nextQuoteNumber: 2001, numberPad: 0, defaultNetDays: 0,
  termsLabel: "Due upon receipt", businessAddress: "27 Old Barry Rd", glMap: G,
};

function seed() {
  process.env.ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: SLUG, dbaName: null, archivedAt: null }];
  fake.user.rows = [{ id: ERIC, name: "Eric Kinniburgh" }];
  fake.invoicingProfile.rows = [];
  fake.glCode.rows = [
    { id: G.ar, entityId: E, archivedAt: null, type: "asset", code: "1100", name: "Accounts Receivable (A/R)" },
    { id: G.unearned, entityId: E, archivedAt: null, type: "liability", code: "2100", name: "Deferred Revenue" },
    { id: G.discounts, entityId: E, archivedAt: null, type: "revenue", code: "4900", name: "Discounts" },
    { id: G.billableIncome, entityId: E, archivedAt: null, type: "revenue", code: "4100", name: "Billable Expense Income" },
    { id: G.processingFees, entityId: E, archivedAt: null, type: "expense", code: "6100", name: "Fees" },
  ];
  for (const t of [fake.client, fake.billingDocument, fake.billingLine, fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.auditLog]) t.rows = [];
  authMock.mockResolvedValue({ user: { id: ERIC, name: "Eric Kinniburgh" } });
}
beforeEach(seed);

describe("quote number formatting and validation (pure)", () => {
  it("the first quote prints Q-2001; padding and size never truncate; invoices keep 3100 with no prefix", () => {
    expect(formatQuoteNumber("Q-", 2001)).toBe("Q-2001");
    expect(formatQuoteNumber("Q-", 2001, 0)).toBe("Q-2001");
    expect(formatQuoteNumber("Q-", 2001, 6)).toBe("Q-002001");
    expect(formatQuoteNumber("Q-", 2001, 2)).toBe("Q-2001"); // never truncated
    expect(formatQuoteNumber("Q-", MAX_DOC_NUMBER)).toBe("Q-99999999");
    expect(formatDisplayNumber("", 3100, 0)).toBe("3100");
    expect(formatQuoteNumber("Q-", 3100)).not.toBe(formatDisplayNumber("", 3100, 0));
  });

  it("quote prefix: required and non-blank; allowed charset only; at most 12 characters", () => {
    for (const ok of ["Q-", "Q", "QT-", "QUOTE-", "Q/", "Q.", "Q_", "a1", "Q23456789012"]) expect(isValidQuotePrefix(ok), `[${ok}]`).toBe(true);
    for (const bad of ["", " ", "   ", "\t", "\n", "Q\n", "Q#", "Q-ü", "Q--​", "1234567890123", "Q  -", "Q ", "<b>", "Q;DROP", "Q'--"]) expect(isValidQuotePrefix(bad), `[${JSON.stringify(bad)}]`).toBe(false);
    // the invoice prefix may stay empty (invoices print with no prefix) but a quote prefix may not
    expect(isValidPrefix("")).toBe(true);
    expect(isValidQuotePrefix("")).toBe(false);
  });

  it("document numbers: whole, safe, 1..99,999,999 (inside a Postgres INTEGER)", () => {
    for (const ok of [1, 2001, 3100, MAX_DOC_NUMBER]) expect(isValidDocumentNumber(ok)).toBe(true);
    for (const bad of [0, -1, -2001, 1.5, 2000.0000001, NaN, Infinity, -Infinity, MAX_DOC_NUMBER + 1, 2 ** 31, 2 ** 53, Number.MAX_SAFE_INTEGER + 1]) expect(isValidDocumentNumber(bad as number), `${bad}`).toBe(false);
    expect(MAX_DOC_NUMBER).toBeLessThan(2 ** 31 - 1);
  });
});

describe("setup through the owner action", () => {
  it("valid setup stores quote prefix Q- and next quote 2001, invoice counter 3100, no invoice prefix", async () => {
    expect(await setup.setupInvoicing(base as never)).toEqual({ success: true });
    const p = fake.invoicingProfile.rows[0]!;
    expect(p).toMatchObject({ nextInvoiceNumber: 3100, invoicePrefix: "", quotePrefix: "Q-", nextQuoteNumber: 2001 });
  });

  it("bad quote prefix / quote number are all refused and NO profile row is created", async () => {
    const bad: Record<string, unknown>[] = [
      { quotePrefix: "" }, { quotePrefix: "   " }, { quotePrefix: "Q#" }, { quotePrefix: "ABCDEFGHIJKLM" }, { quotePrefix: "Q\n" },
      { nextQuoteNumber: 0 }, { nextQuoteNumber: -1 }, { nextQuoteNumber: -2001 }, { nextQuoteNumber: 1.5 }, { nextQuoteNumber: MAX_DOC_NUMBER + 1 }, { nextQuoteNumber: 2 ** 31 },
      { nextQuoteNumber: Number.NaN }, { nextQuoteNumber: Number.POSITIVE_INFINITY }, { nextQuoteNumber: "2001" }, { nextQuoteNumber: null }, { nextQuoteNumber: undefined },
      { quotePrefix: undefined }, { quotePrefix: null }, { quotePrefix: 5 },
      { nextInvoiceNumber: 0 }, { nextInvoiceNumber: -3100 }, { nextInvoiceNumber: 3100.5 }, { nextInvoiceNumber: MAX_DOC_NUMBER + 1 },
    ];
    for (const b of bad) {
      const r = await setup.setupInvoicing({ ...base, ...b } as never);
      expect(r, JSON.stringify(b)).toHaveProperty("error");
    }
    expect(fake.invoicingProfile.rows).toHaveLength(0);
  });

  it("setup cannot be run a second time to reset the counters", async () => {
    expect(await setup.setupInvoicing(base as never)).toEqual({ success: true });
    expect(await setup.setupInvoicing({ ...base, nextInvoiceNumber: 1, nextQuoteNumber: 1 } as never)).toHaveProperty("error");
    expect(fake.invoicingProfile.rows).toHaveLength(1);
    expect(fake.invoicingProfile.rows[0]).toMatchObject({ nextInvoiceNumber: 3100, nextQuoteNumber: 2001 });
  });
});

describe("counters only go up, are never reused, and invoices still start at the configured number", () => {
  const upd = (over: Record<string, unknown>) =>
    setup.updateInvoicingProfile({ slug: SLUG, invoicePrefix: "", numberPad: 0, defaultNetDays: 0, termsLabel: "Due upon receipt", businessAddress: "27 Old Barry Rd", showEinOnInvoice: false, quotePrefix: "Q-", nextQuoteNumber: 2001, glMap: G, ...over } as never);

  it("quote counter: same value ok, higher ok, lower refused (nothing else saved on a refusal), huge/negative/fractional refused", async () => {
    await setup.setupInvoicing(base as never);
    expect(await upd({})).toEqual({ success: true });
    expect(await upd({ nextQuoteNumber: 2500 })).toEqual({ success: true });
    expect(fake.invoicingProfile.rows[0]!.nextQuoteNumber).toBe(2500);
    const before = JSON.stringify(fake.invoicingProfile.rows);
    for (const n of [2499, 2001, 1, 0, -5, 2500.5, MAX_DOC_NUMBER + 1, 2 ** 31]) {
      const r = await upd({ nextQuoteNumber: n, termsLabel: "CHANGED" });
      expect(r, `${n}`).toHaveProperty("error");
    }
    expect(JSON.stringify(fake.invoicingProfile.rows)).toBe(before); // a refused counter saves nothing, including the other fields
    expect(await upd({ quotePrefix: "", nextQuoteNumber: 2500 })).toHaveProperty("error");
    expect(await upd({ quotePrefix: "QT-", nextQuoteNumber: 2500 })).toEqual({ success: true });
    expect(fake.invoicingProfile.rows[0]!.quotePrefix).toBe("QT-");
  });

  it("invoice counter: lower refused, never to an issued number; the first issued invoice is the configured 3100 and the counter then reads 3101", async () => {
    await setup.setupInvoicing(base as never);
    const c = (await clients.createClient({ slug: SLUG, name: "Acme" })) as { id: string };
    const d = (await invoices.saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c.id, lines: [{ description: "w", quantity: "1", unitPrice: "10.00", glCodeId: G.billableIncome }] } })) as { id: string; updatedAt: string };
    const iss = await invoices.issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt });
    expect(iss).toEqual({ success: true, displayNumber: "3100" });
    expect(fake.invoicingProfile.rows[0]!.nextInvoiceNumber).toBe(3101);
    for (const n of [3100, 3099, 1, 0, -1]) expect(await setup.setInvoiceCounterAction({ slug: SLUG, nextInvoiceNumber: n }), `${n}`).toHaveProperty("error");
    expect(await setup.setInvoiceCounterAction({ slug: SLUG, nextInvoiceNumber: 3200 })).toEqual({ success: true });
    expect(fake.invoicingProfile.rows[0]!.nextInvoiceNumber).toBe(3200);
    // the quote counter was not touched by any invoice operation
    expect(fake.invoicingProfile.rows[0]!.nextQuoteNumber).toBe(2001);
    // a quote number can never collide with an invoice number: different kind, different prefix
    expect(fake.billingDocument.rows.filter((r) => r.kind === "quote")).toHaveLength(0);
    expect(fake.billingDocument.rows.every((r) => r.kind === "invoice")).toBe(true);
  });

  it("issuing invoices never burns or reuses a number: 5 invoices, one voided, then a draft refused (archived client) = 3100..3104, next 3105", async () => {
    await setup.setupInvoicing(base as never);
    const c = (await clients.createClient({ slug: SLUG, name: "Acme" })) as { id: string };
    const mk = async () => {
      const d = (await invoices.saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c.id, lines: [{ description: "w", quantity: "1", unitPrice: "10.00", glCodeId: G.billableIncome }] } })) as { id: string; updatedAt: string };
      return d;
    };
    const nums: string[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const d = await mk();
      const r = (await invoices.issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt })) as { displayNumber: string };
      nums.push(r.displayNumber);
      ids.push(d.id);
    }
    expect(nums).toEqual(["3100", "3101", "3102", "3103", "3104"]);
    expect(await invoices.voidInvoice({ slug: SLUG, documentId: ids[2]!, reason: "dup" })).toEqual({ success: true });
    expect(fake.billingDocument.rows.find((r) => r.id === ids[2])!.displayNumber).toBe("3102"); // the voided number is kept
    const d6 = await mk();
    fake.client.rows[0]!.archivedAt = new Date();
    expect(await invoices.issueInvoice({ slug: SLUG, documentId: d6.id, expectedUpdatedAt: d6.updatedAt })).toHaveProperty("error");
    expect(fake.invoicingProfile.rows[0]!.nextInvoiceNumber).toBe(3105); // refused issue burned nothing
    expect(await setup.setInvoiceCounterAction({ slug: SLUG, nextInvoiceNumber: 3102 })).toHaveProperty("error"); // cannot go back to a voided number
  });
});
