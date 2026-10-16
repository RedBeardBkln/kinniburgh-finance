import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase-storage", () => ({ uploadLogoFile: vi.fn(async () => undefined), downloadLogoFile: vi.fn() }));

import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { uploadLogoFile } from "@/lib/supabase-storage";
import {
  removeInvoiceLogo,
  revealBusinessEin,
  revealRemitBankText,
  setBusinessEin,
  setInvoiceCounterAction,
  setRemitBankText,
  setRemitMailing,
  setupInvoicing,
  updateInvoicingProfile,
  uploadInvoiceLogo,
} from "@/actions/invoicing-setup";
import { createItem, updateItem, archiveItem } from "@/actions/reimbursable-items";
import { NOT_INVOICING_OWNER_MESSAGE } from "@/lib/invoicing/owner";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const E = "11111111-1111-4111-8111-111111111111";
const ERIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EVA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const SLUG = "ek-consulting";
const GL = { ar: "10000000-0000-4000-8000-000000000001", unearned: "10000000-0000-4000-8000-000000000002", discounts: "10000000-0000-4000-8000-000000000003", billableIncome: "10000000-0000-4000-8000-000000000004", processingFees: "10000000-0000-4000-8000-000000000005" };
const SERVICES = "10000000-0000-4000-8000-000000000006";
const asUser = (id: string) => authMock.mockResolvedValue({ user: { id, name: "x" } });

const setupInput = (over: Record<string, unknown> = {}) => ({
  slug: SLUG,
  goLiveOn: "2026-10-01",
  invoicePrefix: "",
  nextInvoiceNumber: 3100,
  quotePrefix: "Q-",
  nextQuoteNumber: 2001,
  numberPad: 0,
  defaultNetDays: 0,
  termsLabel: "Due upon receipt",
  businessAddress: "1 Test Road\nTestville, CT 00000",
  replyToEmail: "owner@example.com",
  fromName: "Test Business",
  footerText: "Thank you for your business.",
  termsText: null,
  remitToMailingAddress: "1 Test Road\nTestville, CT 00000",
  checkPayableTo: "Eric Kinniburgh Consulting, LLC",
  glMap: GL,
  ...over,
});

function seed(withProfile = false) {
  process.env.ENCRYPTION_KEY = "0123456789abcdef".repeat(4); // a throwaway test key, not a secret
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: SLUG, dbaName: "LaunchTime Solutions", archivedAt: null }];
  fake.user.rows = [{ id: ERIC, name: "Eric Kinniburgh" }, { id: EVA, name: "Eva-Laura Ramirez-Wisiackas" }];
  fake.glCode.rows = [
    { id: GL.ar, entityId: E, code: "1100", name: "Accounts Receivable (A/R)", type: "asset", archivedAt: null },
    { id: GL.unearned, entityId: E, code: "2100", name: "Deferred Revenue", type: "liability", archivedAt: null },
    { id: GL.discounts, entityId: E, code: "4900", name: "Refunds to customers", type: "revenue", archivedAt: null },
    { id: GL.billableIncome, entityId: E, code: "4100", name: "Billable Expense Income", type: "revenue", archivedAt: null },
    { id: GL.processingFees, entityId: E, code: "6500", name: "Merchant account fees", type: "expense", archivedAt: null },
    { id: SERVICES, entityId: E, code: "4000", name: "Services", type: "revenue", archivedAt: null },
  ];
  fake.invoicingProfile.rows = withProfile
    ? [{ id: "p1", entityId: E, enabled: true, goLiveOn: new Date("2026-10-01T00:00:00Z"), invoicePrefix: "", nextInvoiceNumber: 3100, numberPad: 0, defaultNetDays: 0, termsLabel: "Due upon receipt", quotePrefix: "Q-", nextQuoteNumber: 2001, businessAddress: "1 Test Road", glMap: GL, remitToUpdatedAt: null }]
    : [];
  for (const t of [fake.client, fake.billingDocument, fake.billingPayment, fake.billingEvent, fake.auditLog, fake.reimbursableItem]) t.rows = [];
}

beforeEach(() => {
  seed();
  vi.mocked(uploadLogoFile).mockClear();
});

