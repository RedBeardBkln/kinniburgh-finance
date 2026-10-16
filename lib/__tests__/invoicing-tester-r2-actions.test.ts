// Tester round 2 (ek-consulting-invoicing): ACTION-level adversarial checks on the fake db for the round 1 fixes D-1, D-2, D-6, D-7, D-9
// (crafted GL ids, owner gating set/clear, archive/pay variants, pending/posted/archived deposit flips, request-key fallbacks).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { saveDraft, issueInvoice } from "@/actions/invoices";
import { loadDepositCandidates } from "@/lib/invoicing/payments-build";
import { recordPayment, linkDeposit } from "@/actions/billing-payments";
import { createClient, setClientEin, revealClientEin, archiveClient } from "@/actions/clients";
import { createItem, updateItem } from "@/actions/reimbursable-items";
import { NOT_INVOICING_OWNER_MESSAGE } from "@/lib/invoicing/owner";
import { todayNY } from "@/lib/invoicing/action-kit";
import { Prisma } from "@prisma/client";
import { newRequestKey } from "@/lib/invoicing/request-key";
import * as store from "@/lib/invoicing/store";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const E = "11111111-1111-4111-8111-111111111111";
const ERIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EVA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const GL = "33333333-3333-4333-8333-333333333333";
const GL_EXP = "33333333-3333-4333-8333-333333333334";
const GL_ASSET = "33333333-3333-4333-8333-333333333335";
const GL_INCOME = "33333333-3333-4333-8333-333333333336"; // the WRONG word, per CLAUDE.md
const GL_ARCH = "33333333-3333-4333-8333-333333333337";
const GL_NOTYPE = "33333333-3333-4333-8333-333333333338";
const SLUG = "ek-consulting";
const DEP_POSTED = "66666666-6666-4666-8666-666666666661";
const DEP_PENDING = "66666666-6666-4666-8666-666666666662";
const asUser = (id: string | null) => authMock.mockResolvedValue(id ? { user: { id, name: id === ERIC ? "Eric Kinniburgh" : "Eva" } } : null);
let ks = 0;
const key = () => `55555555-5555-4555-8555-${String(++ks).padStart(12, "0")}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function seed() {
  process.env.ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: SLUG, dbaName: null, archivedAt: null }];
  fake.user.rows = [{ id: ERIC, name: "Eric Kinniburgh" }, { id: EVA, name: "Eva-Laura Ramirez-Wisiackas" }];
  fake.invoicingProfile.rows = [
    {
      id: "p1", entityId: E, enabled: true, goLiveOn: new Date("2026-10-01T00:00:00Z"), invoicePrefix: "", nextInvoiceNumber: 3100, numberPad: 0, defaultNetDays: 0,
      termsLabel: "Due upon receipt", quotePrefix: "Q-", nextQuoteNumber: 2001, businessAddress: "1 Test Road", showEinOnInvoice: false, includeRemitToByDefault: false, remitToUpdatedAt: null,
      glMap: { ar: "a", unearned: "b", discounts: "c", billableIncome: "d", processingFees: "e" },
    },
  ];
  fake.glCode.rows = [
    { id: GL, entityId: E, archivedAt: null, type: "revenue" },
    { id: GL_EXP, entityId: E, archivedAt: null, type: "expense" },
    { id: GL_ASSET, entityId: E, archivedAt: null, type: "asset" },
    { id: GL_INCOME, entityId: E, archivedAt: null, type: "income" },
    { id: GL_ARCH, entityId: E, archivedAt: new Date(), type: "revenue" },
    { id: GL_NOTYPE, entityId: E, archivedAt: null },
  ];
  for (const t of [fake.client, fake.clientContact, fake.billingDocument, fake.billingLine, fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.auditLog, fake.transaction, fake.document, fake.reimbursableItem]) t.rows = [];
  const dec = (s: string) => new Prisma.Decimal(s);
  fake.transaction.rows = [
    { id: DEP_POSTED, entityId: E, archivedAt: null, transferPairId: null, pending: false, amount: dec("100.00"), postedAt: new Date("2026-12-01T00:00:00Z"), payeeRaw: "ACME", description: "deposit" },
    { id: DEP_PENDING, entityId: E, archivedAt: null, transferPairId: null, pending: true, amount: dec("100.00"), postedAt: new Date("2026-12-01T00:00:00Z"), payeeRaw: "ACME", description: "deposit" },
  ];
}
beforeEach(seed);

async function mkClient(name = "Acme Robotics"): Promise<string> {
  asUser(ERIC);
  const r = await createClient({ slug: SLUG, name });
  if (!("id" in r)) throw new Error("client not created");
  return r.id;
}
const lineOf = (gl: string) => ({ description: "Consulting", quantity: "1", unitPrice: "100.00", glCodeId: gl });
async function draftOf(c: string, gl = GL) {
  asUser(ERIC);
  const r = await saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c, lines: [lineOf(gl)] } });
  if (!("id" in r)) throw new Error((r as { error: string }).error);
  return r;
}
async function issue(c: string) {
  const d = await draftOf(c);
  asUser(ERIC);
  const r = await issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt });
  if (!("displayNumber" in r)) throw new Error((r as { error: string }).error);
  return d.id;
}
const today = () => iso(todayNY());

describe("D-1 via the real actions", () => {
  it("every non-revenue / archived / typeless account is refused on save (new and existing draft), issue, createItem and updateItem", async () => {
    const c = await mkClient();
    asUser(ERIC);
    for (const bad of [GL_EXP, GL_ASSET, GL_INCOME, GL_ARCH, GL_NOTYPE, "33333333-3333-4333-8333-3333333333ff"]) {
      const r = await saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c, lines: [lineOf(bad)] } });
      expect(r, `save ${bad}`).toMatchObject({ error: expect.stringMatching(/income account|revenue|not found/i) });
    }
    expect(fake.billingDocument.rows).toHaveLength(0);
    // an existing draft cannot be edited onto an expense account
    const d = await draftOf(c);
    const edit = await saveDraft({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt, draft: { clientId: c, lines: [lineOf(GL_EXP)] } });
    expect(edit).toMatchObject({ error: expect.stringMatching(/revenue/) });
    expect(fake.billingLine.rows.every((l) => l.glCodeId === GL)).toBe(true);
    // account re-typed AFTER the draft was saved: issue must refuse and burn no number
    fake.glCode.rows.find((g) => g.id === GL)!.type = "expense";
    const iss = await issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt });
    expect(iss).toMatchObject({ error: expect.any(String) });
    expect(fake.billingDocument.rows[0]!.status).toBe("draft");
    expect(fake.invoicingProfile.rows[0]!.nextInvoiceNumber).toBe(3100);
    fake.glCode.rows.find((g) => g.id === GL)!.type = "revenue";
    // items
    const item = { slug: SLUG, name: "Prints", unit: "ea", unitCost: "1.00", pricingMode: "markup", markupPercent: "10", billedUnitPrice: "", glCodeId: GL_EXP, taxable: false } as never;
    const ci = await createItem(item);
    expect(ci).toMatchObject({ error: expect.any(String) });
    expect(fake.reimbursableItem.rows).toHaveLength(0);
    const ok = await createItem({ ...(item as object), glCodeId: GL } as never);
    expect("id" in ok).toBe(true);
    if ("id" in ok) {
      const up = await updateItem({ ...(item as object), id: ok.id } as never);
      expect(up).toMatchObject({ error: expect.any(String) });
    }
  });
});

describe("D-9 setClientEin owner-only", () => {
  it("Eva cannot set or clear; Eric can; a refused call leaves the stored value untouched; SSN-shaped refused", async () => {
    const c = await mkClient();
    asUser(ERIC);
    expect(await setClientEin({ slug: SLUG, id: c, ein: "12-3456789" })).toEqual({ success: true });
    const before = { ...fake.client.rows[0]! };
    expect(before.einLast4).toBe("6789");
    asUser(EVA);
    expect(await setClientEin({ slug: SLUG, id: c, ein: "98-7654321" })).toEqual({ error: NOT_INVOICING_OWNER_MESSAGE });
    expect(await setClientEin({ slug: SLUG, id: c, ein: "" })).toEqual({ error: NOT_INVOICING_OWNER_MESSAGE });
    expect(await setClientEin({ slug: SLUG, id: c, ein: "   " })).toEqual({ error: NOT_INVOICING_OWNER_MESSAGE });
    expect(fake.client.rows[0]!.einEncrypted).toBe(before.einEncrypted);
    expect(fake.client.rows[0]!.einLast4).toBe("6789");
    asUser(null);
    await expect(setClientEin({ slug: SLUG, id: c, ein: "" })).rejects.toThrow("Unauthorized");
    asUser(ERIC);
    expect(await setClientEin({ slug: SLUG, id: c, ein: "123-45-6789" })).toMatchObject({ error: expect.any(String) });
    expect(fake.client.rows[0]!.einLast4).toBe("6789");
    expect(await revealClientEin({ slug: SLUG, id: c })).toEqual({ success: true, ein: "12-3456789" });
    expect(await setClientEin({ slug: SLUG, id: c, ein: "" })).toEqual({ success: true });
    expect(fake.client.rows[0]!.einEncrypted).toBeNull();
    expect(fake.client.rows[0]!.einLast4).toBeNull();
    // unidentifiable owner => nobody
    fake.user.rows = [{ id: ERIC, name: "Someone Else" }, { id: EVA, name: "Eva" }];
    expect(await setClientEin({ slug: SLUG, id: c, ein: "12-3456789" })).toMatchObject({ error: expect.stringMatching(/could not be identified/) });
  });
});

describe("D-2 via the real actions and adversarial variants", () => {
  it("an archive is refused while an issued invoice has a balance (owner; Eva is refused outright, see the read-only suite); draft/void/paid do not block; remove-application re-blocks", async () => {
    const c = await mkClient();
    const inv = await issue(c);
    asUser(ERIC);
    expect(await archiveClient({ slug: SLUG, id: c })).toMatchObject({ error: expect.stringMatching(/balance due/) });
    expect(fake.client.rows[0]!.archivedAt).toBeNull();
    // pay in full (owner), then archive allowed
    asUser(ERIC);
    const p = await recordPayment({ slug: SLUG, clientId: c, method: "check", receivedOn: today(), amount: "100.00", requestKey: key(), allocations: [{ invoiceId: inv, amount: "100.00" }] });
    expect("id" in p).toBe(true);
    // remove the application -> balance again -> blocked again
    const alloc = fake.billingAllocation.rows[0]!;
    const { removeApplication } = await import("@/actions/billing-payments");
    expect(await removeApplication({ slug: SLUG, allocationId: alloc.id as string })).toEqual({ success: true });
    asUser(ERIC);
    expect(await archiveClient({ slug: SLUG, id: c })).toMatchObject({ error: expect.stringMatching(/balance due/) });
    // void the invoice (owner) -> not blocking (payment unallocated, invoice void)
    asUser(ERIC);
    const { voidInvoice } = await import("@/actions/invoices");
    expect(await voidInvoice({ slug: SLUG, documentId: inv, reason: "test" })).toEqual({ success: true });
    asUser(ERIC);
    expect(await archiveClient({ slug: SLUG, id: c })).toEqual({ success: true });
  });

  it("archived client: payment that applies to nothing (no allocation) is refused; allocation to ANOTHER client's invoice is refused; to a paid/void invoice refused; to its own open invoice works", async () => {
    const c = await mkClient("Acme");
    const c2 = await mkClient("Other");
    const inv = await issue(c);
    const inv2 = await issue(c2);
    fake.client.rows.find((r) => r.id === c)!.archivedAt = new Date(); // archived before the guard existed
    asUser(ERIC);
    expect(await recordPayment({ slug: SLUG, clientId: c, method: "check", receivedOn: today(), amount: "10.00", requestKey: key(), allocations: [] })).toMatchObject({ error: expect.stringMatching(/not found/) });
    expect(await recordPayment({ slug: SLUG, clientId: c, method: "check", receivedOn: today(), amount: "10.00", requestKey: key(), allocations: [{ invoiceId: inv2, amount: "10.00" }] })).toMatchObject({ error: expect.stringMatching(/not found for this client/) });
    // blank applied amount counts as no allocation -> needs a live client
    expect(await recordPayment({ slug: SLUG, clientId: c, method: "check", receivedOn: today(), amount: "10.00", requestKey: key(), allocations: [{ invoiceId: inv, amount: "" }] })).toMatchObject({ error: expect.stringMatching(/not found/) });
    // zero applied amount is refused by validation
    expect(await recordPayment({ slug: SLUG, clientId: c, method: "check", receivedOn: today(), amount: "10.00", requestKey: key(), allocations: [{ invoiceId: inv, amount: "0.00" }] })).toMatchObject({ error: expect.any(String) });
    expect(fake.billingPayment.rows).toHaveLength(0);
    // a client id that does not exist at all, with an allocation to a real invoice of c: invoice must belong to that client id
    expect(await recordPayment({ slug: SLUG, clientId: "22222222-2222-4222-8222-2222222222ff", method: "check", receivedOn: today(), amount: "10.00", requestKey: key(), allocations: [{ invoiceId: inv, amount: "10.00" }] })).toMatchObject({ error: expect.any(String) });
    expect(fake.billingPayment.rows).toHaveLength(0);
    const ok = await recordPayment({ slug: SLUG, clientId: c, method: "check", receivedOn: today(), amount: "100.00", requestKey: key(), allocations: [{ invoiceId: inv, amount: "100.00" }] });
    expect("id" in ok).toBe(true);
    // now fully paid: another payment against it is refused
    expect(await recordPayment({ slug: SLUG, clientId: c, method: "check", receivedOn: today(), amount: "1.00", requestKey: key(), allocations: [{ invoiceId: inv, amount: "1.00" }] })).toMatchObject({ error: expect.stringMatching(/more than/) });
    // other entity's client id with allocation to an invoice of this entity: nothing
    expect(fake.billingPayment.rows).toHaveLength(1);
  });

  it("archive racing a concurrent issue (the archive transaction read BEFORE the issue committed, simulated): the invoice stays payable on the archived client", async () => {
    // The fake db serialises transactions, so emulate READ COMMITTED by issuing between the archive's read and its write:
    const c = await mkClient();
    const d = await draftOf(c);
    const origFind = fake.billingDocument.findMany.bind(fake.billingDocument);
    let injected = false;
    (fake.billingDocument as unknown as { findMany: unknown }).findMany = async (...a: unknown[]) => {
      const rows = await (origFind as (...x: unknown[]) => Promise<unknown>)(...a);
      if (!injected) {
        injected = true;
        // another session issues the draft right after our read (it would commit while our tx is still open on real Postgres)
        const row = fake.billingDocument.rows.find((r) => r.id === d.id)!;
        row.status = "issued";
        row.number = 3100;
        row.issueDate = new Date("2026-12-01T00:00:00Z");
      }
      return rows;
    };
    await store.archiveClient(E, c);
    (fake.billingDocument as unknown as { findMany: unknown }).findMany = origFind;
    expect(fake.client.rows[0]!.archivedAt).not.toBeNull();
    expect(fake.billingDocument.rows[0]!.status).toBe("issued");
    // consequence: the invoice must still be payable
    asUser(ERIC);
    const p = await recordPayment({ slug: SLUG, clientId: c, method: "check", receivedOn: today(), amount: "100.00", requestKey: key(), allocations: [{ invoiceId: d.id, amount: "100.00" }] });
    expect("id" in p).toBe(true);
  });
});

describe("D-6 pending deposits", () => {
  it("search never offers pending; link refuses pending at action level; a deposit that posts is then linkable; one that flips back to pending or is archived is refused", async () => {
    const c = await mkClient();
    const inv = await issue(c);
    asUser(ERIC);
    const s1 = { candidates: await loadDepositCandidates(E, { amountCents: 10000, feeCents: 0, receivedOn: new Date("2026-12-01T00:00:00Z"), clientName: "Acme", paymentId: null }) };
    expect("candidates" in s1 && s1.candidates.map((x) => x.transactionId)).toEqual([DEP_POSTED]);
    // pending refused at record time
    expect(await recordPayment({ slug: SLUG, clientId: c, method: "ach", receivedOn: today(), amount: "100.00", requestKey: key(), allocations: [{ invoiceId: inv, amount: "100.00" }], depositTransactionId: DEP_PENDING })).toMatchObject({ error: expect.stringMatching(/still pending/) });
    expect(fake.billingPayment.rows).toHaveLength(0);
    // no deposit -> record, then link attempts
    const p = await recordPayment({ slug: SLUG, clientId: c, method: "ach", receivedOn: today(), amount: "100.00", requestKey: key(), allocations: [{ invoiceId: inv, amount: "100.00" }] });
    if (!("id" in p)) throw new Error("no payment");
    expect(await linkDeposit({ slug: SLUG, paymentId: p.id, depositTransactionId: DEP_PENDING })).toMatchObject({ error: expect.stringMatching(/still pending/) });
    // the pending row posts in place (flag flips): now it is both searchable and linkable
    fake.transaction.rows.find((r) => r.id === DEP_PENDING)!.pending = false;
    const s2 = { candidates: await loadDepositCandidates(E, { amountCents: 10000, feeCents: 0, receivedOn: new Date("2026-12-01T00:00:00Z"), clientName: "Acme", paymentId: p.id }) };
    expect("candidates" in s2 && s2.candidates.map((x) => x.transactionId).sort()).toEqual([DEP_PENDING, DEP_POSTED].sort());
    // between search and link the row flips back to pending (or Plaid archives it): refused, nothing linked
    fake.transaction.rows.find((r) => r.id === DEP_PENDING)!.pending = true;
    expect(await linkDeposit({ slug: SLUG, paymentId: p.id, depositTransactionId: DEP_PENDING })).toMatchObject({ error: expect.stringMatching(/still pending/) });
    fake.transaction.rows.find((r) => r.id === DEP_PENDING)!.pending = false;
    fake.transaction.rows.find((r) => r.id === DEP_PENDING)!.archivedAt = new Date();
    expect(await linkDeposit({ slug: SLUG, paymentId: p.id, depositTransactionId: DEP_PENDING })).toMatchObject({ error: expect.stringMatching(/not found/) });
    expect(fake.billingPayment.rows[0]!.depositTransactionId).toBeNull();
    expect(await linkDeposit({ slug: SLUG, paymentId: p.id, depositTransactionId: DEP_POSTED })).toEqual({ success: true });
    expect(fake.billingPayment.rows[0]!.depositTransactionId).toBe(DEP_POSTED);
  });
});

describe("D-7 request key (fallback paths the round 2 suite does not reach: passing undefined triggers the default argument = real crypto)", () => {
  it("never repeats in a tight loop on any fallback path, always a valid v4 UUID", () => {
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const mk of [() => newRequestKey({}), () => newRequestKey({ randomUUID: undefined, getRandomValues: undefined }), () => newRequestKey()]) {
      const seen = new Set<string>();
      for (let i = 0; i < 200_000; i += 1) {
        const k = mk();
        if (!re.test(k)) throw new Error(`bad key ${k}`);
        seen.add(k);
      }
      expect(seen.size).toBe(200_000);
    }
    // getRandomValues path with Math.random-backed source
    const seen2 = new Set<string>();
    const src = { getRandomValues: <T extends ArrayBufferView>(a: T): T => { const u = a as unknown as Uint8Array; for (let i = 0; i < u.length; i += 1) u[i] = Math.floor(Math.random() * 256); return a; } };
    for (let i = 0; i < 100_000; i += 1) seen2.add(newRequestKey(src));
    expect(seen2.size).toBe(100_000);
    // time-frozen: Date.now constant, counter-driven uniqueness still holds
    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      const seen3 = new Set<string>();
      for (let i = 0; i < 50_000; i += 1) seen3.add(newRequestKey({}));
      expect(seen3.size).toBe(50_000);
    } finally {
      Date.now = realNow;
    }
  });
});
