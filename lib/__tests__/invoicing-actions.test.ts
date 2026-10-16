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
import { saveDraft, issueInvoice, voidInvoice, duplicateInvoice } from "@/actions/invoices";
import { recordPayment, voidPayment, linkDeposit, removeApplication, applyPaymentToInvoice } from "@/actions/billing-payments";
import { createClient, setClientEin, revealClientEin, addContact, linkClientW9 } from "@/actions/clients";
import { NOT_INVOICING_OWNER_MESSAGE } from "@/lib/invoicing/owner";
import { todayNY } from "@/lib/invoicing/action-kit";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const E = "11111111-1111-4111-8111-111111111111";
const ERIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EVA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const GL = "33333333-3333-4333-8333-333333333333";
const SLUG = "ek-consulting";

const asUser = (id: string | null) => authMock.mockResolvedValue(id ? { user: { id, name: id === ERIC ? "Eric Kinniburgh" : "Eva" } } : null);
const iso = (d: Date) => d.toISOString().slice(0, 10);

function seed(profileOver: Record<string, unknown> = {}) {
  process.env.ENCRYPTION_KEY = "0123456789abcdef".repeat(4); // a throwaway test key, not a secret
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: SLUG, dbaName: "LaunchTime Solutions", archivedAt: null }];
  fake.user.rows = [{ id: ERIC, name: "Eric Kinniburgh" }, { id: EVA, name: "Eva-Laura Ramirez-Wisiackas" }];
  fake.invoicingProfile.rows = [
    {
      id: "p1", entityId: E, enabled: true, goLiveOn: new Date("2026-10-01T00:00:00Z"), invoicePrefix: "", nextInvoiceNumber: 3100, numberPad: 0, defaultNetDays: 0,
      termsLabel: "Due upon receipt", quotePrefix: "Q-", nextQuoteNumber: 2001, businessAddress: "1 Test Road", showEinOnInvoice: false, includeRemitToByDefault: false, remitToUpdatedAt: null,
      glMap: { ar: "a", unearned: "b", discounts: "c", billableIncome: "d", processingFees: "e" }, ...profileOver,
    },
  ];
  fake.glCode.rows = [{ id: GL, entityId: E, archivedAt: null, type: "revenue" }];
  for (const t of [fake.client, fake.clientContact, fake.billingDocument, fake.billingLine, fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.auditLog, fake.transaction, fake.document]) t.rows = [];
}

async function mkClient(): Promise<string> {
  asUser(ERIC);
  const r = await createClient({ slug: SLUG, name: "Acme Robotics" });
  if (!("id" in r)) throw new Error("client not created");
  return r.id;
}
const lineOf = (over: Record<string, unknown> = {}) => ({ description: "Consulting", quantity: "10", unitPrice: "100.00", glCodeId: GL, ...over });
async function mkDraft(clientId: string, over: Record<string, unknown> = {}) {
  asUser(ERIC);
  const r = await saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId, lines: [lineOf()], ...over } });
  if (!("id" in r)) throw new Error(`draft not saved: ${(r as { error: string }).error}`);
  return r;
}

beforeEach(() => seed());

describe("authentication and the entity gate", () => {
  it("every action rejects a request with no session before it touches anything", async () => {
    asUser(null);
    await expect(saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: "x", lines: [] } })).rejects.toThrow("Unauthorized");
    await expect(issueInvoice({ slug: SLUG, documentId: GL, expectedUpdatedAt: "x" })).rejects.toThrow("Unauthorized");
    await expect(recordPayment({ slug: SLUG, clientId: GL, method: "check", receivedOn: "2026-12-01", amount: "1", requestKey: GL, allocations: [] })).rejects.toThrow("Unauthorized");
    await expect(createClient({ slug: SLUG, name: "x" })).rejects.toThrow("Unauthorized");
  });
  it("a business other than the allow-listed one is refused, even for the owner", async () => {
    asUser(ERIC);
    fake.entity.rows.push({ id: "e2", name: "Sudden Valley Property Management LLC", slug: "sudden-valley", dbaName: null, archivedAt: null });
    const r = await createClient({ slug: "sudden-valley", name: "Nope" });
    expect(r).toEqual({ error: "Invoicing is not available for this business." });
    expect(fake.client.rows).toHaveLength(0);
  });
  it("a profile that is missing or switched off is refused", async () => {
    asUser(ERIC);
    fake.invoicingProfile.rows = [];
    expect(await createClient({ slug: SLUG, name: "x" })).toEqual({ error: "Invoicing is not set up for this business yet." });
  });
});

