// Tester round 3 (ek-consulting-invoicing): INDEPENDENT proof that every mutating/revealing invoicing action refuses Eva, a signed-in
// stranger and an unauthenticated caller, against a database that holds REAL rows (so a missing gate would visibly change data), and that
// the owner is never stopped by the gate. Written without reusing the Coder's call table: the export list is read from the action
// SOURCE files, and every export must have a call below.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import * as pay from "@/actions/billing-payments";
import * as setup from "@/actions/invoicing-setup";
import { INVOICING_OWNER_UNKNOWN_MESSAGE, NOT_INVOICING_OWNER_MESSAGE } from "@/lib/invoicing/owner";
import { Prisma } from "@prisma/client";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const ROOT = resolve(__dirname, "../..");
const E = "11111111-1111-4111-8111-111111111111";
const ERIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EVA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const NOBODY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";
const GL = "33333333-3333-4333-8333-333333333333";
const GLS = { ar: "10000000-0000-4000-8000-000000000001", unearned: "10000000-0000-4000-8000-000000000002", discounts: "10000000-0000-4000-8000-000000000003", billableIncome: GL, processingFees: "10000000-0000-4000-8000-000000000005" };
const SLUG = "ek-consulting";
const DEP = "66666666-6666-4666-8666-666666666661";
const W9DOC = "77777777-7777-4777-8777-777777777771";
const asUser = (id: string | null) => authMock.mockResolvedValue(id ? { user: { id, name: id === ERIC ? "Eric Kinniburgh" : "Someone" } } : null);
let ks = 0;
const key = () => `55555555-5555-4555-8555-${String(++ks).padStart(12, "0")}`;
const SECRET_EIN = "98-7654321";
const SECRET_BANK = "Routing 021000021 Account 1234567890";

function seed() {
  process.env.ENCRYPTION_KEY = "0123456789abcdef".repeat(4); // throwaway test key
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: SLUG, dbaName: null, archivedAt: null }];
  fake.user.rows = [{ id: ERIC, name: "Eric Kinniburgh" }, { id: EVA, name: "Eva-Laura Ramirez-Wisiackas" }];
  fake.invoicingProfile.rows = [
    {
      id: "p1", entityId: E, enabled: true, goLiveOn: new Date("2026-10-01T00:00:00Z"), invoicePrefix: "", nextInvoiceNumber: 3100, numberPad: 0, defaultNetDays: 0,
      termsLabel: "Due upon receipt", quotePrefix: "Q-", nextQuoteNumber: 2001, businessAddress: "1 Test Road", showEinOnInvoice: false, includeRemitToByDefault: false, remitToUpdatedAt: null, glMap: GLS,
    },
  ];
  fake.glCode.rows = [{ id: GL, entityId: E, archivedAt: null, type: "revenue" }];
  for (const t of [fake.client, fake.clientContact, fake.billingDocument, fake.billingLine, fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.auditLog, fake.transaction, fake.document, fake.reimbursableItem]) t.rows = [];
  fake.transaction.rows = [{ id: DEP, entityId: E, archivedAt: null, transferPairId: null, pending: false, amount: new Prisma.Decimal("40.00"), postedAt: new Date("2026-12-01T00:00:00Z"), payeeRaw: "ACME", description: "deposit" }];
  fake.document.rows = [{ id: W9DOC, entityId: E, docType: "w9", archivedAt: null, filename: "w9.pdf", createdAt: new Date("2026-12-01T00:00:00Z") }];
}
beforeEach(() => {
  seed();
  vi.mocked(uploadLogoFile).mockClear();
});

const snapshot = () => JSON.stringify(Object.values(fake).filter((v): v is FakeTable => v instanceof FakeTable).map((t) => ({ n: t.name, rows: t.rows })));
const lineOf = () => ({ description: "Consulting", quantity: "1", unitPrice: "100.00", glCodeId: GL });

interface Ids { client: string; draft: string; draftAt: string; invoice: string; payment: string; deposit: string; allocation: string; contact: string; item: string }