describe("first-time setup (owner-only; the owner types every value)", () => {
  it("Eva cannot set up invoicing", async () => {
    asUser(EVA);
    expect(await setupInvoicing(setupInput())).toEqual({ error: NOT_INVOICING_OWNER_MESSAGE });
    expect(fake.invoicingProfile.rows).toHaveLength(0);
  });
  it("the owner's typed values become the profile (start number 3100, no prefix, go-live, terms, footer)", async () => {
    asUser(ERIC);
    expect(await setupInvoicing(setupInput())).toEqual({ success: true });
    const p = fake.invoicingProfile.rows[0]!;
    expect(p.nextInvoiceNumber).toBe(3100);
    expect(p.invoicePrefix).toBe("");
    expect(p.goLiveOn).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    expect(p.termsLabel).toBe("Due upon receipt");
    expect(p.footerText).toBe("Thank you for your business.");
    expect(p.enabled).toBe(true);
    expect(p.glMap).toEqual(GL);
    expect(fake.auditLog.rows.map((r) => r.changeType)).toEqual(["invoicing_setup"]);
  });
  it("refuses a second setup, a bad date, a bad prefix and a zero start number", async () => {
    asUser(ERIC);
    expect(await setupInvoicing(setupInput({ goLiveOn: "2026-02-30" }))).toMatchObject({ error: expect.stringMatching(/real date/) });
    expect(await setupInvoicing(setupInput({ invoicePrefix: "a<b" }))).toMatchObject({ error: expect.stringMatching(/prefix/) });
    expect(await setupInvoicing(setupInput({ nextInvoiceNumber: 0 }))).toMatchObject({ error: expect.stringMatching(/first invoice number/) });
    expect(await setupInvoicing(setupInput({ businessAddress: "" }))).toMatchObject({ error: expect.stringMatching(/required/) });
    expect(await setupInvoicing(setupInput())).toEqual({ success: true });
    expect(await setupInvoicing(setupInput())).toMatchObject({ error: expect.stringMatching(/already set up/) });
  });
  it("validates the account map: a wrong type, an archived or another entity's account is refused", async () => {
    asUser(ERIC);
    expect(await setupInvoicing(setupInput({ glMap: { ...GL, ar: GL.unearned } }))).toMatchObject({ error: expect.stringMatching(/wrong type/) });
    fake.glCode.rows.find((g) => g.id === GL.billableIncome)!.archivedAt = new Date("2026-01-01T00:00:00Z");
    expect(await setupInvoicing(setupInput())).toMatchObject({ error: expect.stringMatching(/archived/) });
    seed();
    fake.glCode.rows.find((g) => g.id === GL.ar)!.entityId = "someone-else";
    expect(await setupInvoicing(setupInput())).toMatchObject({ error: expect.stringMatching(/does not belong/) });
    expect(fake.invoicingProfile.rows).toHaveLength(0);
  });
  it("only the allow-listed business can be set up", async () => {
    asUser(ERIC);
    fake.entity.rows.push({ id: "e2", name: "Sudden Valley Property Management LLC", slug: "sudden-valley", dbaName: null, archivedAt: null });
    expect(await setupInvoicing(setupInput({ slug: "sudden-valley" }))).toEqual({ error: "Invoicing is not available for this business." });
  });
});

