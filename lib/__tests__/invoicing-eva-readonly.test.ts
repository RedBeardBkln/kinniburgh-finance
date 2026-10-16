// Round 3 (owner decision 2026-10-16): Eva, and any other signed-in non-owner, has READ-ONLY access to the invoicing suite.
// Every exported action of the five invoicing action files must refuse a non-owner BEFORE doing any work, and must change nothing.
// The harness runs the real actions + store + gate over the in-memory fake db with an Eva-like non-owner user.
//
// The test also fails when a new export is added without an input factory below, so the next action cannot slip in ungated.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTable, type FakeDb } from "./invoicing-fake-db";

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
import * as invoices from "@/actions/invoices";
import * as clients from "@/actions/clients";
import * as items from "@/actions/reimbursable-items";
import * as payments from "@/actions/billing-payments";
import * as setup from "@/actions/invoicing-setup";
import { NOT_INVOICING_OWNER_MESSAGE } from "@/lib/invoicing/owner";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const E = "11111111-1111-4111-8111-111111111111";
const ERIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EVA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const STRANGER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"; // signed in, but not even a row in the user table
const U = "22222222-2222-4222-8222-222222222222";
const GL = { ar: "10000000-0000-4000-8000-000000000001", unearned: "10000000-0000-4000-8000-000000000002", discounts: "10000000-0000-4000-8000-000000000003", billableIncome: "10000000-0000-4000-8000-000000000004", processingFees: "10000000-0000-4000-8000-000000000005" };
const SLUG = "ek-consulting";
const STAMP = "2026-10-15T12:00:00.000Z";
const asUser = (id: string) => authMock.mockResolvedValue({ user: { id, name: id === ERIC ? "Eric Kinniburgh" : "Eva" } });

const pngForm = () => {
  const f = new FormData();
  f.set("slug", SLUG);
  f.set("file", new File([Buffer.from(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]))], "logo.png", { type: "image/png" }));
  return f;
};
const profileInput = {
  slug: SLUG, invoicePrefix: "", numberPad: 0, defaultNetDays: 0, termsLabel: "Due upon receipt", businessAddress: "1 Test Road", showEinOnInvoice: false,
  quotePrefix: "Q-", nextQuoteNumber: 2001, glMap: GL,
};
const setupInput = {
  slug: SLUG, goLiveOn: "2026-10-01", invoicePrefix: "", nextInvoiceNumber: 3100, quotePrefix: "Q-", nextQuoteNumber: 2001, numberPad: 0, defaultNetDays: 0,
  termsLabel: "Due upon receipt", businessAddress: "1 Test Road", glMap: GL,
};
const itemInput = { slug: SLUG, name: "Prints", unit: "ea", unitCost: "1.00", pricingMode: "markup" as const, markupPercent: "10", glCodeId: U };
const contactInput = { slug: SLUG, clientId: U, name: "Pat", email: "pat@example.com", role: "billing" as const, receivesInvoices: false };

/** One valid-shaped call per export (the owner gate runs after input parsing, so the shapes must pass zod). */
const CALLS: Record<string, () => Promise<unknown>> = {
  // invoices
  saveDraft: () => invoices.saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: U, lines: [] } }),
  issueInvoice: () => invoices.issueInvoice({ slug: SLUG, documentId: U, expectedUpdatedAt: STAMP }),
  voidInvoice: () => invoices.voidInvoice({ slug: SLUG, documentId: U, reason: "x" }),
  archiveDraft: () => invoices.archiveDraft({ slug: SLUG, documentId: U, expectedUpdatedAt: STAMP }),
  duplicateInvoice: () => invoices.duplicateInvoice({ slug: SLUG, documentId: U }),
  // clients
  createClient: () => clients.createClient({ slug: SLUG, name: "Acme" }),
  updateClient: () => clients.updateClient({ slug: SLUG, id: U, name: "Acme" }),
  archiveClient: () => clients.archiveClient({ slug: SLUG, id: U }),
  addContact: () => clients.addContact(contactInput),
  updateContact: () => clients.updateContact({ ...contactInput, contactId: U }),
  archiveContact: () => clients.archiveContact({ slug: SLUG, clientId: U, contactId: U }),
  setClientEin: () => clients.setClientEin({ slug: SLUG, id: U, ein: "12-3456789" }),
  revealClientEin: () => clients.revealClientEin({ slug: SLUG, id: U }),
  linkClientW9: () => clients.linkClientW9({ slug: SLUG, clientId: U, documentId: U }),
  // items
  createItem: () => items.createItem(itemInput),
  updateItem: () => items.updateItem({ ...itemInput, id: U }),
  archiveItem: () => items.archiveItem({ slug: SLUG, id: U }),
  // payments
  recordPayment: () => payments.recordPayment({ slug: SLUG, clientId: U, method: "check", receivedOn: "2026-12-01", amount: "1.00", requestKey: U, allocations: [] }),
  voidPayment: () => payments.voidPayment({ slug: SLUG, paymentId: U, reason: "x" }),
  removeApplication: () => payments.removeApplication({ slug: SLUG, allocationId: U }),
  applyPaymentToInvoice: () => payments.applyPaymentToInvoice({ slug: SLUG, paymentId: U, invoiceId: U, amount: "1.00" }),
  linkDeposit: () => payments.linkDeposit({ slug: SLUG, paymentId: U, depositTransactionId: U }),
  unlinkDeposit: () => payments.unlinkDeposit({ slug: SLUG, paymentId: U }),
  searchDepositCandidates: () => payments.searchDepositCandidates({ slug: SLUG, paymentId: null, clientId: U, amount: "1.00", receivedOn: "2026-12-01" }),
  // settings
  setupInvoicing: () => setup.setupInvoicing(setupInput),
  updateInvoicingProfile: () => setup.updateInvoicingProfile(profileInput),
  setInvoiceCounterAction: () => setup.setInvoiceCounterAction({ slug: SLUG, nextInvoiceNumber: 5000 }),
  setRemitMailing: () => setup.setRemitMailing({ slug: SLUG, remitToMailingAddress: "x", checkPayableTo: "y" }),
  setRemitBankText: () => setup.setRemitBankText({ slug: SLUG, text: "Routing 021000021", includeByDefault: true }),
  revealRemitBankText: () => setup.revealRemitBankText({ slug: SLUG }),
  setBusinessEin: () => setup.setBusinessEin({ slug: SLUG, ein: "12-3456789" }),
  revealBusinessEin: () => setup.revealBusinessEin({ slug: SLUG }),
  uploadInvoiceLogo: () => setup.uploadInvoiceLogo(pngForm()),
  removeInvoiceLogo: () => setup.removeInvoiceLogo({ slug: SLUG }),
};

