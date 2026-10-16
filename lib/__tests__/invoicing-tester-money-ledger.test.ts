// Tester probes (ek-consulting-invoicing): independent BigInt oracle for rounding, the plan section 17 worked example built from scratch, and a 2000-scenario ledger-vs-A/R consistency fuzz.
import { describe, expect, it } from "vitest";
import { computeDocumentTotals, lineGrossCents, markupPriceCents, parsePercentToBps, parseQuantityMilli, percentOf } from "@/lib/invoicing/money";
import { ACCOUNT_AR, ACCOUNT_CASH, ACCOUNT_UNEARNED, balancesByAccount, deriveLedger, isBalanced, type LedgerDoc, type LedgerPayment } from "@/lib/invoicing/ledger";
import { buildAccrualPl } from "@/lib/invoicing/accrual-pl";
import { cashReceipts, summarizeCash, buildHygiene } from "@/lib/invoicing/cash-basis";
import { buildAging, invoiceBalanceAsOf } from "@/lib/invoicing/ar";
import { parseDollarsToCents } from "@/lib/money-input";

// ---- independent oracle: exact rational half-up with BigInt, written differently from the module ----
function halfUp(n: bigint, d: bigint): bigint {
  // floor((n + d/2) / d) for n >= 0, d > 0, computed via remainder compare
  const q = n / d;
  const r = n % d;
  return r * BigInt(2) >= d ? q + BigInt(1) : q;
}
function rnd(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("probe: rounding", () => {
  it("half-cent boundaries", () => {
    // 0.5 hr x $0.01 = 0.5 cent -> 1 (half-up), 0.001 x 500 cents = 0.5 -> 1, 0.001 x 499 -> 0
    expect(lineGrossCents(500, 1)).toBe(1);
    expect(lineGrossCents(1, 500)).toBe(1);
    expect(lineGrossCents(1, 499)).toBe(0);
    expect(lineGrossCents(7250, 17500)).toBe(126875);
    expect(lineGrossCents(333, 100)).toBe(33); // 33.3
    expect(lineGrossCents(335, 100)).toBe(34); // 33.5
    expect(percentOf(1005, 1000)).toBe(101); // 100.5
    expect(percentOf(1004, 1000)).toBe(100);
    expect(percentOf(5, 1050)).toBe(1); // 0.525 -> 1
    expect(percentOf(1, 4999)).toBe(0); // 0.4999
    expect(percentOf(1, 5000)).toBe(1); // 0.5
    expect(markupPriceCents(20000, 1000)).toBe(22000);
    expect(markupPriceCents(1, 5000)).toBe(2); // 1.5 -> 2
    expect(markupPriceCents(333, 1500)).toBe(383); // 382.95
  });
  it("fuzz vs BigInt oracle: lines, line discount, document discount, total never negative", () => {
    const r = rnd(7);
    for (let n = 0; n < 4000; n += 1) {
      const lines = Array.from({ length: 1 + Math.floor(r() * 6) }, () => {
        const qty = 1 + Math.floor(r() * 50_000);
        const price = Math.floor(r() * 2_000_00);
        const disc = r() < 0.4 ? (r() < 0.5 ? { kind: "percent" as const, value: 1 + Math.floor(r() * 10000) } : null) : null;
        return { quantityMilli: qty, unitPriceCents: price, discount: disc };
      });
      const docDisc = r() < 0.4 ? { kind: "percent" as const, value: 1 + Math.floor(r() * 10000) } : null;
      const got = computeDocumentTotals(lines, docDisc);
      expect(got.ok).toBe(true);
      if (!got.ok) continue;
      let sub = BigInt(0);
      lines.forEach((l, i) => {
        const gross = halfUp(BigInt(l.quantityMilli) * BigInt(l.unitPriceCents), BigInt(1000));
        const dsc = l.discount ? halfUp(gross * BigInt(l.discount.value), BigInt(10000)) : BigInt(0);
        expect(BigInt(got.totals.lines[i]!.totalCents)).toBe(gross - dsc);
        sub += gross - dsc;
      });
      const dd = docDisc ? halfUp(sub * BigInt(docDisc.value), BigInt(10000)) : BigInt(0);
      expect(BigInt(got.totals.subtotalCents)).toBe(sub);
      expect(BigInt(got.totals.discountCents)).toBe(dd);
      expect(BigInt(got.totals.totalCents)).toBe(sub - dd);
      expect(got.totals.totalCents).toBeGreaterThanOrEqual(0);
    }
  });
  it("parsers: reject sloppy input", () => {
    for (const bad of ["", "0", "0.000", "1.2345", "-1", "1e3", " ", "1,5", ".5", "1.", "abc", "１２"]) expect(parseQuantityMilli(bad)).toBeNull();
    expect(parseQuantityMilli("7.25")).toBe(7250);
    expect(parseQuantityMilli("0.001")).toBe(1);
    for (const bad of ["0", "100.01", "101", "-5", "5.555", "", "%"]) expect(parsePercentToBps(bad)).toBeNull();
    expect(parsePercentToBps("100")).toBe(10000);
    expect(parsePercentToBps("0.01")).toBe(1);
    // dollars
    for (const bad of ["", "-1", "1.234", "1e2", "$-1", "0", "1,23", "21474837"]) expect(parseDollarsToCents(bad).ok).toBe(false);
    expect(parseDollarsToCents("19.99")).toEqual({ ok: true, cents: 1999 });
    expect(parseDollarsToCents("21474836.47")).toEqual({ ok: true, cents: 2147483647 });
    expect(parseDollarsToCents("21474836.48").ok).toBe(false);
  });
  it("full discount makes total 0 (issue must refuse, not the math)", () => {
    const r = computeDocumentTotals([{ quantityMilli: 1000, unitPriceCents: 12345, discount: null }], { kind: "percent", value: 10000 });
    expect(r.ok && r.totals.totalCents).toBe(0);
  });
  it("document total above Int32 is refused", () => {
    const r = computeDocumentTotals(
      [
        { quantityMilli: 1000, unitPriceCents: 2_000_000_000, discount: null },
        { quantityMilli: 1000, unitPriceCents: 2_000_000_000, discount: null },
      ],
      null
    );
    expect(r.ok).toBe(false);
  });
});

// ---- worked example from plan section 17, built independently ----
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
describe("probe: worked example (plan 17)", () => {
  const goLive = d("2026-11-01");
  const REV = "rev-services";
  const BILL = "rev-billable";
  const docs: LedgerDoc[] = [
    { id: "A", kind: "invoice", status: "issued", issueDate: d("2026-11-05"), voidedAt: null, totalCents: 100000, discountCents: 0, lines: [{ glCodeId: REV, lineTotalCents: 100000 }] },
    { id: "B", kind: "invoice", status: "issued", issueDate: d("2026-11-10"), voidedAt: null, totalCents: 22000, discountCents: 0, lines: [{ glCodeId: BILL, lineTotalCents: 22000 }] },
  ];
  const payments: LedgerPayment[] = [
    { id: "P1", receivedOn: d("2026-12-02"), amountCents: 100000, feeCents: 0, status: "recorded", voidedAt: null, allocations: [{ appliedOn: d("2026-12-02"), amountCents: 100000, voidedAt: null }] },
    { id: "P2", receivedOn: d("2026-12-09"), amountCents: 22000, feeCents: 0, status: "recorded", voidedAt: null, allocations: [{ appliedOn: d("2026-12-09"), amountCents: 22000, voidedAt: null }] },
  ];
  const entries = deriveLedger(docs, payments);
  it("balances", () => expect(isBalanced(entries)).toBe(true));
  it("accrual: Nov $1,220 / Dec $50 other; excludes linked deposits", () => {
    const rev = [{ glCodeId: REV, code: "4000", name: "Services" }, { glCodeId: BILL, code: "4100", name: "Billable" }];
    const nov = buildAccrualPl({ from: d("2026-11-01"), to: d("2026-11-30"), goLiveOn: goLive, entries, revenueAccounts: rev, ledgerExpenseLines: [{ glCodeId: "x", code: "6000", name: "Cost", cents: 20000 }], unlinkedRevenueDeposits: [] });
    expect(nov.totalRevenueCents).toBe(122000);
    expect(nov.netCents).toBe(102000);
    const dec = buildAccrualPl({ from: d("2026-12-01"), to: d("2026-12-31"), goLiveOn: goLive, entries, revenueAccounts: rev, ledgerExpenseLines: [], unlinkedRevenueDeposits: [{ transactionId: "i", postedAt: d("2026-12-15"), amountCents: 5000 }] });
    expect(dec.invoicedRevenueCents).toBe(0);
    expect(dec.totalRevenueCents).toBe(5000);
    expect(dec.otherRevenueNotInvoicedCents).toBe(5000);
  });
  it("cash: Dec receipts 1,220 by deposit date; ledger revenue Dec = 1,270; hygiene", () => {
    const cash = cashReceipts(
      [
        { id: "P1", clientId: "c", receivedOn: d("2026-12-01"), amountCents: 100000, feeCents: 0, status: "recorded", depositPostedAt: d("2026-12-02"), depositArchived: false },
        { id: "P2", clientId: "c", receivedOn: d("2026-12-08"), amountCents: 22000, feeCents: 0, status: "recorded", depositPostedAt: d("2026-12-09"), depositArchived: false },
      ],
      d("2026-12-01"),
      d("2026-12-31")
    );
    expect(summarizeCash(cash).grossCents).toBe(122000);
    const h = buildHygiene(
      [{ paymentId: "P1", status: "recorded", receivedOn: d("2026-12-01"), amountCents: 100000, depositId: "D1", depositArchived: false, depositGlType: "revenue" }],
      [{ transactionId: "D1", postedAt: d("2026-12-02"), amountCents: 100000, linked: true }, { transactionId: "I", postedAt: d("2026-12-15"), amountCents: 5000, linked: false }]
    );
    expect(h.revenueDepositsNotLinked.map((x) => x.transactionId)).toEqual(["I"]);
  });
  it("A/R: 1,220 at 11-30; 0 at 12-31; ledger A/R agrees", () => {
    const inv = docs.map((x) => ({ id: x.id, clientId: "c", displayNumber: x.id, status: x.status, issueDate: x.issueDate, dueDate: x.issueDate, totalCents: x.totalCents, voidedAt: null }));
    const allocs = [
      { invoiceId: "A", amountCents: 100000, appliedOn: d("2026-12-02"), voidedAt: null },
      { invoiceId: "B", amountCents: 22000, appliedOn: d("2026-12-09"), voidedAt: null },
    ];
    expect(buildAging(inv, allocs, d("2026-11-30")).totals.totalCents).toBe(122000);
    expect(buildAging(inv, allocs, d("2026-12-31")).totals.totalCents).toBe(0);
    expect(balancesByAccount(entries, d("2026-11-30")).get(ACCOUNT_AR)).toBe(122000);
    expect(balancesByAccount(entries, d("2026-12-31")).get(ACCOUNT_AR) ?? 0).toBe(0);
  });
});

// ---- random scenarios: ledger always balances; ledger A/R == aging total on every date ----
describe("probe: ledger vs A/R consistency fuzz", () => {
  it("2000 random scenarios", () => {
    const r = rnd(99);
    const base = d("2026-10-01").getTime();
    const day = (n: number) => new Date(base + n * 86_400_000);
    for (let s = 0; s < 2000; s += 1) {
      const nInv = 1 + Math.floor(r() * 4);
      const docs: LedgerDoc[] = [];
      for (let i = 0; i < nInv; i += 1) {
        const total = 1000 + Math.floor(r() * 500000);
        const disc = r() < 0.3 ? Math.floor(total * 0.1) : 0;
        const sub = total + disc;
        docs.push({ id: `I${i}`, kind: "invoice", status: "issued", issueDate: day(Math.floor(r() * 30)), voidedAt: null, totalCents: total, discountCents: disc, lines: [{ glCodeId: "rev", lineTotalCents: sub }] });
      }
      const payments: LedgerPayment[] = [];
      const allocRecs: { invoiceId: string; amountCents: number; appliedOn: Date; voidedAt: Date | null }[] = [];
      const open = new Map(docs.map((x) => [x.id, x.totalCents]));
      const nPay = Math.floor(r() * 5);
      for (let p = 0; p < nPay; p += 1) {
        const amount = 100 + Math.floor(r() * 300000);
        const fee = r() < 0.3 ? Math.floor(amount * 0.03) : 0;
        const receivedOn = day(Math.floor(r() * 60));
        let left = amount;
        const pallocs: LedgerPayment["allocations"] = [];
        for (const inv of docs) {
          if (r() < 0.5) continue;
          const room = open.get(inv.id)!;
          const amt = Math.min(room, left, 1 + Math.floor(r() * room));
          if (amt <= 0) continue;
          open.set(inv.id, room - amt);
          left -= amt;
          const appliedOn = new Date(Math.max(receivedOn.getTime(), inv.issueDate!.getTime(), r() < 0.3 ? day(Math.floor(r() * 90)).getTime() : 0));
          const voidedAt = r() < 0.2 ? new Date(appliedOn.getTime() + (1 + Math.floor(r() * 10)) * 86_400_000) : null;

          pallocs.push({ appliedOn, amountCents: amt, voidedAt });
          allocRecs.push({ invoiceId: inv.id, amountCents: amt, appliedOn, voidedAt });
        }
        const allVoided = pallocs.every((a) => a.voidedAt) && r() < 0.4;
        const payVoidedAt = allVoided ? new Date(Math.max(receivedOn.getTime(), ...pallocs.map((a) => a.voidedAt!.getTime())) + 86_400_000) : null;
        payments.push({ id: `P${p}`, receivedOn, amountCents: amount, feeCents: fee, status: payVoidedAt ? "void" : "recorded", voidedAt: payVoidedAt, allocations: pallocs });
      }
      const entries = deriveLedger(docs, payments);
      expect(isBalanced(entries)).toBe(true);
      const inv = docs.map((x) => ({ id: x.id, clientId: "c", displayNumber: x.id, status: x.status, issueDate: x.issueDate, dueDate: x.issueDate, totalCents: x.totalCents, voidedAt: null }));
      for (let t = 0; t < 140; t += 7) {
        const asOf = day(t);
        const sumBal = inv.reduce((a, i) => a + invoiceBalanceAsOf(i, allocRecs, asOf), 0);
        const ledgerAr = balancesByAccount(entries, asOf).get(ACCOUNT_AR) ?? 0;
        if (sumBal !== ledgerAr) throw new Error(`scenario ${s} day ${t}: aging ${sumBal} != ledger AR ${ledgerAr}`);
      }
      // unearned never negative at the end; cash = sum of net of non-void payments
      const bal = balancesByAccount(entries);
      expect(bal.get(ACCOUNT_UNEARNED) ?? 0).toBeLessThanOrEqual(0 + 0); // credit balance (negative net debit) or zero
      const cashExpected = payments.filter((p) => p.status === "recorded").reduce((a, p) => a + p.amountCents - p.feeCents, 0);
      expect(bal.get(ACCOUNT_CASH) ?? 0).toBe(cashExpected);
    }
  });
});
