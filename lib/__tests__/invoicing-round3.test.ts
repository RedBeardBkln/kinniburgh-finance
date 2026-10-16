// Round 3 (ek-consulting-invoicing): S4 (archived client: issue refused, deposit search still works), N1 (deterministic invoice lock
// order in recordPayment), N2 (setRemitBankText is ONE write). Real actions + store over the in-memory fake db.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
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
import { recordPayment, searchDepositCandidates } from "@/actions/billing-payments";
import { createClient, archiveClient } from "@/actions/clients";
import { setRemitBankText } from "@/actions/invoicing-setup";
import { todayNY } from "@/lib/invoicing/action-kit";
import { readRemitText } from "@/lib/invoicing/tin-store";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const E = "11111111-1111-4111-8111-111111111111";
const ERIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EVA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const GL = "33333333-3333-4333-8333-333333333333";
const DEP = "44444444-4444-4444-8444-444444444441";
const SLUG = "ek-consulting";
const asUser = (id: string) => authMock.mockResolvedValue({ user: { id, name: id === ERIC ? "Eric Kinniburgh" : "Eva" } });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = () => iso(todayNY());

function seed() {
  process.env.ENCRYPTION_KEY = "0123456789abcdef".repeat(4); // a throwaway test key, not a secret
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: SLUG, dbaName: null, archivedAt: null }];
  fake.user.rows = [{ id: ERIC, name: "Eric Kinniburgh" }, { id: EVA, name: "Eva-Laura Ramirez-Wisiackas" }];
  fake.invoicingProfile.rows = [
    {
      id: "p1", entityId: E, enabled: true, goLiveOn: new Date("2026-10-01T00:00:00Z"), invoicePrefix: "", nextInvoiceNumber: 3100, quotePrefix: "Q-", nextQuoteNumber: 2001, numberPad: 0, defaultNetDays: 0,
      termsLabel: "Due upon receipt", businessAddress: "1 Test Road", showEinOnInvoice: false, includeRemitToByDefault: false, remitToUpdatedAt: null,
      glMap: { ar: "a", unearned: "b", discounts: "c", billableIncome: "d", processingFees: "e" },
    },
  ];
  fake.glCode.rows = [{ id: GL, entityId: E, archivedAt: null, type: "revenue" }];
  for (const t of [fake.client, fake.clientContact, fake.billingDocument, fake.billingLine, fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.auditLog, fake.transaction, fake.document, fake.reimbursableItem]) t.rows = [];
  fake.transaction.rows = [{ id: DEP, entityId: E, archivedAt: null, transferPairId: null, pending: false, amount: new Prisma.Decimal("100.00"), postedAt: new Date(`${today()}T00:00:00Z`), payeeRaw: "ACME", description: "deposit" }];
}
beforeEach(seed);

const lineOf = () => ({ description: "Consulting", quantity: "1", unitPrice: "100.00", glCodeId: GL });
async function mkClient(name = "Acme Robotics"): Promise<string> {
  asUser(ERIC);
  const r = await createClient({ slug: SLUG, name });
  if (!("id" in r)) throw new Error("client not created");
  return r.id;
}
async function draftOf(c: string) {
  asUser(ERIC);
  const r = await saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c, lines: [lineOf()] } });
  if (!("id" in r)) throw new Error((r as { error: string }).error);
  return r;
}
async function issue(c: string): Promise<string> {
  const d = await draftOf(c);
  const r = await issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt });
  if (!("displayNumber" in r)) throw new Error((r as { error: string }).error);
  return d.id;
}

describe("S4: an archived client", () => {
  it("a draft of an archived client cannot be issued: clear message, no number burned, still a draft; an active client's draft still issues", async () => {
    const c = await mkClient();
    const d = await draftOf(c);
    fake.client.rows.find((r) => r.id === c)!.archivedAt = new Date(); // archived after the draft was saved (the archive action only checks issued invoices)
    asUser(ERIC);
    const r = await issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt });
    expect(r).toMatchObject({ error: expect.stringMatching(/client is archived/) });
    expect(fake.billingDocument.rows[0]!.status).toBe("draft");
    expect(fake.billingDocument.rows[0]!.number).toBeNull();
    expect(fake.invoicingProfile.rows[0]!.nextInvoiceNumber).toBe(3100);
    // an active client is unaffected, and takes number 3100 (nothing was burned above)
    const c2 = await mkClient("Other Client");
    const d2 = await draftOf(c2);
    expect(await issueInvoice({ slug: SLUG, documentId: d2.id, expectedUpdatedAt: d2.updatedAt })).toEqual({ success: true, displayNumber: "3100" });
  });

  it("the archive action only archives a client without a balance, so a draft can be orphaned (this is the case the issue check closes)", async () => {
    const c = await mkClient();
    await draftOf(c); // a draft does not block archiving
    asUser(ERIC);
    expect(await archiveClient({ slug: SLUG, id: c })).toEqual({ success: true });
    const d = fake.billingDocument.rows[0]!;
    expect(await issueInvoice({ slug: SLUG, documentId: d.id as string, expectedUpdatedAt: (d.updatedAt as Date).toISOString() })).toMatchObject({ error: expect.stringMatching(/client is archived/) });
  });

  it("D-12a: the deposit search works for an already-archived client's open invoice (and still refuses another entity's or an unknown client)", async () => {
    const c = await mkClient();
    await issue(c);
    fake.client.rows.find((r) => r.id === c)!.archivedAt = new Date(); // archived BEFORE the balance guard existed
    asUser(ERIC);
    const r = await searchDepositCandidates({ slug: SLUG, paymentId: null, clientId: c, amount: "100.00", receivedOn: today() });
    expect(r).toMatchObject({ success: true });
    if ("candidates" in r) expect(r.candidates.map((x) => x.transactionId)).toContain(DEP);
    // an unknown client id is still "not found"
    expect(await searchDepositCandidates({ slug: SLUG, paymentId: null, clientId: "55555555-5555-4555-8555-555555555555", amount: "100.00", receivedOn: today() })).toEqual({ error: "That client was not found." });
    // a client of another entity is still invisible
    fake.client.rows.find((r) => r.id === c)!.entityId = "someone-else";
    expect(await searchDepositCandidates({ slug: SLUG, paymentId: null, clientId: c, amount: "100.00", receivedOn: today() })).toEqual({ error: "That client was not found." });
  });

  it("the other archived-client rules are unchanged: a payment with no invoice still needs a live client; the deposit search is owner-only", async () => {
    const c = await mkClient();
    await issue(c);
    fake.client.rows.find((r) => r.id === c)!.archivedAt = new Date();
    asUser(ERIC);
    expect(await recordPayment({ slug: SLUG, clientId: c, method: "check", receivedOn: today(), amount: "10.00", requestKey: "66666666-6666-4666-8666-666666666661", allocations: [] })).toMatchObject({ error: expect.stringMatching(/not found/) });
    asUser(EVA);
    expect(await searchDepositCandidates({ slug: SLUG, paymentId: null, clientId: c, amount: "100.00", receivedOn: today() })).toMatchObject({ error: expect.stringMatching(/Only the owner/) });
  });
});