describe("settings", () => {
  beforeEach(() => seed(true));
  it("the invoice counter only goes up and never to a used number", async () => {
    asUser(ERIC);
    expect(await setInvoiceCounterAction({ slug: SLUG, nextInvoiceNumber: 3200 })).toEqual({ success: true });
    expect(fake.invoicingProfile.rows[0]!.nextInvoiceNumber).toBe(3200);
    expect(await setInvoiceCounterAction({ slug: SLUG, nextInvoiceNumber: 3100 })).toMatchObject({ error: expect.stringMatching(/only go up/) });
    fake.billingDocument.rows.push({ id: "d1", entityId: E, kind: "invoice", number: 3299, status: "void" });
    expect(await setInvoiceCounterAction({ slug: SLUG, nextInvoiceNumber: 3299 })).toMatchObject({ error: expect.stringMatching(/never reused/) });
    expect(await setInvoiceCounterAction({ slug: SLUG, nextInvoiceNumber: 3300 })).toEqual({ success: true });
  });
  it("Eva cannot change settings, the counter, remit-to or the EIN", async () => {
    asUser(EVA);
    const refused = { error: NOT_INVOICING_OWNER_MESSAGE };
    expect(await setInvoiceCounterAction({ slug: SLUG, nextInvoiceNumber: 4000 })).toEqual(refused);
    expect(await setRemitMailing({ slug: SLUG, remitToMailingAddress: "x", checkPayableTo: "y" })).toEqual(refused);
    expect(await setRemitBankText({ slug: SLUG, text: "bank", includeByDefault: false })).toEqual(refused);
    expect(await revealRemitBankText({ slug: SLUG })).toEqual(refused);
    expect(await setBusinessEin({ slug: SLUG, ein: "12-3456789" })).toEqual(refused);
    expect(await revealBusinessEin({ slug: SLUG })).toEqual(refused);
    expect(await removeInvoiceLogo({ slug: SLUG })).toEqual(refused);
    expect(fake.invoicingProfile.rows[0]!.nextInvoiceNumber).toBe(3100);
  });
  it("the quote counter (first quote Q-2001) only goes up, never to a used number, and the prefix is required", async () => {
    asUser(ERIC);
    const base = { slug: SLUG, invoicePrefix: "", numberPad: 0, defaultNetDays: 0, termsLabel: "Due upon receipt", businessAddress: "1 Test Road", showEinOnInvoice: false, quotePrefix: "Q-", glMap: GL };
    expect(await updateInvoicingProfile({ ...base, nextQuoteNumber: 2001 })).toEqual({ success: true }); // unchanged is fine
    expect(fake.invoicingProfile.rows[0]!.nextQuoteNumber).toBe(2001);
    expect(await updateInvoicingProfile({ ...base, nextQuoteNumber: 2500 })).toEqual({ success: true });
    expect(fake.invoicingProfile.rows[0]!.nextQuoteNumber).toBe(2500);
    expect(await updateInvoicingProfile({ ...base, nextQuoteNumber: 2400 })).toMatchObject({ error: expect.stringMatching(/only go up/) });
    expect(fake.invoicingProfile.rows[0]!.nextQuoteNumber).toBe(2500);
    expect(await updateInvoicingProfile({ ...base, quotePrefix: "", nextQuoteNumber: 2500 })).toMatchObject({ error: expect.stringMatching(/quote prefix is required/) });
    expect(await updateInvoicingProfile({ ...base, nextQuoteNumber: 0 })).toMatchObject({ error: expect.stringMatching(/whole number/) });
    // a used quote number blocks the counter (the store re-checks under the profile lock)
    fake.billingDocument.rows.push({ id: "q1", entityId: E, kind: "quote", number: 2600, status: "draft" });
    expect(await updateInvoicingProfile({ ...base, nextQuoteNumber: 2600 })).toMatchObject({ error: expect.stringMatching(/never reused/) });
    expect(await updateInvoicingProfile({ ...base, nextQuoteNumber: 2601 })).toEqual({ success: true });
    // Invoice numbering is untouched by the quote counter.
    expect(fake.invoicingProfile.rows[0]!.nextInvoiceNumber).toBe(3100);
  });
  it("L-2 on the server: a digits-only, space-padded or invoice-equal quote prefix is refused at setup and on update, saving nothing", async () => {
    asUser(ERIC);
    const base = { slug: SLUG, invoicePrefix: "INV-", numberPad: 0, defaultNetDays: 0, termsLabel: "Due upon receipt", businessAddress: "1 Test Road", showEinOnInvoice: false, glMap: GL, nextQuoteNumber: 2001 };
    const before = JSON.stringify(fake.invoicingProfile.rows);
    for (const quotePrefix of ["3", "2026", "Q- ", " Q-", "INV-", "inv-", ""]) {
      expect(await updateInvoicingProfile({ ...base, quotePrefix }), `[${quotePrefix}]`).toMatchObject({ error: expect.stringMatching(/quote prefix is required/) });
    }
    expect(JSON.stringify(fake.invoicingProfile.rows)).toBe(before);
    expect(await updateInvoicingProfile({ ...base, quotePrefix: "Q-" })).toEqual({ success: true });
    seed(false);
    for (const quotePrefix of ["3", "Q- ", "INV-"]) {
      expect(await setupInvoicing(setupInput({ invoicePrefix: "INV-", quotePrefix })), `[${quotePrefix}]`).toMatchObject({ error: expect.stringMatching(/quote prefix is required/) });
    }
    expect(fake.invoicingProfile.rows).toHaveLength(0);
  });
  it("first-time setup stores the quote prefix and the REQUIRED first quote number", async () => {
    seed(false);
    asUser(ERIC);
    expect(await setupInvoicing(setupInput())).toEqual({ success: true });
    expect(fake.invoicingProfile.rows[0]).toMatchObject({ quotePrefix: "Q-", nextQuoteNumber: 2001, invoicePrefix: "", nextInvoiceNumber: 3100 });
    seed(false);
    expect(await setupInvoicing(setupInput({ quotePrefix: "" }))).toMatchObject({ error: expect.stringMatching(/quote prefix is required/) });
    expect(await setupInvoicing(setupInput({ nextQuoteNumber: 0 }))).toMatchObject({ error: expect.stringMatching(/first quote number/) });
    expect(await setupInvoicing(setupInput({ nextQuoteNumber: undefined }))).toMatchObject({ error: expect.stringMatching(/missing or invalid/) });
    expect(fake.invoicingProfile.rows).toHaveLength(0);
  });
  it("bank text is stored ENCRYPTED, never in the audit trail, revealed only to the owner, and a routing number is allowed", async () => {
    asUser(ERIC);
    const text = "Test Bank\nRouting 021000021\nAccount 000123456789";
    expect(await setRemitBankText({ slug: SLUG, text, includeByDefault: true })).toEqual({ success: true });
    const p = fake.invoicingProfile.rows[0]!;
    expect(String(p.remitToEncrypted)).not.toMatch(/021000021|Routing|Test Bank/);
    expect(String(p.remitToEncrypted).split(":")).toHaveLength(3);
    expect(p.remitToUpdatedAt).toBeInstanceOf(Date);
    expect(p.remitToApprovedById).toBe(ERIC);
    expect(p.includeRemitToByDefault).toBe(true);
    expect(JSON.stringify(fake.auditLog.rows)).not.toMatch(/021000021|Routing|Test Bank|000123456789/);
    expect(await revealRemitBankText({ slug: SLUG })).toEqual({ success: true, text });
    // Clearing removes it and turns the default off.
    expect(await setRemitBankText({ slug: SLUG, text: "  ", includeByDefault: true })).toEqual({ success: true });
    expect(p.remitToEncrypted).toBeNull();
    expect(p.includeRemitToByDefault).toBe(false);
  });
  it("an SSN-shaped (grouped) value is refused in the bank text", async () => {
    asUser(ERIC);
    expect(await setRemitBankText({ slug: SLUG, text: "ssn 123-45-6789", includeByDefault: false })).toMatchObject({ error: expect.stringMatching(/Social Security/) });
    expect(fake.invoicingProfile.rows[0]!.remitToEncrypted ?? null).toBeNull();
  });
  it("the business EIN is encrypted with last four only visible; SSN format refused", async () => {
    asUser(ERIC);
    expect(await setBusinessEin({ slug: SLUG, ein: "98-7654321" })).toEqual({ success: true });
    const p = fake.invoicingProfile.rows[0]!;
    expect(p.einLast4).toBe("4321");
    expect(String(p.einEncrypted)).not.toMatch(/987654321/);
    expect(await revealBusinessEin({ slug: SLUG })).toEqual({ success: true, ein: "98-7654321" });
    expect(await setBusinessEin({ slug: SLUG, ein: "123-45-6789" })).toMatchObject({ error: expect.stringMatching(/Social Security/) });
    expect(JSON.stringify(fake.auditLog.rows)).not.toMatch(/7654321/);
  });
  it("mailing address and check payee are plain business text, SSN-like text refused", async () => {
    asUser(ERIC);
    expect(await setRemitMailing({ slug: SLUG, remitToMailingAddress: "1 Test Road", checkPayableTo: "Eric Kinniburgh Consulting, LLC" })).toEqual({ success: true });
    expect(fake.invoicingProfile.rows[0]!.checkPayableTo).toBe("Eric Kinniburgh Consulting, LLC");
    expect(await setRemitMailing({ slug: SLUG, remitToMailingAddress: "123-45-6789", checkPayableTo: "x" })).toMatchObject({ error: expect.stringMatching(/Social Security/) });
  });
});

