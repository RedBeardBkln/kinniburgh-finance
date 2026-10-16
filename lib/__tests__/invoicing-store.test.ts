import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});

import { db } from "@/lib/db";
import * as store from "@/lib/invoicing/store";
import { CHANGED_IN_OTHER_TAB } from "@/lib/invoicing/errors";
import { validateDraft, validatePayment, type DraftInput, type PaymentInput } from "@/lib/invoicing/validate";

const fake = db as unknown as FakeDb;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const E = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const C2 = "22222222-2222-4222-8222-222222222223";
const GL = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";
const DEP1 = "66666666-6666-4666-8666-666666666661";
const DEP2 = "66666666-6666-4666-8666-666666666662";
const ARCH = "66666666-6666-4666-8666-666666666663";
const XFER = "66666666-6666-4666-8666-666666666664";
const OUT = "66666666-6666-4666-8666-666666666665";
const FOREIGN = "66666666-6666-4666-8666-666666666666";
const ctx = { today: d("2026-12-15"), goLiveOn: d("2026-10-01"), forIssue: false };
let keySeq = 0;
const key = () => `55555555-5555-4555-8555-${String(++keySeq).padStart(12, "0")}`;

function seed(over: Record<string, unknown> = {}) {
  fake.invoicingProfile.rows = [{ id: "p1", entityId: E, enabled: true, nextInvoiceNumber: 3100, invoicePrefix: "", numberPad: 0, defaultNetDays: 0, ...over }];
  fake.client.rows = [
    { id: C, entityId: E, name: "Acme", archivedAt: null },
    { id: C2, entityId: E, name: "Other Co", archivedAt: null },
  ];
  fake.glCode.rows = [{ id: GL, entityId: E, archivedAt: null, type: "revenue" }];
  for (const t of [fake.billingDocument, fake.billingLine, fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.transaction]) t.rows = [];
}

