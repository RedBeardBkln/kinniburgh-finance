// Tester round 3 (ek-consulting-invoicing): deposits on account (no credit memos). A seeded random sequence of issue / record payment (partial,
// exact, over, none) / apply deposit later / remove application / void payment / void invoice runs through the REAL owner actions on the fake
// db, against an independent oracle (plain integer model written here). After every step: accept/refuse agrees with the oracle, the loaders'
// invoice balances and unapplied deposits equal the oracle, the derived ledger balances, A/R in the ledger = sum of open invoice balances,
// Unearned = sum of unapplied deposits, cash+fees = recorded payments, revenue = issued invoices, and the cash-basis view totals agree.
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
import * as invoices from "@/actions/invoices";
import * as clients from "@/actions/clients";
import * as pay from "@/actions/billing-payments";
import { loadInvoiceRows } from "@/lib/invoicing/documents-build";
import { loadClientPayments } from "@/lib/invoicing/payments-build";
import { todayNY } from "@/lib/invoicing/action-kit";
import { ACCOUNT_AR, ACCOUNT_CASH, ACCOUNT_FEES, ACCOUNT_UNEARNED, balancesByAccount, deriveLedger, glAccount, isBalanced, type LedgerDoc, type LedgerPayment } from "@/lib/invoicing/ledger";
import { cashReceipts, summarizeCash } from "@/lib/invoicing/cash-basis";
import { Prisma } from "@prisma/client";

const fake = db as unknown as FakeDb;
const authMock = vi.mocked(auth) as unknown as { mockResolvedValue: (v: unknown) => void };
const E = "11111111-1111-4111-8111-111111111111";
const ERIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const GL = "33333333-3333-4333-8333-333333333333";
const SLUG = "ek-consulting";
let ks = 0;
const key = () => `55555555-5555-4555-8555-${String(++ks).padStart(12, "0")}`;
const money = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seed() {
  process.env.ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
  fake.entity.rows = [{ id: E, name: "Eric Kinniburgh Consulting, LLC", slug: SLUG, dbaName: null, archivedAt: null }];
  fake.user.rows = [{ id: ERIC, name: "Eric Kinniburgh" }];
  fake.invoicingProfile.rows = [
    {
      id: "p1", entityId: E, enabled: true, goLiveOn: new Date("2026-10-01T00:00:00Z"), invoicePrefix: "", nextInvoiceNumber: 3100, numberPad: 0, defaultNetDays: 0,
      termsLabel: "Due upon receipt", quotePrefix: "Q-", nextQuoteNumber: 2001, businessAddress: "1 Test Road", showEinOnInvoice: false, includeRemitToByDefault: false, remitToUpdatedAt: null,
      glMap: { ar: "a", unearned: "b", discounts: "c", billableIncome: GL, processingFees: "e" },
    },
  ];
  fake.glCode.rows = [{ id: GL, entityId: E, archivedAt: null, type: "revenue" }];
  for (const t of [fake.client, fake.clientContact, fake.billingDocument, fake.billingLine, fake.billingPayment, fake.billingAllocation, fake.billingEvent, fake.auditLog, fake.transaction, fake.document, fake.reimbursableItem]) t.rows = [];
  authMock.mockResolvedValue({ user: { id: ERIC, name: "Eric Kinniburgh" } });
}
let shimmed = false;
beforeEach(() => {
  seed();
  // The shared fake db does not model the nested invoice / depositTransaction selects of the payment loader: add them here (test-only shim).
  if (!shimmed) {
    shimmed = true;
    const orig = fake.billingPayment.findMany.bind(fake.billingPayment);
    fake.billingPayment.findMany = (async (args: never) => {
      const rows = await orig(args);
      return rows.map((r) => ({
        ...r,
        depositTransaction: null,
        allocations: (r.allocations as Record<string, unknown>[]).map((a) => ({ ...a, invoice: { displayNumber: (fake.billingDocument.rows.find((d) => d.id === a.invoiceId)?.displayNumber as string | null) ?? null } })),
      }));
    }) as never;
  }
});