async function build(): Promise<Ids> {
  asUser(ERIC);
  const ok = <T,>(r: T): T extends { error: string } ? never : T => {
    if (r && typeof r === "object" && "error" in (r as object)) throw new Error("setup failed: " + String((r as unknown as { error: string }).error));
    return r as never;
  };
  const c = ok(await clients.createClient({ slug: SLUG, name: "Acme Robotics" })) as { id: string };
  ok(await clients.setClientEin({ slug: SLUG, id: c.id, ein: SECRET_EIN }));
  const k = ok(await clients.addContact({ slug: SLUG, clientId: c.id, name: "Pat", email: "pat@example.com", role: "billing", receivesInvoices: true }));
  void k;
  fake.clientContact.rows = fake.clientContact.rows; // contact created through the action
  const it = ok(await items.createItem({ slug: SLUG, name: "Prints", unit: "ea", unitCost: "1.00", pricingMode: "markup", markupPercent: "10", glCodeId: GL } as never)) as { id: string };
  const d = ok(await invoices.saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c.id, lines: [lineOf()] } })) as { id: string; updatedAt: string };
  const d2 = ok(await invoices.saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c.id, lines: [lineOf()] } })) as { id: string; updatedAt: string };
  ok(await invoices.issueInvoice({ slug: SLUG, documentId: d2.id, expectedUpdatedAt: d2.updatedAt }));
  ok(await setup.setRemitBankText({ slug: SLUG, text: SECRET_BANK, includeByDefault: false }));
  const p = ok(await pay.recordPayment({ slug: SLUG, clientId: c.id, method: "check", receivedOn: "2026-10-05", amount: "40.00", requestKey: key(), allocations: [{ invoiceId: d2.id, amount: "30.00" }] })) as { id: string };
  const alloc = fake.billingAllocation.rows[0]!.id as string;
  const contact = fake.clientContact.rows[0]!.id as string;
  return { client: c.id, draft: d.id, draftAt: d.updatedAt, invoice: d2.id, payment: p.id, deposit: DEP, allocation: alloc, contact, item: it.id };
}