describe("logo upload", () => {
  beforeEach(() => seed(true));
  const form = (bytes: Uint8Array, name = "logo.png") => {
    const fd = new FormData();
    fd.set("slug", SLUG);
    fd.set("file", new File([Buffer.from(bytes)], name));
    return fd;
  };
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  it("accepts a PNG by its first bytes and stores the key under the entity", async () => {
    asUser(ERIC);
    expect(await uploadInvoiceLogo(form(PNG))).toEqual({ success: true });
    expect(uploadLogoFile).toHaveBeenCalledTimes(1);
    const p = fake.invoicingProfile.rows[0]!;
    expect(String(p.logoKey)).toMatch(new RegExp(`^invoicing/${E}/logo-.*\\.png$`));
    expect(p.logoMime).toBe("image/png");
  });
  it("refuses a non-image (even if named .png), an oversize file and a non-owner", async () => {
    asUser(ERIC);
    expect(await uploadInvoiceLogo(form(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])))).toMatchObject({ error: expect.stringMatching(/PNG or JPEG/) });
    expect(await uploadInvoiceLogo(form(new Uint8Array(512 * 1024 + 1)))).toMatchObject({ error: expect.stringMatching(/512 KB/) });
    asUser(EVA);
    expect(await uploadInvoiceLogo(form(PNG))).toEqual({ error: NOT_INVOICING_OWNER_MESSAGE });
    expect(uploadLogoFile).not.toHaveBeenCalled();
  });
});