interface OInv { id: string; client: string; total: number; status: "issued" | "void"; revenue: number }
interface OPay { id: string; client: string; amt: number; fee: number; status: "recorded" | "void"; recv: string }
interface OAl { id: string; inv: string; pay: string; amt: number; active: boolean }

async function runScenario(seedNo: number, steps: number, allowReapply = true) {
  const tainted = new Set<string>(); // payments that had an application removed (see the open ledger defect pinned below)
  const r = rng(seedNo);
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)]!;
  const today = todayNY();
  const todayIso = today.toISOString().slice(0, 10);
  const cl: string[] = [];
  for (const n of ["A", "B"]) {
    const c = await clients.createClient({ slug: SLUG, name: `Client ${n} ${seedNo}` });
    if (!("id" in c)) throw new Error("client");
    cl.push(c.id);
  }
  const invs: OInv[] = [];
  const pays: OPay[] = [];
  const als: OAl[] = [];
  const openOf = (i: OInv) => i.total - als.filter((a) => a.active && a.inv === i.id).reduce((s, a) => s + a.amt, 0);
  const remOf = (p: OPay) => p.amt - als.filter((a) => a.active && a.pay === p.id).reduce((s, a) => s + a.amt, 0);

  const check = async (label: string) => {
    // loaders vs oracle
    const rows = await loadInvoiceRows(E, today);
    for (const i of invs) {
      const row = rows.find((x) => x.id === i.id)!;
      expect(row.balanceCents, `${label}: balance of ${i.id}`).toBe(i.status === "issued" ? openOf(i) : 0);
    }
    let depositsLoader = 0;
    for (const c of cl) for (const p of await loadClientPayments(E, c)) {
      const o = pays.find((x) => x.id === p.id)!;
      expect(p.unappliedDepositCents, `${label}: deposit of ${p.id}`).toBe(o.status === "recorded" ? remOf(o) : 0);
      depositsLoader += p.unappliedDepositCents;
    }
    // ledger from raw rows
    const docs: LedgerDoc[] = fake.billingDocument.rows
      .filter((d) => d.kind === "invoice" && d.status !== "draft")
      .map((d) => ({
        id: d.id as string, kind: "invoice" as const, status: d.status as string, issueDate: d.issueDate as Date, voidedAt: (d.voidedAt as Date | null) ?? null,
        totalCents: d.totalCents as number, discountCents: d.discountCents as number,
        lines: fake.billingLine.rows.filter((l) => l.documentId === d.id).map((l) => ({ glCodeId: l.glCodeId as string | null, lineTotalCents: l.lineTotalCents as number })),
      }));
    const payments: LedgerPayment[] = fake.billingPayment.rows.map((p) => ({
      id: p.id as string, receivedOn: p.receivedOn as Date, amountCents: p.amountCents as number, feeCents: (p.feeCents as number) ?? 0, status: p.status as string,
      voidedAt: (p.voidedAt as Date | null) ?? null,
      allocations: fake.billingAllocation.rows.filter((a) => a.paymentId === p.id).map((a) => ({ appliedOn: a.appliedOn as Date, amountCents: a.amountCents as number, voidedAt: (a.voidedAt as Date | null) ?? null })),
    }));
    const entries = deriveLedger(docs, payments);
    expect(isBalanced(entries), `${label}: ledger balanced`).toBe(true);
    const bal = balancesByAccount(entries, new Date(Date.UTC(2100, 0, 1)));
    const arOracle = invs.filter((i) => i.status === "issued").reduce((s, i) => s + openOf(i), 0);
    expect(bal.get(ACCOUNT_AR) ?? 0, `${label}: ledger A/R = sum open balances`).toBe(arOracle);
    expect((0 - (bal.get(ACCOUNT_UNEARNED) ?? 0)), `${label}: Unearned = unapplied deposits`).toBe(pays.filter((p) => p.status === "recorded").reduce((s, p) => s + remOf(p), 0));
    expect((0 - (bal.get(ACCOUNT_UNEARNED) ?? 0))).toBe(depositsLoader);
    const rec = pays.filter((p) => p.status === "recorded");
    expect(bal.get(ACCOUNT_CASH) ?? 0, `${label}: cash`).toBe(rec.reduce((s, p) => s + p.amt - p.fee, 0));
    expect(bal.get(ACCOUNT_FEES) ?? 0, `${label}: fees`).toBe(rec.reduce((s, p) => s + p.fee, 0));
    expect((0 - (bal.get(glAccount(GL)) ?? 0)), `${label}: revenue`).toBe(invs.filter((i) => i.status === "issued").reduce((s, i) => s + i.revenue, 0));
    // cash view: gross receipts of recorded payments
    const cash = summarizeCash(
      cashReceipts(
        fake.billingPayment.rows.map((p) => ({ id: p.id as string, clientId: p.clientId as string, receivedOn: p.receivedOn as Date, amountCents: p.amountCents as number, feeCents: (p.feeCents as number) ?? 0, status: p.status as string, depositPostedAt: null, depositArchived: false })),
        new Date(Date.UTC(2000, 0, 1)),
        new Date(Date.UTC(2100, 0, 1))
      )
    );
    expect(cash.grossCents, `${label}: cash view gross`).toBe(rec.reduce((s, p) => s + p.amt, 0));
    expect(cash.feeCents).toBe(rec.reduce((s, p) => s + p.fee, 0));
    expect(cash.grossCents - cash.feeCents, `${label}: cash view net = ledger cash`).toBe(bal.get(ACCOUNT_CASH) ?? 0);
    // no allocation ever exceeds anything (database-level invariants)
    for (const i of invs) expect(openOf(i), `${label}: invoice ${i.id} over-applied`).toBeGreaterThanOrEqual(0);
    for (const p of pays) expect(remOf(p), `${label}: payment ${p.id} over-applied`).toBeGreaterThanOrEqual(0);
  };

  for (let s = 0; s < steps; s++) {
    const op = r();
    const label = `seed ${seedNo} step ${s}`;
    if (op < 0.25 || invs.length === 0) {
      const c = pick(cl);
      const cents = 100 + Math.floor(r() * 90000);
      const d = await invoices.saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c, lines: [{ description: "Work", quantity: "1", unitPrice: money(cents), glCodeId: GL }] } });
      if (!("id" in d)) throw new Error("draft " + JSON.stringify(d));
      const iss = await invoices.issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt });
      expect(iss, label).toHaveProperty("displayNumber");
      invs.push({ id: d.id, client: c, total: cents, status: "issued", revenue: cents });
    } else if (op < 0.55) {
      // record a payment: random subset of this client's invoices (including void ones and over-balance amounts)
      const c = pick(cl);
      const amt = 100 + Math.floor(r() * 100000);
      const fee = r() < 0.3 ? Math.floor(r() * (amt - 1)) : 0;
      const cand = invs.filter((i) => i.client === c);
      const chosen = cand.filter(() => r() < 0.6).slice(0, 3);
      const allocs = chosen.map((i) => ({ i, a: r() < 0.7 ? Math.min(openOf(i), 1 + Math.floor(r() * 50000)) : 1 + Math.floor(r() * 70000) }));
      const recv = r() < 0.5 ? todayIso : "2026-10-02";
      const sum = allocs.reduce((s2, x) => s2 + x.a, 0);
      const feeOk = fee < amt;
      const accept = feeOk && sum <= amt && allocs.every((x) => x.i.status === "issued" && x.a >= 1 && x.a <= openOf(x.i));
      const res = await pay.recordPayment({ slug: SLUG, clientId: c, method: "check", receivedOn: recv, amount: money(amt), fee: fee ? money(fee) : "", requestKey: key(), allocations: allocs.map((x) => ({ invoiceId: x.i.id, amount: money(x.a) })) });
      if (accept) {
        expect(res, label + " record should succeed").toHaveProperty("success", true);
        const id = (res as { id: string }).id;
        pays.push({ id, client: c, amt, fee, status: "recorded", recv });
        for (const x of allocs) {
          const row = fake.billingAllocation.rows.find((a) => a.paymentId === id && a.invoiceId === x.i.id)!;
          als.push({ id: row.id as string, inv: x.i.id, pay: id, amt: x.a, active: true });
        }
      } else {
        expect(res, label + " record should be refused").toHaveProperty("error");
      }
    } else if (op < 0.75 && pays.length) {
      const p = pick(pays);
      if (!allowReapply && tainted.has(p.id)) { await check(label); continue; }
      const i = pick(invs);
      const a = r() < 0.5 ? Math.max(1, Math.min(remOf(p), openOf(i))) : 1 + Math.floor(r() * 60000);
      const accept = p.status === "recorded" && i.status === "issued" && i.client === p.client && a >= 1 && a <= openOf(i) && a <= remOf(p);
      const res = await pay.applyPaymentToInvoice({ slug: SLUG, paymentId: p.id, invoiceId: i.id, amount: money(a) });
      if (accept) {
        expect(res, label + " apply should succeed").toEqual({ success: true });
        const row = fake.billingAllocation.rows.filter((x) => x.paymentId === p.id && x.invoiceId === i.id).at(-1)!;
        als.push({ id: row.id as string, inv: i.id, pay: p.id, amt: a, active: true });
      } else expect(res, label + " apply should be refused").toHaveProperty("error");
    } else if (op < 0.85 && als.length) {
      const a = pick(als);
      const res = await pay.removeApplication({ slug: SLUG, allocationId: a.id });
      if (a.active) {
        expect(res, label).toEqual({ success: true });
        a.active = false;
        tainted.add(a.pay);
      } else expect(res, label + " double remove").toHaveProperty("error");
    } else if (op < 0.93 && pays.length) {
      const p = pick(pays);
      const accept = p.status === "recorded" && !als.some((a) => a.active && a.pay === p.id);
      const res = await pay.voidPayment({ slug: SLUG, paymentId: p.id, reason: "test" });
      if (accept) {
        expect(res, label).toEqual({ success: true });
        p.status = "void";
      } else expect(res, label + " void payment should be refused").toHaveProperty("error");
    } else if (invs.length) {
      const i = pick(invs);
      const accept = i.status === "issued" && !als.some((a) => a.active && a.inv === i.id);
      const res = await invoices.voidInvoice({ slug: SLUG, documentId: i.id, reason: "test" });
      if (accept) {
        expect(res, label).toEqual({ success: true });
        i.status = "void";
      } else expect(res, label + " void invoice should be refused").toHaveProperty("error");
    }
    await check(label);
  }
}

