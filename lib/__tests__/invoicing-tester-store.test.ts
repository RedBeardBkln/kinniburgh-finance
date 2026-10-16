// Tester probes (ek-consulting-invoicing) on the fake-db store: idempotency, overpayment, void rules, shared deposits, a 400-step random-operation invariant fuzz. D-1, D-2 and D-6 (03-test-report.md) were fixed in round 2; their former `it.fails` pins are plain `it` tests now, with extra cases for each.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "./invoicing-fake-db";

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("./invoicing-fake-db");
  return { db: createFakeDb() };
});

import { db } from "@/lib/db";
import * as store from "@/lib/invoicing/store";
import { validateDraft, validatePayment, type DraftInput, type PaymentInput } from "@/lib/invoicing/validate";

const fake = db as unknown as FakeDb;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const E = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const C2 = "22222222-2222-4222-8222-222222222223";
const GL = "33333333-3333-4333-8333-333333333333";
const GL_EXP = "33333333-3333-4333-8333-333333333334";
const USER = "44444444-4444-4444-8444-444444444444";
const DEP = "66666666-6666-4666-8666-666666666661";
const ctx = { today: d("2026-12-15"), goLiveOn: d("2026-10-01"), forIssue: false };
let ks = 0;
const key = () => `55555555-5555-4555-8555-${String(++ks).padStart(12, "0")}`;

