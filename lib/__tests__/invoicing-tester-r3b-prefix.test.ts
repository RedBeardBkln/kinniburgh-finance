// Tester round 3b (ek-consulting-invoicing): L-2 quote prefix rules (spaces, case-insensitive equality with the invoice prefix, 12 vs 13 characters,
// digits only, punctuation only, unicode) in the pure function and through the owner actions (a refusal leaves the profile byte-identical).
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
import { isValidQuotePrefix } from "@/lib/invoicing/numbering";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const E = "11111111-1111-4111-8111-111111111111";
const ERIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SLUG = "ek-consulting";
const G = {
  ar: "10000000-0000-4000-8000-000000000001", unearned: "10000000-0000-4000-8000-000000000002", discounts: "10000000-0000-4000-8000-000000000003",
  billableIncome: "10000000-0000-4000-8000-000000000004", processingFees: "10000000-0000-4000-8000-000000000005",
};
const base = { slug: SLUG, goLiveOn: "2026-10-01", invoicePrefix: "", nextInvoiceNumber: 3100, quotePrefix: "Q-", nextQuoteNumber: 2001, numberPad: 0, defaultNetDays: 0, termsLabel: "Due upon receipt", businessAddress: "27 Old Barry Rd", glMap: G };
beforeEach(() => {
  process.env.ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: SLUG, dbaName: null, archivedAt: null }];
  fake.user.rows = [{ id: ERIC, name: "Eric Kinniburgh" }];
  fake.invoicingProfile.rows = [];
  fake.glCode.rows = [
    { id: G.ar, entityId: E, archivedAt: null, type: "asset", code: "1", name: "AR" }, { id: G.unearned, entityId: E, archivedAt: null, type: "liability", code: "2", name: "D" },
    { id: G.discounts, entityId: E, archivedAt: null, type: "revenue", code: "3", name: "Disc" }, { id: G.billableIncome, entityId: E, archivedAt: null, type: "revenue", code: "4", name: "B" },
    { id: G.processingFees, entityId: E, archivedAt: null, type: "expense", code: "5", name: "F" },
  ];
  for (const t of [fake.client, fake.billingDocument, fake.billingLine, fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.auditLog]) t.rows = [];
  authMock.mockResolvedValue({ user: { id: ERIC, name: "Eric Kinniburgh" } });
});

describe("L-2 pure rules", () => {
  it("accepted", () => {
    for (const p of ["Q-", "Q", "q", "QT-", "3-", "2026-Q", "Q23456789012", "A.B_C/D-", "x1", "-", "_", "/", "."]) expect(isValidQuotePrefix(p, ""), `[${p}]`).toBe(true);
  });
  it("refused: spaces, empty, digits only, 13 chars, unicode, controls, injection", () => {
    const bad = ["", " ", "  ", " Q-", "Q- ", "Q  -", "\tQ", "Q\n", "3", "2026", "0", "123456789012", "1234567890123", "Q234567890123", "Q-ü", "Ｑ-", "Q\u200b", "Q\u00a0", "Q-\u0000", "<b>", "Q;", "Q'", "Q-€", "Ωmega", "😀"];
    for (const p of bad) expect(isValidQuotePrefix(p, ""), `[${JSON.stringify(p)}]`).toBe(false);
  });
  it("an INTERNAL single space is accepted (informational: prints \"Q - 2001\"; leading, trailing and double spaces are refused)", () => {
    expect(isValidQuotePrefix("Q -")).toBe(true);
  });
  it("12 characters ok, 13 refused", () => {
    expect(isValidQuotePrefix("QQQQQQQQQQQQ")).toBe(true);
    expect(isValidQuotePrefix("QQQQQQQQQQQQQ")).toBe(false);
  });
  it("differs from the invoice prefix, case-insensitively, invoice prefix trimmed", () => {
    expect(isValidQuotePrefix("Q-", "Q-")).toBe(false);
    expect(isValidQuotePrefix("q-", "Q-")).toBe(false);
    expect(isValidQuotePrefix("Q-", "q-")).toBe(false);
    expect(isValidQuotePrefix("Q-", " Q- ")).toBe(false);
    expect(isValidQuotePrefix("Q-", "Q")).toBe(true);
    expect(isValidQuotePrefix("Q-", "INV-")).toBe(true);
    expect(isValidQuotePrefix("Q-", "")).toBe(true); // empty invoice prefix cannot equal a non-empty quote prefix
  });
  it("punctuation-only prefixes: allowed characters make them valid (they contain a non-digit); disallowed ones are not", () => {
    expect(isValidQuotePrefix("--")).toBe(true);
    expect(isValidQuotePrefix("#")).toBe(false);
    expect(isValidQuotePrefix("()")).toBe(false);
  });
});

describe("L-2 through the owner actions", () => {
  const upd = (over: Record<string, unknown>) =>
    setup.updateInvoicingProfile({ slug: SLUG, invoicePrefix: "", numberPad: 0, defaultNetDays: 0, termsLabel: "Due upon receipt", businessAddress: "27 Old Barry Rd", showEinOnInvoice: false, quotePrefix: "Q-", nextQuoteNumber: 2001, glMap: G, ...over } as never);

  it("setup refuses each bad prefix (and an equal invoice/quote prefix) and creates nothing", async () => {
    for (const b of [{ quotePrefix: "3" }, { quotePrefix: " Q-" }, { quotePrefix: "Q- " }, { quotePrefix: "" }, { quotePrefix: "QQQQQQQQQQQQQ" }, { quotePrefix: "INV-", invoicePrefix: "inv-" }, { quotePrefix: "Q-", invoicePrefix: " Q-" }, { quotePrefix: "Q-ü" }]) {
      const r = await setup.setupInvoicing({ ...base, ...b } as never);
      expect(r, JSON.stringify(b)).toHaveProperty("error");
    }
    expect(fake.invoicingProfile.rows).toHaveLength(0);
    expect(await setup.setupInvoicing({ ...base, invoicePrefix: "INV-", quotePrefix: "Q-" } as never)).toEqual({ success: true });
  });

  it("update refuses and the whole profile stays byte-identical; invoice prefix change that would collide with the quote prefix is refused too", async () => {
    await setup.setupInvoicing(base as never);
    const before = JSON.stringify(fake.invoicingProfile.rows);
    for (const b of [{ quotePrefix: "3" }, { quotePrefix: "Q- " }, { quotePrefix: "" }, { quotePrefix: "Q23456789012X" }, { invoicePrefix: "q-" }, { invoicePrefix: "Q-" }, { quotePrefix: "Ωmega" }]) {
      const r = await upd({ termsLabel: "CHANGED", nextQuoteNumber: 2600, ...b });
      expect(r, JSON.stringify(b)).toHaveProperty("error");
      expect(JSON.stringify(fake.invoicingProfile.rows), JSON.stringify(b)).toBe(before);
    }
    expect(await upd({ quotePrefix: "QT-" })).toEqual({ success: true });
    expect(fake.invoicingProfile.rows[0]!.quotePrefix).toBe("QT-");
  });
});