describe("deposits on account: owner actions vs independent oracle", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])("seed %i: 80-step random sequence (re-apply after a removal is in the generator permanently; D-13 fixed)", async (n) => {
    await runScenario(n * 7919, 80);
  }, 60_000);

  // D-13 (round 3, Medium, latent: nothing renders the derived ledger until task 1.12), FIXED in ledger.ts. deriveLedger counts a VOIDED allocation in the
  // "applied on or before the receipt day" sum, so when the same payment is re-applied the same day it was received (the natural way to fix
  // "applied to the wrong invoice": remove the application, apply again) the sum exceeds the payment, `rest` goes negative, and the
  // negative Unearned credit is dropped: debits != credits and Unearned is overstated by the re-applied amount.
  it("D-13 (fixed): record a payment fully applied, remove the application, apply the same amount again (same day): the ledger must still balance and Unearned must be 0", async () => {
    const c = (await clients.createClient({ slug: SLUG, name: "Fix Co" })) as { id: string };
    const d = (await invoices.saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c.id, lines: [{ description: "w", quantity: "1", unitPrice: "100.00", glCodeId: GL }] } })) as { id: string; updatedAt: string };
    await invoices.issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt });
    const recv = todayNY().toISOString().slice(0, 10);
    const p = (await pay.recordPayment({ slug: SLUG, clientId: c.id, method: "check", receivedOn: recv, amount: "100.00", requestKey: key(), allocations: [{ invoiceId: d.id, amount: "100.00" }] })) as { id: string };
    const al = fake.billingAllocation.rows[0]!.id as string;
    expect(await pay.removeApplication({ slug: SLUG, allocationId: al })).toEqual({ success: true });
    expect(await pay.applyPaymentToInvoice({ slug: SLUG, paymentId: p.id, invoiceId: d.id, amount: "100.00" })).toEqual({ success: true });
    // the stored data is right (one active application of 100.00, nothing unapplied)
    expect((await loadClientPayments(E, c.id))[0]!.unappliedDepositCents).toBe(0);
    // the derived ledger is not
    const pm = fake.billingPayment.rows[0]!;
    const ledger = deriveLedger(
      [{ id: d.id, kind: "invoice", status: "issued", issueDate: fake.billingDocument.rows[0]!.issueDate as Date, voidedAt: null, totalCents: 10000, discountCents: 0, lines: [{ glCodeId: GL, lineTotalCents: 10000 }] }],
      [{ id: p.id, receivedOn: pm.receivedOn as Date, amountCents: 10000, feeCents: 0, status: "recorded", voidedAt: null, allocations: fake.billingAllocation.rows.map((a) => ({ appliedOn: a.appliedOn as Date, amountCents: a.amountCents as number, voidedAt: (a.voidedAt as Date | null) ?? null })) }]
    );
    expect(isBalanced(ledger)).toBe(true);
    expect(0 - (balancesByAccount(ledger).get(ACCOUNT_UNEARNED) ?? 0)).toBe(0);
  });

  it("archived client with an open invoice: the deposit search works (D-12a), a payment applying to the invoice is accepted, a payment applying to nothing is refused; a pending deposit is never offered", async () => {
    const c = (await clients.createClient({ slug: SLUG, name: "Old Co" })) as { id: string };
    const d = (await invoices.saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c.id, lines: [{ description: "w", quantity: "1", unitPrice: "100.00", glCodeId: GL }] } })) as { id: string; updatedAt: string };
    await invoices.issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt });
    fake.client.rows[0]!.archivedAt = new Date(); // archived (e.g. before the guard existed)
    fake.transaction.rows = [
      { id: "66666666-6666-4666-8666-666666666661", entityId: E, archivedAt: null, transferPairId: null, pending: false, amount: new Prisma.Decimal("100.00"), postedAt: new Date("2026-10-10T00:00:00Z"), payeeRaw: "OLD CO", description: "deposit" },
      { id: "66666666-6666-4666-8666-666666666662", entityId: E, archivedAt: null, transferPairId: null, pending: true, amount: new Prisma.Decimal("100.00"), postedAt: new Date("2026-10-10T00:00:00Z"), payeeRaw: "OLD CO", description: "deposit" },
    ];
    const res = await pay.searchDepositCandidates({ slug: SLUG, paymentId: null, clientId: c.id, amount: "100.00", receivedOn: "2026-10-10" });
    expect(res).toHaveProperty("success", true);
    const ids = (res as { candidates: { transactionId: string }[] }).candidates.map((x) => x.transactionId);
    expect(ids).toContain("66666666-6666-4666-8666-666666666661");
    expect(ids).not.toContain("66666666-6666-4666-8666-666666666662");
    expect(await pay.recordPayment({ slug: SLUG, clientId: c.id, method: "check", receivedOn: "2026-10-10", amount: "100.00", requestKey: key(), depositTransactionId: "66666666-6666-4666-8666-666666666661", allocations: [{ invoiceId: d.id, amount: "100.00" }] })).toHaveProperty("success", true);
    expect(await pay.recordPayment({ slug: SLUG, clientId: c.id, method: "check", receivedOn: "2026-10-10", amount: "5.00", requestKey: key(), allocations: [] })).toHaveProperty("error");
  });

  it("(pure) the same defect at ledger level: balanced, and no phantom Unearned balance (was a 100.00 imbalance before the D-13 fix)", () => {
    const day = new Date(Date.UTC(2026, 9, 16));
    const ledger = deriveLedger(
      [{ id: "i1", kind: "invoice", status: "issued", issueDate: day, voidedAt: null, totalCents: 10000, discountCents: 0, lines: [{ glCodeId: GL, lineTotalCents: 10000 }] }],
      [{ id: "p1", receivedOn: day, amountCents: 10000, feeCents: 0, status: "recorded", voidedAt: null, allocations: [{ appliedOn: day, amountCents: 10000, voidedAt: new Date(Date.UTC(2026, 9, 16, 15)) }, { appliedOn: day, amountCents: 10000, voidedAt: null }] }]
    );
    const t = ledger.reduce((a, e) => ({ d: a.d + e.debitCents, c: a.c + e.creditCents }), { d: 0, c: 0 });
    expect(t.c - t.d).toBe(0); // was 10000 (unbalanced by exactly the re-applied amount) before the fix
    expect(0 - (balancesByAccount(ledger).get(ACCOUNT_UNEARNED) ?? 0)).toBe(0);
  });

  it("worked example: overpayment becomes a deposit on account, applies to a later invoice in two parts, over-application is refused, then it reconciles to zero", async () => {
    const c = (await clients.createClient({ slug: SLUG, name: "Example Co" })) as { id: string };
    const mk = async (cents: number) => {
      const d = (await invoices.saveDraft({ slug: SLUG, documentId: null, expectedUpdatedAt: null, draft: { clientId: c.id, lines: [{ description: "w", quantity: "1", unitPrice: money(cents), glCodeId: GL }] } })) as { id: string; updatedAt: string };
      await invoices.issueInvoice({ slug: SLUG, documentId: d.id, expectedUpdatedAt: d.updatedAt });
      return d.id;
    };
    const a = await mk(30000);
    const b = await mk(50000);
    const p = (await pay.recordPayment({ slug: SLUG, clientId: c.id, method: "check", receivedOn: todayNY().toISOString().slice(0, 10), amount: "700.00", requestKey: key(), allocations: [{ invoiceId: a, amount: "300.00" }] })) as { id: string };
    let pv = (await loadClientPayments(E, c.id))[0]!;
    expect(pv.unappliedDepositCents).toBe(40000);
    expect(await pay.applyPaymentToInvoice({ slug: SLUG, paymentId: p.id, invoiceId: b, amount: "250.00" })).toEqual({ success: true });
    pv = (await loadClientPayments(E, c.id))[0]!;
    expect(pv.unappliedDepositCents).toBe(15000);
    expect(await pay.applyPaymentToInvoice({ slug: SLUG, paymentId: p.id, invoiceId: b, amount: "150.01" })).toHaveProperty("error"); // more than the deposit left
    expect(await pay.applyPaymentToInvoice({ slug: SLUG, paymentId: p.id, invoiceId: b, amount: "250.00" })).toHaveProperty("error"); // more than the deposit left (invoice would allow it)
    expect(await pay.applyPaymentToInvoice({ slug: SLUG, paymentId: p.id, invoiceId: b, amount: "150.00" })).toEqual({ success: true });
    expect(await pay.applyPaymentToInvoice({ slug: SLUG, paymentId: p.id, invoiceId: b, amount: "0.01" })).toHaveProperty("error"); // deposit used up
    pv = (await loadClientPayments(E, c.id))[0]!;
    expect(pv.unappliedDepositCents).toBe(0);
    const rows = await loadInvoiceRows(E, todayNY());
    expect(rows.find((x) => x.id === a)!.balanceCents).toBe(0);
    expect(rows.find((x) => x.id === b)!.balanceCents).toBe(10000);
  });
});