describe("reimbursable items (gross default)", () => {
  beforeEach(() => seed(true));
  it("creates a markup item and derives nothing on the server that the shared function does not give", async () => {
    asUser(ERIC); // only the owner maintains the catalog (Eva is read-only; see invoicing-eva-readonly.test.ts)
    const r = await createItem({ slug: SLUG, name: "Prints", unit: "ea", unitCost: "200.00", pricingMode: "markup", markupPercent: "10", glCodeId: GL.billableIncome, taxable: false });
    expect("id" in r).toBe(true);
    const row = fake.reimbursableItem.rows[0]!;
    expect(row.unitCostCents).toBe(20000);
    expect(row.markupBps).toBe(1000);
    expect(row.billedUnitPriceCents).toBeNull();
    expect(Object.keys(row).some((k) => /stock|onhand|quantity/i.test(k))).toBe(false);
  });
  it("refuses another entity's or archived income account, bad prices, and duplicate names", async () => {
    asUser(ERIC);
    const base = { slug: SLUG, name: "Prints", unit: "ea", unitCost: "5", pricingMode: "fixed_price" as const, billedUnitPrice: "9.99", glCodeId: GL.billableIncome };
    fake.glCode.rows.find((g) => g.id === GL.billableIncome)!.archivedAt = new Date("2026-01-01T00:00:00Z");
    expect(await createItem(base)).toMatchObject({ error: expect.stringMatching(/income accounts/) });
    fake.glCode.rows.find((g) => g.id === GL.billableIncome)!.archivedAt = null;
    expect(await createItem({ ...base, billedUnitPrice: "-1" })).toMatchObject({ error: expect.stringMatching(/Billed price/) });
    expect("id" in (await createItem(base))).toBe(true);
    expect(await createItem(base)).toMatchObject({ error: expect.stringMatching(/already exists/) });
  });
  it("update and archive keep the row (archive-only)", async () => {
    asUser(ERIC);
    const r = await createItem({ slug: SLUG, name: "Prints", unit: "ea", unitCost: "5", pricingMode: "markup", markupPercent: "", glCodeId: GL.billableIncome });
    if (!("id" in r)) throw new Error("not created");
    expect(await updateItem({ slug: SLUG, id: r.id, name: "Prints", unit: "ea", unitCost: "6", pricingMode: "markup", markupPercent: "20", glCodeId: GL.billableIncome })).toEqual({ success: true });
    expect(fake.reimbursableItem.rows[0]!.unitCostCents).toBe(600);
    expect(await archiveItem({ slug: SLUG, id: r.id })).toEqual({ success: true });
    expect(fake.reimbursableItem.rows).toHaveLength(1);
    expect(fake.reimbursableItem.rows[0]!.archivedAt).toBeInstanceOf(Date);
  });
});