describe("N1: recordPayment locks the invoice rows in sorted order", () => {
  it("two payments listing the same invoices in opposite order issue the same sorted lock statement", async () => {
    const c = await mkClient();
    const ids = [await issue(c), await issue(c), await issue(c)];
    const sorted = [...ids].sort();
    const seen: string[][] = [];
    const orig = fake.$queryRaw.bind(fake);
    const spy = vi.spyOn(fake, "$queryRaw").mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes('FROM "BillingDocument" WHERE "id" IN')) {
        const joined = values[0] as { values?: unknown[] };
        seen.push((joined.values ?? []) as string[]);
      }
      return orig(strings, ...values);
    });
    asUser(ERIC);
    const forward = ids.map((invoiceId) => ({ invoiceId, amount: "1.00" }));
    const reverse = [...forward].reverse();
    const mk = (n: number) => `77777777-7777-4777-8777-77777777777${n}`;
    expect("id" in (await recordPayment({ slug: SLUG, clientId: c, method: "check", receivedOn: today(), amount: "3.00", requestKey: mk(1), allocations: forward }))).toBe(true);
    expect("id" in (await recordPayment({ slug: SLUG, clientId: c, method: "check", receivedOn: today(), amount: "3.00", requestKey: mk(2), allocations: reverse }))).toBe(true);
    spy.mockRestore();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(sorted);
    expect(seen[1]).toEqual(sorted); // opposite request order, identical lock order
  });
});

describe("N2: setRemitBankText is atomic", () => {
  it("one write stores the encrypted text, the approval stamp and the include flag together", async () => {
    asUser(ERIC);
    const update = vi.spyOn(fake.invoicingProfile, "update");
    const updateMany = vi.spyOn(fake.invoicingProfile, "updateMany");
    expect(await setRemitBankText({ slug: SLUG, text: "Test Bank\nRouting 021000021", includeByDefault: true })).toEqual({ success: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1); // the fake's update() delegates to updateMany: still ONE statement
    const p = fake.invoicingProfile.rows[0]!;
    expect(p.includeRemitToByDefault).toBe(true);
    expect(p.remitToEncrypted).toEqual(expect.any(String));
    expect(p.remitToApprovedById).toBe(ERIC);
    expect(await readRemitText(E)).toBe("Test Bank\nRouting 021000021");
    // changing the flag with new text is again one write
    update.mockClear();
    updateMany.mockClear();
    expect(await setRemitBankText({ slug: SLUG, text: "Other Bank\nRouting 021000021", includeByDefault: false })).toEqual({ success: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(fake.invoicingProfile.rows[0]!.includeRemitToByDefault).toBe(false);
    // clearing clears the text AND the flag in one write
    update.mockClear();
    updateMany.mockClear();
    expect(await setRemitBankText({ slug: SLUG, text: "", includeByDefault: true })).toEqual({ success: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(fake.invoicingProfile.rows[0]).toMatchObject({ remitToEncrypted: null, remitToUpdatedAt: null, includeRemitToByDefault: false });
  });

  it("a failing write leaves BOTH the text and the flag as they were (no half-saved state)", async () => {
    asUser(ERIC);
    expect(await setRemitBankText({ slug: SLUG, text: "First Bank\nRouting 021000021", includeByDefault: true })).toEqual({ success: true });
    const before = { ...fake.invoicingProfile.rows[0]! };
    vi.spyOn(fake.invoicingProfile, "update").mockRejectedValueOnce(new Error("connection lost"));
    const r = await setRemitBankText({ slug: SLUG, text: "Second Bank\nRouting 021000021", includeByDefault: false });
    expect(r).toHaveProperty("error");
    const after = fake.invoicingProfile.rows[0]!;
    expect(after.remitToEncrypted).toBe(before.remitToEncrypted);
    expect(after.includeRemitToByDefault).toBe(true);
    expect(after.remitToUpdatedAt).toEqual(before.remitToUpdatedAt);
  });
});