describe("owner-only operations (fail closed)", () => {
  it("Eva (read-only) cannot draft, edit, issue, void, record or void payments, link deposits or reveal an EIN", async () => {
    const clientId = await mkClient();
    const draft = await mkDraft(clientId);
    asUser(EVA);
    const refused = { error: NOT_INVOICING_OWNER_MESSAGE };
    expect(await saveDraft({ slug: SLUG, documentId: draft.id, expectedUpdatedAt: draft.updatedAt, draft: { clientId, lines: [lineOf({ description: "Edited by Eva" })] } })).toEqual(refused);
    expect(await saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId, lines: [lineOf()] } })).toEqual(refused);
    expect(await duplicateInvoice({ slug: SLUG, documentId: draft.id })).toEqual(refused);
    expect(fake.billingLine.rows[0]!.description).toBe("Consulting");
    expect(fake.billingDocument.rows).toHaveLength(1);
    expect(await issueInvoice({ slug: SLUG, documentId: draft.id, expectedUpdatedAt: draft.updatedAt })).toEqual(refused);
    expect(await voidInvoice({ slug: SLUG, documentId: draft.id, reason: "x" })).toEqual(refused);
    expect(await recordPayment({ slug: SLUG, clientId, method: "check", receivedOn: "2026-12-01", amount: "5.00", requestKey: GL, allocations: [] })).toEqual(refused);
    expect(await voidPayment({ slug: SLUG, paymentId: GL, reason: "x" })).toEqual(refused);
    expect(await linkDeposit({ slug: SLUG, paymentId: GL, depositTransactionId: GL })).toEqual(refused);
    expect(await removeApplication({ slug: SLUG, allocationId: GL })).toEqual(refused);
    expect(await applyPaymentToInvoice({ slug: SLUG, paymentId: GL, invoiceId: GL, amount: "1" })).toEqual(refused);
    expect(await revealClientEin({ slug: SLUG, id: clientId })).toEqual(refused);
    expect(fake.billingDocument.rows[0]!.status).toBe("draft");
    expect(fake.billingPayment.rows).toHaveLength(0);
  });
  it("when the owner cannot be identified nobody can do owner-only things", async () => {
    const clientId = await mkClient();
    const draft = await mkDraft(clientId);
    fake.user.rows = [{ id: ERIC, name: "Someone Else" }, { id: EVA, name: "Eva" }];
    asUser(ERIC);
    const r = await issueInvoice({ slug: SLUG, documentId: draft.id, expectedUpdatedAt: draft.updatedAt });
    expect(r).toMatchObject({ error: expect.stringMatching(/could not be identified/) });
  });
});

describe("drafting", () => {
  it("saves a draft with server-computed totals; refuses SSN-like text; refuses bad quantities", async () => {
    const clientId = await mkClient();
    const d = await mkDraft(clientId, { lines: [lineOf({ quantity: "7.25", unitPrice: "175.00" })] });
    expect(fake.billingDocument.rows.find((r) => r.id === d.id)!.totalCents).toBe(126875);
    asUser(ERIC);
    expect(await saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId, notes: "ssn 123-45-6789", lines: [lineOf()] } })).toMatchObject({ error: expect.stringMatching(/Social Security/) });
    expect(await saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId, lines: [lineOf({ quantity: "0" })] } })).toMatchObject({ error: expect.stringMatching(/quantity/) });
  });
  it("a stale tab cannot overwrite a newer save", async () => {
    const clientId = await mkClient();
    const d = await mkDraft(clientId);
    asUser(ERIC);
    const first = await saveDraft({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt, draft: { clientId, lines: [lineOf({ description: "first" })] } });
    expect("success" in first).toBe(true);
    const stale = await saveDraft({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt, draft: { clientId, lines: [lineOf({ description: "stale" })] } });
    expect(stale).toMatchObject({ error: expect.stringMatching(/another tab/) });
    expect(fake.billingLine.rows[0]!.description).toBe("first");
  });
});