function seed() {
  fake.invoicingProfile.rows = [{ id: "p1", entityId: E, enabled: true, nextInvoiceNumber: 3100, invoicePrefix: "", numberPad: 0, defaultNetDays: 0 }];
  fake.client.rows = [
    { id: C, entityId: E, name: "Acme", archivedAt: null },
    { id: C2, entityId: E, name: "Other", archivedAt: null },
  ];
  // GL_EXP is an EXPENSE account of the same entity: the store must refuse it for invoice lines and catalog items (D-1)
  fake.glCode.rows = [
    { id: GL, entityId: E, archivedAt: null, type: "revenue" },
    { id: GL_EXP, entityId: E, archivedAt: null, type: "expense" },
  ];
  for (const t of [fake.billingDocument, fake.billingLine, fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.transaction]) t.rows = [];
  fake.transaction.rows = [{ id: DEP, entityId: E, archivedAt: null, transferPairId: null, pending: false, amount: { toFixed: () => "1000.00" } }];
}
const dr = (over: Partial<DraftInput> = {}) => {
  const r = validateDraft({ clientId: C, lines: [{ description: "Work", quantity: "1", unitPrice: "100.00", glCodeId: GL }], ...over }, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
async function issued(over: Partial<DraftInput> = {}, date = "2026-11-05") {
  const s = await store.saveDraft({ entityId: E, userId: USER, documentId: null, expectedUpdatedAt: null, draft: dr(over) });
  await store.issueInvoice({ entityId: E, userId: USER, documentId: s.id, expectedUpdatedAt: s.updatedAt, issueDate: d(date), netDays: 0, glCodeIds: [GL] });
  return s.id;
}
const pay = (inv: string | null, over: Partial<PaymentInput> = {}) => {
  const r = validatePayment({ clientId: C, method: "check", receivedOn: "2026-12-01", amount: "100.00", requestKey: key(), allocations: inv ? [{ invoiceId: inv, amount: "100.00" }] : [], ...over }, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const rec = (p: ReturnType<typeof pay>) => store.recordPayment({ entityId: E, userId: USER, payment: p });
const msg = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

beforeEach(seed);

describe("probe: store", () => {
  it("D-1: a line (or catalog item) must point at a live REVENUE account of this entity; an expense account is refused at save, at issue and for items", async () => {
    const draft = dr({ lines: [{ description: "Work", quantity: "1", unitPrice: "100.00", glCodeId: GL_EXP }] });
    expect(await msg(store.saveDraft({ entityId: E, userId: USER, documentId: null, expectedUpdatedAt: null, draft }))).toMatch(/not a revenue account/);
    expect(fake.billingDocument.rows).toHaveLength(0);
    // issue re-checks the accounts of the lines it freezes
    const s = await store.saveDraft({ entityId: E, userId: USER, documentId: null, expectedUpdatedAt: null, draft: dr() });
    expect(await msg(store.issueInvoice({ entityId: E, userId: USER, documentId: s.id, expectedUpdatedAt: s.updatedAt, issueDate: d("2026-11-05"), netDays: 0, glCodeIds: [GL_EXP] }))).toMatch(/not a revenue account/);
    expect(fake.billingDocument.rows[0]!.status).toBe("draft");
    expect(fake.invoicingProfile.rows[0]!.nextInvoiceNumber).toBe(3100); // the refused issue burned no number
    // catalog items
    const item = { name: "Prints", unit: "ea", unitCostCents: 100, pricingMode: "markup", markupBps: 1000, billedUnitPriceCents: null, glCodeId: GL_EXP, taxable: false } as unknown as Parameters<typeof store.createItem>[2];
    expect(await msg(store.createItem(E, USER, item))).toMatch(/not a revenue account/);
    const ok = await store.createItem(E, USER, { ...item, glCodeId: GL });
    expect(await msg(store.updateItem(E, ok, { ...item, glCodeId: GL_EXP }))).toMatch(/not a revenue account/);
    // a revenue account of ANOTHER entity is still refused
    fake.glCode.rows.push({ id: "33333333-3333-4333-8333-333333333335", entityId: "other", archivedAt: null, type: "revenue" });
    expect(await msg(store.createItem(E, USER, { ...item, name: "Other", glCodeId: "33333333-3333-4333-8333-333333333335" }))).toMatch(/not found/);
    // and a revenue account is accepted
    expect(await msg(store.saveDraft({ entityId: E, userId: USER, documentId: null, expectedUpdatedAt: null, draft: dr() }))).toBeNull();
  });

  it("5 parallel submits of the same requestKey record exactly one payment", async () => {
    const inv = await issued();
    const p = pay(inv);
    const res = await Promise.all([1, 2, 3, 4, 5].map(() => rec(p)));
    expect(res.filter((x) => !x.duplicate)).toHaveLength(1);
    expect(new Set(res.map((x) => x.id)).size).toBe(1);
    expect(fake.billingPayment.rows).toHaveLength(1);
    expect(fake.billingAllocation.rows).toHaveLength(1);
  });

  it("overpayment keeps the remainder unallocated; later apply cannot exceed it; applying to another client's invoice is refused", async () => {
    const a = await issued();
    const b = await issued();
    const p = await rec(pay(a, { amount: "250.00", allocations: [{ invoiceId: a, amount: "100.00" }] }));
    expect(await msg(store.allocateExisting({ entityId: E, userId: USER, paymentId: p.id, invoiceId: b, amountCents: 15001, today: d("2026-12-10") }))).toMatch(/more than/);
    await store.allocateExisting({ entityId: E, userId: USER, paymentId: p.id, invoiceId: b, amountCents: 10000, today: d("2026-12-10") });
    expect(await msg(store.allocateExisting({ entityId: E, userId: USER, paymentId: p.id, invoiceId: b, amountCents: 5001, today: d("2026-12-10") }))).toMatch(/more than/);
    const other = await store.saveDraft({ entityId: E, userId: USER, documentId: null, expectedUpdatedAt: null, draft: dr({ clientId: C2 }) });
    await store.issueInvoice({ entityId: E, userId: USER, documentId: other.id, expectedUpdatedAt: other.updatedAt, issueDate: d("2026-11-06"), netDays: 0, glCodeIds: [GL] });
    expect(await msg(store.allocateExisting({ entityId: E, userId: USER, paymentId: p.id, invoiceId: other.id, amountCents: 100, today: d("2026-12-10") }))).toMatch(/client/);
  });

  it("void rules: invoice with payment cannot void; payment with allocation cannot void; remove then both can; void invoice cannot take payment", async () => {
    const inv = await issued();
    const p = await rec(pay(inv));
    expect(await msg(store.voidInvoice({ entityId: E, userId: USER, documentId: inv, reason: "x" }))).toMatch(/applied/);
    expect(await msg(store.voidPayment({ entityId: E, userId: USER, paymentId: p.id, reason: "x" }))).toMatch(/applications/);
    const alloc = fake.billingAllocation.rows[0]!;
    await store.deallocate({ entityId: E, userId: USER, allocationId: alloc.id as string });
    expect(await msg(store.deallocate({ entityId: E, userId: USER, allocationId: alloc.id as string }))).toMatch(/not found/);
    await store.voidPayment({ entityId: E, userId: USER, paymentId: p.id, reason: "bounced" });
    expect(await msg(store.voidPayment({ entityId: E, userId: USER, paymentId: p.id, reason: "again" }))).toMatch(/already void/);
    await store.voidInvoice({ entityId: E, userId: USER, documentId: inv, reason: "dup" });
    expect(await msg(rec(pay(inv)))).toMatch(/issued invoices/);
    expect(await msg(store.voidInvoice({ entityId: E, userId: USER, documentId: inv, reason: "again" }))).toMatch(/Only an issued/);
    const nextNo = await issued();
    expect(fake.billingDocument.rows.find((r) => r.id === nextNo)!.number).toBe(3101); // voided 3100 not reused
  });

  it("shared deposit: sum of net may not exceed the deposit; a voided or unlinked payment frees capacity; archived / transfer / outflow refused", async () => {
    const inv = await issued({ lines: [{ description: "Big", quantity: "1", unitPrice: "2000.00", glCodeId: GL }] });
    const p1 = await rec(pay(inv, { amount: "600.00", allocations: [], depositTransactionId: DEP }));
    expect(await msg(rec(pay(inv, { amount: "500.00", allocations: [], depositTransactionId: DEP })))).toMatch(/fully matched/);
    const p2 = await rec(pay(inv, { amount: "400.00", allocations: [], depositTransactionId: DEP }));
    expect(await msg(rec(pay(inv, { amount: "0.01", allocations: [], depositTransactionId: DEP })))).toMatch(/fully matched/);
    await store.voidPayment({ entityId: E, userId: USER, paymentId: p1.id, reason: "bounced" });
    const p3 = await rec(pay(inv, { amount: "600.00", allocations: [], depositTransactionId: DEP }));
    expect(p3.duplicate).toBe(false);
    await store.unlinkDeposit({ entityId: E, userId: USER, paymentId: p2.id });
    expect(await msg(store.linkDeposit({ entityId: E, userId: USER, paymentId: p2.id, depositTransactionId: DEP }))).toBeNull();
    // fee: net counts
    fake.billingPayment.rows.forEach((r) => (r.depositTransactionId = null));
    const p4 = await rec(pay(inv, { amount: "1000.00", fee: "29.30", allocations: [], depositTransactionId: DEP }));
    expect(p4.duplicate).toBe(false);
    expect(await msg(rec(pay(inv, { amount: "29.31", allocations: [], depositTransactionId: DEP })))).toMatch(/fully matched/);
    fake.transaction.rows[0]!.archivedAt = d("2026-12-01");
    expect(await msg(rec(pay(inv, { amount: "1.00", allocations: [], depositTransactionId: DEP })))).toMatch(/not found/);
    fake.transaction.rows[0]!.archivedAt = null;
    fake.transaction.rows[0]!.transferPairId = "t";
    expect(await msg(rec(pay(inv, { amount: "1.00", allocations: [], depositTransactionId: DEP })))).toMatch(/not found/);
    fake.transaction.rows[0]!.transferPairId = null;
    fake.transaction.rows[0]!.amount = { toFixed: () => "-50.00" };
    expect(await msg(rec(pay(inv, { amount: "1.00", allocations: [], depositTransactionId: DEP })))).toMatch(/not a deposit/);
    fake.transaction.rows[0]!.entityId = "other";
    fake.transaction.rows[0]!.amount = { toFixed: () => "1000.00" };
    expect(await msg(rec(pay(inv, { amount: "1.00", allocations: [], depositTransactionId: DEP })))).toMatch(/not found/);
  });

  it("validation: same invoice twice, allocations > payment, fee >= amount, future date, before go-live, bad key", () => {
    const inv = "77777777-7777-4777-8777-777777777777";
    const v = (o: Partial<PaymentInput>) => validatePayment({ clientId: C, method: "check", receivedOn: "2026-12-01", amount: "100.00", requestKey: key(), allocations: [], ...o }, ctx);
    expect(v({ allocations: [{ invoiceId: inv, amount: "10" }, { invoiceId: inv, amount: "10" }] }).ok).toBe(false);
    expect(v({ allocations: [{ invoiceId: inv, amount: "100.01" }] }).ok).toBe(false);
    expect(v({ fee: "100.00" }).ok).toBe(false);
    expect(v({ receivedOn: "2026-12-16" }).ok).toBe(false);
    expect(v({ receivedOn: "2026-09-30" }).ok).toBe(false);
    expect(v({ requestKey: "not-a-uuid" }).ok).toBe(false);
    expect(v({ amount: "0" }).ok).toBe(false);
    expect(v({ amount: "-5" }).ok).toBe(false);
    expect(v({ reference: "1234567890" }).ok).toBe(false); // account-number-like
  });

  it("random op fuzz: invariants hold (no negative balance, no over-applied payment, unique numbers, deposit sums)", async () => {
    let seedN = 12345;
    const r = () => ((seedN = (Math.imul(seedN, 1664525) + 1013904223) >>> 0) / 4294967296);
    const invs: string[] = [];
    for (let step = 0; step < 400; step += 1) {
      const roll = r();
      try {
        if (roll < 0.2 || invs.length === 0) invs.push(await issued({ lines: [{ description: "W", quantity: "1", unitPrice: String(1 + Math.floor(r() * 500)) + ".00", glCodeId: GL }] }));
        else if (roll < 0.55) {
          const inv = invs[Math.floor(r() * invs.length)]!;
          const amt = (1 + Math.floor(r() * 700)).toFixed(2);
          const alloc = r() < 0.7 ? [{ invoiceId: inv, amount: Math.min(Number(amt), 1 + Math.floor(r() * 500)).toFixed(2) }] : [];
          await rec(pay(null, { amount: amt, allocations: alloc, depositTransactionId: r() < 0.3 ? DEP : null }));
        } else if (roll < 0.7 && fake.billingPayment.rows.length) {
          const p = fake.billingPayment.rows[Math.floor(r() * fake.billingPayment.rows.length)]!;
          await store.allocateExisting({ entityId: E, userId: USER, paymentId: p.id as string, invoiceId: invs[Math.floor(r() * invs.length)]!, amountCents: 1 + Math.floor(r() * 30000), today: d("2026-12-10") });
        } else if (roll < 0.8 && fake.billingAllocation.rows.length) {
          const a = fake.billingAllocation.rows[Math.floor(r() * fake.billingAllocation.rows.length)]!;
          await store.deallocate({ entityId: E, userId: USER, allocationId: a.id as string });
        } else if (roll < 0.88 && fake.billingPayment.rows.length) {
          const p = fake.billingPayment.rows[Math.floor(r() * fake.billingPayment.rows.length)]!;
          await store.voidPayment({ entityId: E, userId: USER, paymentId: p.id as string, reason: "r" });
        } else if (roll < 0.94) {
          await store.voidInvoice({ entityId: E, userId: USER, documentId: invs[Math.floor(r() * invs.length)]!, reason: "r" });
        } else if (fake.billingPayment.rows.length) {
          const p = fake.billingPayment.rows[Math.floor(r() * fake.billingPayment.rows.length)]!;
          if (p.depositTransactionId) await store.unlinkDeposit({ entityId: E, userId: USER, paymentId: p.id as string });
          else await store.linkDeposit({ entityId: E, userId: USER, paymentId: p.id as string, depositTransactionId: DEP });
        }
      } catch (e) {
        if ((e as Error).name !== "InvoicingRefusal") throw e;
      }
      // invariants
      const act = fake.billingAllocation.rows.filter((a) => a.voidedAt === null);
      for (const doc of fake.billingDocument.rows) {
        const sum = act.filter((a) => a.invoiceId === doc.id).reduce((s, a) => s + (a.amountCents as number), 0);
        expect(sum).toBeLessThanOrEqual(doc.totalCents as number);
        if (doc.status === "void") expect(sum).toBe(0);
      }
      for (const p of fake.billingPayment.rows) {
        const sum = act.filter((a) => a.paymentId === p.id).reduce((s, a) => s + (a.amountCents as number), 0);
        expect(sum).toBeLessThanOrEqual(p.amountCents as number);
        if (p.status === "void") expect(sum).toBe(0);
      }
      const linkedNet = fake.billingPayment.rows.filter((p) => p.status === "recorded" && p.depositTransactionId === DEP).reduce((s, p) => s + (p.amountCents as number) - (p.feeCents as number), 0);
      expect(linkedNet).toBeLessThanOrEqual(100000);
      const nums = fake.billingDocument.rows.map((x) => x.number).filter((n) => n !== null);
      expect(new Set(nums).size).toBe(nums.length);
      expect(nums.length ? Math.max(...(nums as number[])) : 0).toBeLessThan(fake.invoicingProfile.rows[0]!.nextInvoiceNumber as number);
    }
    expect(fake.billingDocument.rows.length).toBeGreaterThan(5);
  });
});

describe("archived client with an open invoice (D-2)", () => {
  it("archiving a client with an issued invoice that has a balance due is refused with a clear message; nothing is archived", async () => {
    const inv = await issued();
    expect(await msg(store.archiveClient(E, C))).toMatch(/1 issued invoice with a balance due/);
    expect(fake.client.rows.find((r) => r.id === C)!.archivedAt).toBeNull();
    // a partial payment still leaves a balance
    await rec(pay(inv, { amount: "40.00", allocations: [{ invoiceId: inv, amount: "40.00" }] }));
    expect(await msg(store.archiveClient(E, C))).toMatch(/balance due/);
    // a draft and the OTHER client's open invoice do not block
    await issued({ clientId: C2 });
    await store.saveDraft({ entityId: E, userId: USER, documentId: null, expectedUpdatedAt: null, draft: dr() });
    // fully paid: allowed
    await rec(pay(inv, { amount: "60.00", allocations: [{ invoiceId: inv, amount: "60.00" }] }));
    expect(await msg(store.archiveClient(E, C))).toBeNull();
    expect(fake.client.rows.find((r) => r.id === C)!.archivedAt).not.toBeNull();
    expect(await msg(store.archiveClient(E, C))).toMatch(/not found/); // already archived
  });

  it("a void invoice does not block archiving; plural wording for several open invoices", async () => {
    const a = await issued();
    await issued();
    expect(await msg(store.archiveClient(E, C))).toMatch(/2 issued invoices with a balance due/);
    await store.voidInvoice({ entityId: E, userId: USER, documentId: a, reason: "dup" });
    expect(await msg(store.archiveClient(E, C))).toMatch(/1 issued invoice with a balance due/);
  });

  it("an ALREADY-archived client's open invoice can still be paid (existing archived clients are not stranded); a payment with no invoice needs a live client", async () => {
    const inv = await issued();
    fake.client.rows.find((r) => r.id === C)!.archivedAt = d("2026-12-01"); // archived before the guard existed
    const p = await rec(pay(inv));
    expect(p.duplicate).toBe(false);
    expect(fake.billingAllocation.rows).toHaveLength(1);
    expect(await msg(rec(pay(null, { amount: "5.00" })))).toMatch(/client was not found/);
    // the invoice must still belong to that client
    const other = await issued({ clientId: C2 });
    expect(await msg(rec(pay(other)))).toMatch(/not found for this client/);
  });
});

describe("pending bank deposits (D-6)", () => {
  it("a pending deposit cannot be linked at record time or afterwards; a posted one can", async () => {
    const inv = await issued();
    fake.transaction.rows[0]!.pending = true;
    expect(await msg(rec(pay(inv, { depositTransactionId: DEP })))).toMatch(/still pending/);
    expect(fake.billingPayment.rows).toHaveLength(0); // the whole payment rolled back
    const p = await rec(pay(inv, { amount: "100.00" }));
    expect(await msg(store.linkDeposit({ entityId: E, userId: USER, paymentId: p.id, depositTransactionId: DEP }))).toMatch(/still pending/);
    expect(fake.billingPayment.rows[0]!.depositTransactionId).toBeNull();
    fake.transaction.rows[0]!.pending = false; // it posted
    expect(await msg(store.linkDeposit({ entityId: E, userId: USER, paymentId: p.id, depositTransactionId: DEP }))).toBeNull();
  });

  it("the deposit candidate search offers posted deposits only", async () => {
    const { loadDepositCandidates } = await import("@/lib/invoicing/payments-build");
    const { Prisma } = await import("@prisma/client");
    const row = (id: string, pending: boolean) => ({ id, entityId: E, archivedAt: null, transferPairId: null, pending, amount: new Prisma.Decimal("100.00"), postedAt: d("2026-12-01"), payeeRaw: "ACME", description: "deposit" });
    fake.transaction.rows = [row("66666666-6666-4666-8666-666666666662", false), row("66666666-6666-4666-8666-666666666663", true)];
    const got = await loadDepositCandidates(E, { amountCents: 10000, feeCents: 0, receivedOn: d("2026-12-01"), clientName: "Acme", paymentId: null });
    expect(got.map((g) => g.transactionId)).toEqual(["66666666-6666-4666-8666-666666666662"]);
  });
});