type Call = (i: Ids) => Promise<unknown>;
const png = () => {
  const f = new FormData();
  f.set("slug", SLUG);
  f.set("file", new File([Buffer.from(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]))], "logo.png", { type: "image/png" }));
  return f;
};
const CALLS: Record<string, Call> = {
  recordPayment: (i) => pay.recordPayment({ slug: SLUG, clientId: i.client, method: "check", receivedOn: "2026-10-06", amount: "10.00", requestKey: key(), allocations: [{ invoiceId: i.invoice, amount: "10.00" }] }),
  voidPayment: (i) => pay.voidPayment({ slug: SLUG, paymentId: i.payment, reason: "mistake" }),
  removeApplication: (i) => pay.removeApplication({ slug: SLUG, allocationId: i.allocation }),
  applyPaymentToInvoice: (i) => pay.applyPaymentToInvoice({ slug: SLUG, paymentId: i.payment, invoiceId: i.invoice, amount: "5.00" }),
  linkDeposit: (i) => pay.linkDeposit({ slug: SLUG, paymentId: i.payment, depositTransactionId: i.deposit }),
  unlinkDeposit: (i) => pay.unlinkDeposit({ slug: SLUG, paymentId: i.payment }),
  searchDepositCandidates: (i) => pay.searchDepositCandidates({ slug: SLUG, paymentId: null, clientId: i.client, amount: "40.00", receivedOn: "2026-12-01" }),
  createClient: () => clients.createClient({ slug: SLUG, name: "Other Co" }),
  updateClient: (i) => clients.updateClient({ slug: SLUG, id: i.client, name: "Renamed" }),
  archiveClient: (i) => clients.archiveClient({ slug: SLUG, id: i.client }),
  addContact: (i) => clients.addContact({ slug: SLUG, clientId: i.client, name: "New", email: "n@example.com", role: "billing", receivesInvoices: false }),
  updateContact: (i) => clients.updateContact({ slug: SLUG, clientId: i.client, contactId: i.contact, name: "Pat2", email: "pat@example.com", role: "billing", receivesInvoices: true }),
  archiveContact: (i) => clients.archiveContact({ slug: SLUG, clientId: i.client, contactId: i.contact }),
  setClientEin: (i) => clients.setClientEin({ slug: SLUG, id: i.client, ein: "11-1111111" }),
  revealClientEin: (i) => clients.revealClientEin({ slug: SLUG, id: i.client }),
  linkClientW9: (i) => clients.linkClientW9({ slug: SLUG, clientId: i.client, documentId: W9DOC }),
  saveDraft: (i) => invoices.saveDraft({ slug: SLUG, documentId: i.draft, expectedUpdatedAt: i.draftAt, draft: { clientId: i.client, lines: [lineOf(), lineOf()] } }),
  issueInvoice: (i) => invoices.issueInvoice({ slug: SLUG, documentId: i.draft, expectedUpdatedAt: i.draftAt }),
  voidInvoice: (i) => invoices.voidInvoice({ slug: SLUG, documentId: i.invoice, reason: "oops" }),
  archiveDraft: (i) => invoices.archiveDraft({ slug: SLUG, documentId: i.draft, expectedUpdatedAt: i.draftAt }),
  duplicateInvoice: (i) => invoices.duplicateInvoice({ slug: SLUG, documentId: i.invoice }),
  setupInvoicing: () => setup.setupInvoicing({ slug: SLUG, goLiveOn: "2026-10-01", invoicePrefix: "", nextInvoiceNumber: 3100, quotePrefix: "Q-", nextQuoteNumber: 2001, numberPad: 0, defaultNetDays: 0, termsLabel: "Due upon receipt", businessAddress: "1 Test Road", glMap: GLS } as never),
  updateInvoicingProfile: () => setup.updateInvoicingProfile({ slug: SLUG, invoicePrefix: "X", numberPad: 0, defaultNetDays: 5, termsLabel: "Net 5", businessAddress: "2 Other Road", showEinOnInvoice: false, quotePrefix: "QQ-", nextQuoteNumber: 5000, glMap: GLS } as never),
  setInvoiceCounterAction: () => setup.setInvoiceCounterAction({ slug: SLUG, nextInvoiceNumber: 9000 }),
  setRemitMailing: () => setup.setRemitMailing({ slug: SLUG, remitToMailingAddress: "PO Box 1", checkPayableTo: "Someone Else" }),
  setRemitBankText: () => setup.setRemitBankText({ slug: SLUG, text: "Routing 011111111", includeByDefault: true }),
  revealRemitBankText: () => setup.revealRemitBankText({ slug: SLUG }),
  setBusinessEin: () => setup.setBusinessEin({ slug: SLUG, ein: "22-2222222" }),
  revealBusinessEin: () => setup.revealBusinessEin({ slug: SLUG }),
  uploadInvoiceLogo: () => setup.uploadInvoiceLogo(png()),
  removeInvoiceLogo: () => setup.removeInvoiceLogo({ slug: SLUG }),
  createItem: () => items.createItem({ slug: SLUG, name: "Binders", unit: "ea", unitCost: "2.00", pricingMode: "markup", markupPercent: "10", glCodeId: GL } as never),
  updateItem: (i) => items.updateItem({ slug: SLUG, id: i.item, name: "Prints2", unit: "ea", unitCost: "3.00", pricingMode: "markup", markupPercent: "10", glCodeId: GL } as never),
  archiveItem: (i) => items.archiveItem({ slug: SLUG, id: i.item }),
};

function exportedNamesFromSource(): string[] {
  const out: string[] = [];
  for (const f of ["billing-payments", "clients", "invoices", "invoicing-setup", "reimbursable-items"]) {
    const src = readFileSync(resolve(ROOT, `actions/${f}.ts`), "utf8");
    for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) out.push(m[1]!);
    // any other runtime export form would be an action we do not enumerate
    for (const m of src.matchAll(/^export\s+(?:const|let|var|default|\{|\*)/gm)) out.push("NONFUNCTION_EXPORT:" + f + ":" + m[0]);
  }
  return out;
}