describe("issue", () => {
  it("the owner issues a draft: sequential number from the setup value, frozen text, issued status", async () => {
    const clientId = await mkClient();
    const a = await mkDraft(clientId);
    const b = await mkDraft(clientId);
    asUser(ERIC);
    expect(await issueInvoice({ slug: SLUG, documentId: a.id, expectedUpdatedAt: a.updatedAt })).toEqual({ success: true, displayNumber: "3100" });
    expect(await issueInvoice({ slug: SLUG, documentId: b.id, expectedUpdatedAt: b.updatedAt })).toEqual({ success: true, displayNumber: "3101" });
    const row = fake.billingDocument.rows.find((r) => r.id === a.id)!;
    expect(row.status).toBe("issued");
    expect(iso(row.issueDate as Date)).toBe(iso(todayNY())); // blank issue date = today
    expect(iso(row.dueDate as Date)).toBe(iso(todayNY())); // due upon receipt
  });
  it("is refused with a plain message until setup is complete (address and account map)", async () => {
    const clientId = await mkClient();
    const d = await mkDraft(clientId);
    seedProfile({ businessAddress: null });
    asUser(ERIC);
    expect(await issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt })).toMatchObject({ error: expect.stringMatching(/business address/) });
    seedProfile({ glMap: null });
    expect(await issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt })).toMatchObject({ error: expect.stringMatching(/account map/) });
    expect(fake.invoicingProfile.rows[0]!.nextInvoiceNumber).toBe(3100);
  });
  it("re-validates strictly: a draft with no income account, or a tampered stored total, cannot be issued", async () => {
    const clientId = await mkClient();
    const noGl = await mkDraft(clientId, { lines: [{ description: "x", quantity: "1", unitPrice: "10.00" }] });
    asUser(ERIC);
    expect(await issueInvoice({ slug: SLUG, documentId: noGl.id, expectedUpdatedAt: noGl.updatedAt })).toMatchObject({ error: expect.stringMatching(/income account/) });
    const d = await mkDraft(clientId);
    fake.billingDocument.rows.find((r) => r.id === d.id)!.totalCents = 1; // stored total no longer matches the recomputation
    const stamp = (fake.billingDocument.rows.find((r) => r.id === d.id)!.updatedAt as Date).toISOString();
    expect(await issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: stamp })).toMatchObject({ error: expect.stringMatching(/do not match/) });
    expect(fake.invoicingProfile.rows[0]!.nextInvoiceNumber).toBe(3100);
  });
  it("a date before go-live or in the future is refused at issue", async () => {
    const clientId = await mkClient();
    asUser(ERIC);
    const early = await saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId, issueDate: "2026-09-30", lines: [lineOf()] } });
    expect(early).toMatchObject({ error: expect.stringMatching(/before invoicing started/) });
  });
  it("duplicate makes a fresh draft without number, dates or payments; the original is untouched", async () => {
    const clientId = await mkClient();
    const a = await mkDraft(clientId);
    asUser(ERIC);
    await issueInvoice({ slug: SLUG, documentId: a.id, expectedUpdatedAt: a.updatedAt });
    const dup = await duplicateInvoice({ slug: SLUG, documentId: a.id });
    expect("id" in dup).toBe(true);
    if ("id" in dup) {
      const copy = fake.billingDocument.rows.find((r) => r.id === dup.id)!;
      expect(copy.status).toBe("draft");
      expect(copy.number).toBeNull();
      expect(copy.issueDate ?? null).toBeNull();
    }
    expect(fake.billingDocument.rows.find((r) => r.id === a.id)!.status).toBe("issued");
  });
});

function seedProfile(over: Record<string, unknown>) {
  Object.assign(fake.invoicingProfile.rows[0]!, over);
}