const MODULES: [string, Record<string, unknown>][] = [
  ["actions/invoices", invoices],
  ["actions/clients", clients],
  ["actions/reimbursable-items", items],
  ["actions/billing-payments", payments],
  ["actions/invoicing-setup", setup],
];
const exportsOf = (m: Record<string, unknown>) => Object.keys(m).filter((k) => typeof m[k] === "function");

function seed() {
  process.env.ENCRYPTION_KEY = "0123456789abcdef".repeat(4); // a throwaway test key, not a secret
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: SLUG, dbaName: null, archivedAt: null }];
  fake.user.rows = [{ id: ERIC, name: "Eric Kinniburgh" }, { id: EVA, name: "Eva-Laura Ramirez-Wisiackas" }];
  fake.invoicingProfile.rows = [
    { id: "p1", entityId: E, enabled: true, goLiveOn: new Date("2026-10-01T00:00:00Z"), invoicePrefix: "", nextInvoiceNumber: 3100, quotePrefix: "Q-", nextQuoteNumber: 2001, numberPad: 0, defaultNetDays: 0, termsLabel: "Due upon receipt", businessAddress: "1 Test Road", showEinOnInvoice: false, includeRemitToByDefault: false, remitToUpdatedAt: null, glMap: GL },
  ];
  fake.glCode.rows = Object.values(GL).map((id) => ({ id, entityId: E, code: "1", name: "x", type: "revenue", archivedAt: null }));
  for (const t of [fake.client, fake.clientContact, fake.billingDocument, fake.billingLine, fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.auditLog, fake.transaction, fake.document, fake.reimbursableItem]) t.rows = [];
}
const snapshot = () => JSON.stringify(Object.values(fake).filter((v): v is FakeTable => v instanceof FakeTable).map((t) => t.rows));

beforeEach(() => {
  seed();
  vi.mocked(uploadLogoFile).mockClear();
});

describe("Eva is read-only in the invoicing suite", () => {
  it("every export of the five action files has a call factory (a new action cannot be added without being covered here)", () => {
    const exported = MODULES.flatMap(([file, m]) => exportsOf(m).map((k) => `${file}:${k}`));
    const factories = new Set(Object.keys(CALLS));
    for (const e of exported) expect(factories.has(e.split(":")[1]!), `${e} has no call factory in CALLS`).toBe(true);
    expect(exported.length).toBe(Object.keys(CALLS).length); // and no stale factory
    expect(new Set(exported.map((e) => e.split(":")[1])).size).toBe(exported.length); // names are unique across files
  });

  it.each([["Eva", EVA], ["a signed-in user who is not in the user table", STRANGER]])("%s is refused on EVERY exported action, before any work, and nothing changes", async (_label, who) => {
    asUser(who);
    const before = snapshot();
    for (const [name, call] of Object.entries(CALLS)) {
      const r = await call();
      expect(r, `${name} as non-owner`).toEqual({ error: NOT_INVOICING_OWNER_MESSAGE });
    }
    expect(snapshot()).toBe(before); // no row of any table (including the audit log) was written
    expect(uploadLogoFile).not.toHaveBeenCalled();
  });

  it("the same calls as the owner are NOT stopped by the owner gate (the refusal above is the gate, not a broken harness)", async () => {
    asUser(ERIC);
    for (const [name, call] of Object.entries(CALLS)) {
      const r = (await call()) as { error?: string } | undefined;
      expect(r?.error, `${name} as owner`).not.toBe(NOT_INVOICING_OWNER_MESSAGE);
      expect(r?.error ?? "", `${name} as owner`).not.toMatch(/Only the owner/);
    }
  });

  it("when the owner cannot be identified (no single matching user) nobody can write, not even Eric", async () => {
    fake.user.rows = [{ id: ERIC, name: "Someone Else" }, { id: EVA, name: "Eva" }];
    asUser(ERIC);
    const before = snapshot();
    for (const [name, call] of Object.entries(CALLS)) {
      const r = (await call()) as { error?: string };
      expect(r.error, name).toMatch(/could not be identified/);
    }
    expect(snapshot()).toBe(before);
  });

  it("Eva still has no session problem for reads: the gate message tells her what she CAN do", () => {
    expect(NOT_INVOICING_OWNER_MESSAGE).toMatch(/view invoices, clients, items and payments, and download an invoice PDF/);
  });
});