const draftInput = (over: Partial<DraftInput> = {}): DraftInput => ({
  clientId: C,
  billingModel: "hourly",
  lines: [{ description: "Consulting", quantity: "10", unitPrice: "100.00", glCodeId: GL }],
  ...over,
});
const draft = (over: Partial<DraftInput> = {}) => {
  const r = validateDraft(draftInput(over), ctx);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

async function newDraft(over: Partial<DraftInput> = {}) {
  return store.saveDraft({ entityId: E, userId: USER, documentId: null, expectedUpdatedAt: null, draft: draft(over) });
}
async function issue(id: string, updatedAt: Date, issueDate = "2026-11-05") {
  return store.issueInvoice({ entityId: E, userId: USER, documentId: id, expectedUpdatedAt: updatedAt, issueDate: d(issueDate), netDays: 0, glCodeIds: [GL] });
}
async function issuedInvoice(over: Partial<DraftInput> = {}, issueDate = "2026-11-05") {
  const s = await newDraft(over);
  await issue(s.id, s.updatedAt, issueDate);
  return s.id;
}
const payInput = (invoiceId: string | null, over: Partial<PaymentInput> = {}): PaymentInput => ({
  clientId: C,
  method: "check",
  receivedOn: "2026-12-01",
  amount: "1000.00",
  requestKey: key(),
  allocations: invoiceId ? [{ invoiceId, amount: "1000.00" }] : [],
  ...over,
});
const payment = (input: PaymentInput) => {
  const r = validatePayment(input, { today: ctx.today, goLiveOn: ctx.goLiveOn });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const record = (input: PaymentInput) => store.recordPayment({ entityId: E, userId: USER, payment: payment(input) });
const counter = () => fake.invoicingProfile.rows[0]!.nextInvoiceNumber;
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

beforeEach(() => seed());

describe("drafts", () => {
  it("creates a draft with its totals and lines and a timeline event; no number yet", async () => {
    const s = await newDraft();
    const row = fake.billingDocument.rows[0]!;
    expect(row.status).toBe("draft");
    expect(row.number).toBeNull();
    expect(row.totalCents).toBe(100000);
    expect(fake.billingLine.rows).toHaveLength(1);
    expect(fake.billingEvent.rows.map((e) => e.kind)).toEqual(["created"]);
    expect(s.id).toBe(row.id);
  });
  it("an update replaces the lines (the one place rows are deleted) and refuses a stale stamp", async () => {
    const s = await newDraft();
    const second = draft({ lines: [{ description: "A", quantity: "1", unitPrice: "10", glCodeId: GL }, { description: "B", quantity: "2", unitPrice: "20", glCodeId: GL }] });
    const saved = await store.saveDraft({ entityId: E, userId: USER, documentId: s.id, expectedUpdatedAt: s.updatedAt, draft: second });
    expect(fake.billingLine.rows).toHaveLength(2);
    expect(fake.billingDocument.rows[0]!.totalCents).toBe(5000);
    // The old stamp is now stale: another tab saved in between.
    const msg = await refusal(store.saveDraft({ entityId: E, userId: USER, documentId: s.id, expectedUpdatedAt: s.updatedAt, draft: second }));
    expect(msg).toBe(CHANGED_IN_OTHER_TAB);
    expect(saved.updatedAt.getTime()).toBeGreaterThan(s.updatedAt.getTime());
  });
  it("refuses a draft for an archived client or another entity's GL account", async () => {
    fake.client.rows[0]!.archivedAt = d("2026-11-01");
    expect(await refusal(newDraft())).toMatch(/client/);
    seed();
    fake.glCode.rows[0]!.entityId = "other-entity";
    expect(await refusal(newDraft())).toMatch(/income accounts/);
  });
  it("an issued document can no longer be edited", async () => {
    const s = await newDraft();
    await issue(s.id, s.updatedAt);
    const fresh = fake.billingDocument.rows[0]!;
    const msg = await refusal(store.saveDraft({ entityId: E, userId: USER, documentId: s.id, expectedUpdatedAt: fresh.updatedAt as Date, draft: draft() }));
    expect(msg).toBe(CHANGED_IN_OTHER_TAB);
  });
});

describe("payment terms precedence", () => {
  it("the invoice's own days win, then the client's default, then the profile default", async () => {
    seed({ defaultNetDays: 0 });
    const profileOnly = await newDraft({ issueDate: "2026-11-05" });
    expect(fake.billingDocument.rows.find((r) => r.id === profileOnly.id)!.dueDate).toEqual(d("2026-11-05"));
    fake.client.rows[0]!.defaultNetDays = 30;
    const clientDefault = await newDraft({ issueDate: "2026-11-05" });
    expect(fake.billingDocument.rows.find((r) => r.id === clientDefault.id)!.dueDate).toEqual(d("2026-12-05"));
    const own = await newDraft({ issueDate: "2026-11-05", netDays: 10 });
    expect(fake.billingDocument.rows.find((r) => r.id === own.id)!.dueDate).toEqual(d("2026-11-15"));
  });
});

describe("numbering", () => {
  it("issues sequential numbers from the owner-supplied start, frozen as text", async () => {
    const a = await newDraft();
    const b = await newDraft();
    const ra = await issue(a.id, a.updatedAt);
    const rb = await issue(b.id, b.updatedAt);
    expect([ra.number, rb.number]).toEqual([3100, 3101]);
    expect(ra.displayNumber).toBe("3100");
    expect(counter()).toBe(3102);
  });
  it("formats prefix and padding", async () => {
    seed({ invoicePrefix: "INV-", numberPad: 5 });
    const a = await newDraft();
    expect((await issue(a.id, a.updatedAt)).displayNumber).toBe("INV-03100");
  });
  it("two tabs issuing the SAME draft: one wins, the other is told it changed, and the counter moves once", async () => {
    const s = await newDraft();
    const results = await Promise.allSettled([issue(s.id, s.updatedAt), issue(s.id, s.updatedAt)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.message).toBe(CHANGED_IN_OTHER_TAB);
    expect(counter()).toBe(3101);
    expect(fake.billingDocument.rows.filter((r) => r.number !== null)).toHaveLength(1);
  });
  it("a failed issue burns no number (stale stamp, then a good issue still gets the first number)", async () => {
    const s = await newDraft();
    const msg = await refusal(issue(s.id, new Date(s.updatedAt.getTime() - 5)));
    expect(msg).toBe(CHANGED_IN_OTHER_TAB);
    expect(counter()).toBe(3100);
    expect((await issue(s.id, s.updatedAt)).number).toBe(3100);
  });
  it("a missing GL account fails the issue before the counter is touched", async () => {
    const s = await newDraft();
    fake.glCode.rows[0]!.archivedAt = d("2026-11-01");
    expect(await refusal(issue(s.id, s.updatedAt))).toMatch(/income accounts/);
    expect(counter()).toBe(3100);
  });
  it("two different drafts issued concurrently get distinct consecutive numbers", async () => {
    const a = await newDraft();
    const b = await newDraft();
    const [ra, rb] = await Promise.all([issue(a.id, a.updatedAt), issue(b.id, b.updatedAt)]);
    expect([ra.number, rb.number].sort()).toEqual([3100, 3101]);
  });
  it("the counter can be raised but never lowered or set to a used number", async () => {
    await issuedInvoice();
    expect(await refusal(store.setInvoiceCounter(E, 3100))).toMatch(/never reused|only go up/);
    expect(await refusal(store.setInvoiceCounter(E, 3050))).toMatch(/never reused|only go up/);
    await store.setInvoiceCounter(E, 3200);
    expect(counter()).toBe(3200);
  });
});

describe("void", () => {
  it("keeps the row and the number; numbers are never reused", async () => {
    const id = await issuedInvoice();
    await store.voidInvoice({ entityId: E, userId: USER, documentId: id, reason: "entered twice" });
    const row = fake.billingDocument.rows[0]!;
    expect(row.status).toBe("void");
    expect(row.number).toBe(3100);
    const next = await newDraft();
    expect((await issue(next.id, next.updatedAt)).number).toBe(3101);
  });
  it("is refused while a payment is applied, allowed once the application is removed", async () => {
    const id = await issuedInvoice();
    await record(payInput(id));
    expect(await refusal(store.voidInvoice({ entityId: E, userId: USER, documentId: id, reason: "x" }))).toMatch(/payments applied/);
    const alloc = fake.billingAllocation.rows[0]!;
    await store.deallocate({ entityId: E, userId: USER, allocationId: alloc.id as string });
    await store.voidInvoice({ entityId: E, userId: USER, documentId: id, reason: "x" });
    expect(fake.billingDocument.rows[0]!.status).toBe("void");
  });
  it("a draft cannot be voided", async () => {
    const s = await newDraft();
    expect(await refusal(store.voidInvoice({ entityId: E, userId: USER, documentId: s.id, reason: "x" }))).toMatch(/Only an issued invoice/);
  });
});

describe("payments", () => {
  it("records a payment with its application; appliedOn is the later of the receipt day and the issue date", async () => {
    const id = await issuedInvoice({}, "2026-11-05");
    const r = await record(payInput(id, { receivedOn: "2026-11-20" }));
    expect(r.duplicate).toBe(false);
    expect(fake.billingAllocation.rows[0]!.appliedOn).toEqual(d("2026-11-20"));
    // A prepayment received before the invoice was issued is applied on the issue date.
    const id2 = await issuedInvoice({}, "2026-12-10");
    await record(payInput(id2, { receivedOn: "2026-12-01" }));
    expect(fake.billingAllocation.rows.find((a) => a.invoiceId === id2)!.appliedOn).toEqual(d("2026-12-10"));
  });
  it("partial payments leave a balance; applying more than the balance is refused (no over-allocation)", async () => {
    const id = await issuedInvoice(); // 1000.00
    await record(payInput(id, { amount: "400.00", allocations: [{ invoiceId: id, amount: "400.00" }] }));
    const msg = await refusal(record(payInput(id, { amount: "700.00", allocations: [{ invoiceId: id, amount: "700.00" }] })));
    expect(msg).toMatch(/more than that invoice's balance/);
    await record(payInput(id, { amount: "600.00", allocations: [{ invoiceId: id, amount: "600.00" }] }));
    expect(fake.billingAllocation.rows.reduce((s, a) => s + (a.amountCents as number), 0)).toBe(100000);
  });
  it("an overpayment keeps the excess unallocated and the invoice is fully applied", async () => {
    const id = await issuedInvoice();
    await record(payInput(id, { amount: "1200.00", allocations: [{ invoiceId: id, amount: "1000.00" }] }));
    expect(fake.billingPayment.rows[0]!.amountCents).toBe(120000);
    expect(fake.billingAllocation.rows).toHaveLength(1);
  });
  it("refuses to apply to a draft, a void invoice or another client's invoice", async () => {
    const draftDoc = await newDraft();
    expect(await refusal(record(payInput(draftDoc.id)))).toMatch(/issued invoices/);
    const id = await issuedInvoice();
    expect(await refusal(record(payInput(id, { clientId: C2 })))).toMatch(/not found for this client/);
    await store.voidInvoice({ entityId: E, userId: USER, documentId: id, reason: "x" });
    expect(await refusal(record(payInput(id)))).toMatch(/issued invoices/);
  });
  it("double submit records ONE payment (same request key), also when the two calls race", async () => {
    const id = await issuedInvoice();
    const input = payInput(id);
    const [a, b] = await Promise.all([record(input), record(input)]);
    expect(fake.billingPayment.rows).toHaveLength(1);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(a.id).toBe(b.id);
    expect(fake.billingAllocation.rows).toHaveLength(1);
  });
  it("a payment may be recorded with no application at all (client credit), then applied later within its remainder", async () => {
    const id = await issuedInvoice();
    const { id: pid } = await record(payInput(null, { amount: "600.00" }));
    await store.allocateExisting({ entityId: E, userId: USER, paymentId: pid, invoiceId: id, amountCents: 40000, today: d("2026-12-10") });
    expect(await refusal(store.allocateExisting({ entityId: E, userId: USER, paymentId: pid, invoiceId: id, amountCents: 30000, today: d("2026-12-10") }))).toMatch(/left of this payment/);
    expect(await refusal(store.allocateExisting({ entityId: E, userId: USER, paymentId: pid, invoiceId: id, amountCents: 70000, today: d("2026-12-10") }))).toMatch(/invoice balance|left of this payment/);
    await store.allocateExisting({ entityId: E, userId: USER, paymentId: pid, invoiceId: id, amountCents: 20000, today: d("2026-12-10") });
  });
  it("voiding a payment needs its applications removed first; the row is kept", async () => {
    const id = await issuedInvoice();
    const { id: pid } = await record(payInput(id));
    expect(await refusal(store.voidPayment({ entityId: E, userId: USER, paymentId: pid, reason: "bounced" }))).toMatch(/applications/);
    await store.deallocate({ entityId: E, userId: USER, allocationId: fake.billingAllocation.rows[0]!.id as string });
    await store.voidPayment({ entityId: E, userId: USER, paymentId: pid, reason: "bounced" });
    expect(fake.billingPayment.rows[0]!.status).toBe("void");
    expect(fake.billingAllocation.rows).toHaveLength(1); // voided, never deleted
    expect(fake.billingAllocation.rows[0]!.voidedAt).not.toBeNull();
  });
  it("a removed application can be re-applied (balance is restored)", async () => {
    const id = await issuedInvoice();
    const { id: pid } = await record(payInput(id));
    await store.deallocate({ entityId: E, userId: USER, allocationId: fake.billingAllocation.rows[0]!.id as string });
    await store.allocateExisting({ entityId: E, userId: USER, paymentId: pid, invoiceId: id, amountCents: 100000, today: d("2026-12-10") });
    expect(fake.billingAllocation.rows.filter((a) => a.voidedAt === null)).toHaveLength(1);
  });
});

describe("bank deposit links", () => {
  const deposit = (id: string, amount: string, over: Record<string, unknown> = {}) => fake.transaction.rows.push({ id, entityId: E, amount: new Prisma.Decimal(amount), archivedAt: null, transferPairId: null, ...over });
  it("links a deposit and enforces the shared-deposit sum rule (net of fees)", async () => {
    const i1 = await issuedInvoice();
    const i2 = await issuedInvoice();
    deposit(DEP1, "1000.00");
    const a = await record(payInput(i1, { amount: "600.00", allocations: [{ invoiceId: i1, amount: "600.00" }], depositTransactionId: DEP1, fee: "20.00" })); // net 580
    expect(fake.billingPayment.rows[0]!.depositTransactionId).toBe(DEP1);
    // 580 + 420 = 1000 is fine
    await record(payInput(i2, { amount: "420.00", allocations: [{ invoiceId: i2, amount: "420.00" }], depositTransactionId: DEP1 }));
    // one more cent is not
    expect(await refusal(record(payInput(null, { amount: "0.01", depositTransactionId: DEP1 })))).toMatch(/fully matched/);
    expect(a.duplicate).toBe(false);
  });
  it("refuses an archived deposit, a transfer leg, an outflow and another entity's transaction", async () => {
    const id = await issuedInvoice();
    deposit(ARCH, "1000.00", { archivedAt: d("2026-12-01") });
    deposit(XFER, "1000.00", { transferPairId: "pair" });
    deposit(OUT, "-1000.00");
    deposit(FOREIGN, "1000.00", { entityId: "other" });
    for (const dep of [ARCH, XFER, FOREIGN]) {
      expect(await refusal(record(payInput(id, { depositTransactionId: dep })))).toMatch(/not found/);
    }
    expect(await refusal(record(payInput(id, { depositTransactionId: OUT })))).toMatch(/not a deposit/);
    expect(fake.billingPayment.rows).toHaveLength(0);
  });
  it("link and unlink an existing payment; the deposit row is never changed", async () => {
    const id = await issuedInvoice();
    deposit(DEP2, "1000.00");
    const before = JSON.stringify(fake.transaction.rows);
    const { id: pid } = await record(payInput(id));
    await store.linkDeposit({ entityId: E, userId: USER, paymentId: pid, depositTransactionId: DEP2 });
    expect(await refusal(store.linkDeposit({ entityId: E, userId: USER, paymentId: pid, depositTransactionId: DEP2 }))).toMatch(/already has a bank deposit/);
    await store.unlinkDeposit({ entityId: E, userId: USER, paymentId: pid });
    expect(fake.billingPayment.rows[0]!.depositTransactionId).toBeNull();
    expect(JSON.stringify(fake.transaction.rows)).toBe(before);
  });
});

describe("entity scoping and the timeline", () => {
  it("another entity's invoice or payment is simply not found", async () => {
    const id = await issuedInvoice();
    expect(await refusal(store.voidInvoice({ entityId: "other-entity", userId: USER, documentId: id, reason: "x" }))).toMatch(/not found/);
    const { id: pid } = await record(payInput(id));
    expect(await refusal(store.voidPayment({ entityId: "other-entity", userId: USER, paymentId: pid, reason: "x" }))).toMatch(/not found/);
  });
  it("every timeline row carries only ids, counts and cents", async () => {
    const id = await issuedInvoice();
    await record(payInput(id));
    for (const e of fake.billingEvent.rows) {
      for (const v of Object.values(e.data as Record<string, unknown>)) expect(["number", "boolean", "string"]).toContain(typeof v);
      expect(JSON.stringify(e.data)).not.toMatch(/@|\s/);
    }
    expect(fake.billingEvent.rows.map((e) => e.kind)).toEqual(expect.arrayContaining(["created", "issued", "payment_recorded", "allocated"]));
  });
});