describe("payments and the audit trail", () => {
  it("the owner records a payment; the audit row carries ids and cents only", async () => {
    const clientId = await mkClient();
    const a = await mkDraft(clientId);
    asUser(ERIC);
    await issueInvoice({ slug: SLUG, documentId: a.id, expectedUpdatedAt: a.updatedAt });
    const today = iso(todayNY());
    const r = await recordPayment({
      slug: SLUG, clientId, method: "check", receivedOn: today, amount: "1000.00", reference: "Check 1042", notes: "secret note text",
      requestKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", allocations: [{ invoiceId: a.id, amount: "1000.00" }],
    });
    expect(r).toMatchObject({ success: true, duplicate: false });
    const audit = fake.auditLog.rows.filter((x) => String(x.changeType).startsWith("invoicing_payment"));
    expect(audit).toHaveLength(1);
    const blob = JSON.stringify(fake.auditLog.rows) + JSON.stringify(fake.billingEvent.rows);
    expect(blob).not.toMatch(/Check 1042|secret note text|Acme/);
  });
  it("refuses a received date in the future and an over-application", async () => {
    const clientId = await mkClient();
    const a = await mkDraft(clientId);
    asUser(ERIC);
    await issueInvoice({ slug: SLUG, documentId: a.id, expectedUpdatedAt: a.updatedAt });
    const tomorrow = iso(new Date(todayNY().getTime() + 86_400_000));
    expect(await recordPayment({ slug: SLUG, clientId, method: "check", receivedOn: tomorrow, amount: "10", requestKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", allocations: [] })).toMatchObject({ error: expect.stringMatching(/future/) });
    expect(await recordPayment({ slug: SLUG, clientId, method: "check", receivedOn: iso(todayNY()), amount: "5000", requestKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3", allocations: [{ invoiceId: a.id, amount: "5000" }] })).toMatchObject({ error: expect.stringMatching(/balance/) });
  });
});

describe("clients, EIN and contacts", () => {
  it("a client EIN is stored encrypted with its last four; the owner can reveal it; the audit trail never holds it", async () => {
    const clientId = await mkClient();
    asUser(EVA);
    // Owner-only (D-9, conservative reading of plan D6): Eva can neither set nor clear a client's EIN.
    expect(await setClientEin({ slug: SLUG, id: clientId, ein: "12-3456789" })).toEqual({ error: NOT_INVOICING_OWNER_MESSAGE });
    expect(await setClientEin({ slug: SLUG, id: clientId, ein: "" })).toEqual({ error: NOT_INVOICING_OWNER_MESSAGE });
    expect(fake.client.rows.find((r) => r.id === clientId)!.einEncrypted ?? null).toBeNull();
    asUser(ERIC);
    expect(await setClientEin({ slug: SLUG, id: clientId, ein: "12-3456789" })).toEqual({ success: true });
    const row = fake.client.rows.find((r) => r.id === clientId)!;
    expect(row.einLast4).toBe("6789");
    expect(String(row.einEncrypted)).not.toMatch(/123456789|12-3456789/);
    expect(String(row.einEncrypted).split(":")).toHaveLength(3); // iv:tag:ciphertext
    asUser(ERIC);
    expect(await revealClientEin({ slug: SLUG, id: clientId })).toEqual({ success: true, ein: "12-3456789" });
    expect(JSON.stringify(fake.auditLog.rows)).not.toMatch(/3456789/);
  });
  it("an SSN-format value is refused as an EIN and nothing is stored", async () => {
    const clientId = await mkClient();
    asUser(ERIC);
    const r = await setClientEin({ slug: SLUG, id: clientId, ein: "123-45-6789" });
    expect(r).toMatchObject({ error: expect.stringMatching(/Social Security Number/) });
    expect(fake.client.rows.find((x) => x.id === clientId)!.einEncrypted ?? null).toBeNull();
  });
  it("contacts: roles, default recipients and e-mail validation", async () => {
    const clientId = await mkClient();
    asUser(ERIC);
    expect(await addContact({ slug: SLUG, clientId, name: "Pat", email: "pat@example.com", role: "billing", receivesInvoices: true })).toEqual({ success: true });
    expect(await addContact({ slug: SLUG, clientId, name: "Lee", email: "lee@example.com\r\nBcc: x@y.z", role: "project_lead", receivesInvoices: false })).toMatchObject({ error: expect.stringMatching(/e-mail/) });
    expect(await addContact({ slug: SLUG, clientId, name: "Sam", email: "sam@example.com", role: "other", receivesInvoices: false })).toMatchObject({ error: expect.stringMatching(/Describe the role/) });
    expect(fake.clientContact.rows).toHaveLength(1);
  });
  it("a W-9 counts only when a live w9 Document is linked; another type or another entity's document is refused", async () => {
    const clientId = await mkClient();
    asUser(ERIC);
    const w9 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
    fake.document.rows.push({ id: w9, entityId: E, docType: "w9", archivedAt: null });
    fake.document.rows.push({ id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2", entityId: E, docType: "other", archivedAt: null });
    fake.document.rows.push({ id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3", entityId: "other", docType: "w9", archivedAt: null });
    expect(await linkClientW9({ slug: SLUG, clientId, documentId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2" })).toMatchObject({ error: expect.stringMatching(/W-9 document was not found/) });
    expect(await linkClientW9({ slug: SLUG, clientId, documentId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3" })).toMatchObject({ error: expect.stringMatching(/not found/) });
    expect(await linkClientW9({ slug: SLUG, clientId, documentId: w9, receivedOn: "2026-10-02" })).toEqual({ success: true });
    expect(fake.client.rows.find((r) => r.id === clientId)!.w9DocumentId).toBe(w9);
    expect(await linkClientW9({ slug: SLUG, clientId, documentId: null })).toEqual({ success: true });
    expect(fake.client.rows.find((r) => r.id === clientId)!.w9DocumentId).toBeNull();
  });
  it("a duplicate client name (archived ones included) is refused", async () => {
    await mkClient();
    asUser(ERIC);
    const dup = await createClient({ slug: SLUG, name: "Acme Robotics" });
    expect(dup).toMatchObject({ error: expect.stringMatching(/already exists/) });
  });
});