describe("independent Eva / stranger / anonymous refusal matrix", () => {
  it("the call table covers exactly the exports read from the source (34), no more, no fewer", () => {
    const names = exportedNamesFromSource();
    expect(names.filter((n) => n.startsWith("NONFUNCTION_EXPORT"))).toEqual([]);
    expect(names).toHaveLength(34);
    expect([...names].sort()).toEqual(Object.keys(CALLS).sort());
  });

  it.each([
    ["Eva (real household user, not the owner)", EVA, NOT_INVOICING_OWNER_MESSAGE],
    ["a signed-in id that is in no user row", NOBODY, NOT_INVOICING_OWNER_MESSAGE],
  ])("%s: all 34 actions refuse with the owner message, nothing changes, nothing leaks", async (_l, who, msg) => {
    const ids = await build();
    const before = snapshot();
    asUser(who);
    for (const [name, call] of Object.entries(CALLS)) {
      const r = await call(ids);
      expect(r, `${name}`).toEqual({ error: msg });
      expect(JSON.stringify(r)).not.toContain("987654321");
      expect(JSON.stringify(r)).not.toContain("021000021");
    }
    expect(snapshot()).toBe(before);
    expect(uploadLogoFile).not.toHaveBeenCalled();
  });

  it("an unauthenticated caller (no session) is rejected by every action before anything is read or written", async () => {
    const ids = await build();
    const before = snapshot();
    asUser(null);
    for (const [name, call] of Object.entries(CALLS)) {
      await expect(call(ids), name).rejects.toThrow(/Unauthorized/);
    }
    expect(snapshot()).toBe(before);
    expect(uploadLogoFile).not.toHaveBeenCalled();
  });

  it("session without a user id (malformed session object) is also rejected", async () => {
    const ids = await build();
    const before = snapshot();
    authMock.mockResolvedValue({ user: {} });
    for (const [name, call] of Object.entries(CALLS)) await expect(call(ids), name).rejects.toThrow(/Unauthorized/);
    authMock.mockResolvedValue({});
    for (const [name, call] of Object.entries(CALLS)) await expect(call(ids), name).rejects.toThrow(/Unauthorized/);
    expect(snapshot()).toBe(before);
  });

  it("the owner rule fails closed when ambiguous: two users match the entity name, then NOBODY (even Eric) can do anything", async () => {
    const ids = await build();
    fake.user.rows.push({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab1", name: "Eric Kinniburgh" }); // a second user with the same name
    const before = snapshot();
    asUser(ERIC);
    for (const [name, call] of Object.entries(CALLS)) {
      const r = await call(ids);
      expect(r, `${name} with ambiguous owner`).toEqual({ error: INVOICING_OWNER_UNKNOWN_MESSAGE });
    }
    expect(snapshot()).toBe(before);
  });

  it("the owner rule fails closed when no user matches the entity name (entity renamed)", async () => {
    const ids = await build();
    fake.entity.rows[0]!.name = "Unrelated Consulting, LLC";
    const before = snapshot();
    asUser(ERIC);
    for (const [name, call] of Object.entries(CALLS)) {
      const r = (await call(ids)) as { error?: string };
      expect(r.error, name).toBeTruthy();
      expect(r.error).not.toMatch(/^$/);
    }
    expect(snapshot()).toBe(before);
  });

  it("the owner rule fails closed when the user lookup itself throws", async () => {
    const ids = await build();
    const before = snapshot();
    const orig = fake.user.findMany;
    fake.user.findMany = (async () => {
      throw new Error("db down");
    }) as never;
    asUser(ERIC);
    try {
      for (const [name, call] of Object.entries(CALLS)) {
        const r = (await call(ids)) as { error?: string };
        expect(r.error, name).toBeTruthy();
      }
    } finally {
      fake.user.findMany = orig;
    }
    expect(snapshot()).toBe(before);
  });

  it("the OWNER is not stopped by the gate on any action (and the call table is not trivially red)", async () => {
    const ids = await build();
    asUser(ERIC);
    // order matters for state, but the assertion is only "not the owner refusal / not Unauthorized"
    const order = Object.keys(CALLS);
    for (const name of order) {
      let r: unknown;
      try {
        r = await CALLS[name]!(ids);
      } catch (e) {
        throw new Error(`${name} threw for the owner: ${(e as Error).message}`);
      }
      const err = (r as { error?: string })?.error;
      expect(err, name).not.toBe(NOT_INVOICING_OWNER_MESSAGE);
      expect(err, name).not.toBe(INVOICING_OWNER_UNKNOWN_MESSAGE);
    }
  });

  it("owner positive path still works end to end: draft, issue (3100), record + apply, deposit link, void payment after removing the application", async () => {
    const ids = await build();
    asUser(ERIC);
    expect(fake.invoicingProfile.rows[0]!.nextInvoiceNumber).toBe(3101); // build() issued the first one: 3100
    expect(fake.billingDocument.rows.find((d) => d.id === ids.invoice)!.displayNumber).toBe("3100");
    expect(await pay.linkDeposit({ slug: SLUG, paymentId: ids.payment, depositTransactionId: ids.deposit })).toEqual({ success: true });
    expect(await pay.removeApplication({ slug: SLUG, allocationId: ids.allocation })).toEqual({ success: true });
    expect(await pay.voidPayment({ slug: SLUG, paymentId: ids.payment, reason: "bounced" })).toEqual({ success: true });
  });
});
