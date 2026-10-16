import { describe, expect, it } from "vitest";
import {
  ACCOUNT_AR,
  ACCOUNT_CASH,
  ACCOUNT_DISCOUNTS,
  ACCOUNT_FEES,
  ACCOUNT_UNEARNED,
  balancesByAccount,
  deriveLedger,
  glAccount,
  isBalanced,
  type LedgerDoc,
  type LedgerPayment,
} from "@/lib/invoicing/ledger";
import { buildAccrualPl } from "@/lib/invoicing/accrual-pl";
import { buildHygiene, cashReceipts, reconcileToLedger, summarizeCash, type CashPayment } from "@/lib/invoicing/cash-basis";
import { computeDocumentTotals } from "@/lib/invoicing/money";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const SVC = "gl-services";
const BILL = "gl-billable";

function invoice(id: string, issue: string, lines: { gl: string; q: number; p: number; disc?: { kind: "percent" | "fixed"; value: number } }[], docDiscount?: { kind: "percent" | "fixed"; value: number }, extra: Partial<LedgerDoc> = {}): LedgerDoc {
  const t = computeDocumentTotals(lines.map((l) => ({ quantityMilli: l.q, unitPriceCents: l.p, discount: l.disc })), docDiscount);
  if (!t.ok) throw new Error(t.error);
  return {
    id,
    kind: "invoice",
    status: "issued",
    issueDate: d(issue),
    voidedAt: null,
    totalCents: t.totals.totalCents,
    discountCents: t.totals.discountCents,
    lines: lines.map((l, i) => ({ glCodeId: l.gl, lineTotalCents: t.totals.lines[i]!.totalCents })),
    ...extra,
  };
}

const pay = (id: string, on: string, amount: number, fee: number, allocs: { on: string; cents: number; voidedAt?: string }[], extra: Partial<LedgerPayment> = {}): LedgerPayment => ({
  id,
  receivedOn: d(on),
  amountCents: amount,
  feeCents: fee,
  status: "recorded",
  voidedAt: null,
  allocations: allocs.map((a) => ({ appliedOn: d(a.on), amountCents: a.cents, voidedAt: a.voidedAt ? d(a.voidedAt) : null })),
  ...extra,
});

describe("derived ledger: every scenario balances (debits == credits)", () => {
  it("issue", () => {
    const entries = deriveLedger([invoice("I1", "2026-11-05", [{ gl: SVC, q: 1000, p: 100000 }])], []);
    expect(isBalanced(entries)).toBe(true);
    const b = balancesByAccount(entries);
    expect(b.get(ACCOUNT_AR)).toBe(100000);
    expect(b.get(glAccount(SVC))).toBe(-100000);
  });
  it("issue with line and invoice discounts: A/R is the total, discounts post to the contra account", () => {
    const entries = deriveLedger([invoice("I1", "2026-11-05", [{ gl: SVC, q: 2000, p: 50000, disc: { kind: "percent", value: 1000 } }], { kind: "fixed", value: 5000 })], []);
    expect(isBalanced(entries)).toBe(true);
    const b = balancesByAccount(entries);
    expect(b.get(ACCOUNT_AR)).toBe(85000); // 100000 - 10000 - 5000
    expect(b.get(ACCOUNT_DISCOUNTS)).toBe(5000);
    expect(b.get(glAccount(SVC))).toBe(-90000);
  });
  it("partial payment, with a fee", () => {
    const entries = deriveLedger([invoice("I1", "2026-11-05", [{ gl: SVC, q: 1000, p: 100000 }])], [pay("P1", "2026-11-20", 40000, 1200, [{ on: "2026-11-20", cents: 40000 }])]);
    expect(isBalanced(entries)).toBe(true);
    const b = balancesByAccount(entries);
    expect(b.get(ACCOUNT_AR)).toBe(60000);
    expect(b.get(ACCOUNT_FEES)).toBe(1200);
    expect(b.get(ACCOUNT_CASH)).toBe(38800);
    expect(b.get(ACCOUNT_UNEARNED) ?? 0).toBe(0);
  });
  it("overpayment: the excess sits in unearned (client credit)", () => {
    const entries = deriveLedger([invoice("I1", "2026-11-05", [{ gl: SVC, q: 1000, p: 100000 }])], [pay("P1", "2026-11-20", 120000, 0, [{ on: "2026-11-20", cents: 100000 }])]);
    expect(isBalanced(entries)).toBe(true);
    const b = balancesByAccount(entries);
    expect(b.get(ACCOUNT_AR) ?? 0).toBe(0);
    expect(b.get(ACCOUNT_UNEARNED)).toBe(-20000);
  });
  it("prepaid then applied: unearned until the allocation date, then A/R", () => {
    const payments = [pay("P1", "2026-11-01", 50000, 0, [{ on: "2026-12-05", cents: 50000 }])];
    const docs = [invoice("I1", "2026-12-05", [{ gl: SVC, q: 1000, p: 50000 }])];
    const entries = deriveLedger(docs, payments);
    expect(isBalanced(entries)).toBe(true);
    expect(balancesByAccount(entries, d("2026-11-30")).get(ACCOUNT_UNEARNED)).toBe(-50000);
    const dec = balancesByAccount(entries, d("2026-12-31"));
    expect(dec.get(ACCOUNT_UNEARNED) ?? 0).toBe(0);
    expect(dec.get(ACCOUNT_AR) ?? 0).toBe(0);
  });
  it("a deposit on account (unapplied payment) is a liability until it is applied, split across two invoices", () => {
    // There are no credit memos: a customer credit is a deposit held as Unearned and applied to open invoices later.
    const payments = [pay("P1", "2026-11-01", 50000, 0, [{ on: "2026-12-05", cents: 30000 }, { on: "2026-12-20", cents: 20000 }])];
    const docs = [invoice("I1", "2026-12-05", [{ gl: SVC, q: 1000, p: 30000 }]), invoice("I2", "2026-12-20", [{ gl: SVC, q: 1000, p: 20000 }])];
    const entries = deriveLedger(docs, payments);
    expect(isBalanced(entries)).toBe(true);
    expect(balancesByAccount(entries, d("2026-11-30")).get(ACCOUNT_UNEARNED)).toBe(-50000);
    expect(balancesByAccount(entries, d("2026-12-10")).get(ACCOUNT_UNEARNED)).toBe(-20000);
    expect(balancesByAccount(entries, d("2026-12-31")).get(ACCOUNT_UNEARNED) ?? 0).toBe(0);
    expect(balancesByAccount(entries, d("2026-12-31")).get(ACCOUNT_AR) ?? 0).toBe(0);
    expect(balancesByAccount(entries, d("2026-12-31")).get(glAccount(SVC))).toBe(-50000);
  });
  it("reimbursable with markup: billed price to the billable-income GL", () => {
    const entries = deriveLedger([invoice("I1", "2026-11-10", [{ gl: BILL, q: 1000, p: 22000 }])], []);
    expect(isBalanced(entries)).toBe(true);
    expect(balancesByAccount(entries).get(glAccount(BILL))).toBe(-22000);
  });
  it("void invoice after its payment was voided: reversals are dated at the void dates", () => {
    const docs = [invoice("I1", "2026-11-05", [{ gl: SVC, q: 1000, p: 100000 }], undefined, { status: "void", voidedAt: d("2026-12-20") })];
    const payments = [pay("P1", "2026-11-20", 100000, 0, [{ on: "2026-11-20", cents: 100000, voidedAt: "2026-12-10" }], { status: "void", voidedAt: d("2026-12-15") })];
    const entries = deriveLedger(docs, payments);
    expect(isBalanced(entries)).toBe(true);
    // Revenue stays in its issue month and is reversed in the void month.
    expect(balancesByAccount(entries, d("2026-11-30")).get(glAccount(SVC))).toBe(-100000);
    expect(balancesByAccount(entries, d("2026-12-19")).get(glAccount(SVC))).toBe(-100000);
    expect(balancesByAccount(entries, d("2026-12-20")).get(glAccount(SVC)) ?? 0).toBe(0);
    // Everything nets to zero at the end.
    for (const v of balancesByAccount(entries).values()) expect(v).toBe(0);
  });
  it("drafts produce no entries", () => {
    expect(deriveLedger([invoice("I1", "2026-11-05", [{ gl: SVC, q: 1000, p: 100 }], undefined, { status: "draft", issueDate: null })], [])).toEqual([]);
  });
});

describe("worked example (plan section 17): no double counting between the ledger and the invoices", () => {
  // go-live 2026-11-01. A $1,000.00 issued 11-05. B $220.00 (a $200.00 reimbursable at cost + 10%) issued 11-10; the $200.00 cost
  // expense is already in the ledger. A is paid by a $1,000.00 deposit on 12-02 (linked), B by a $220.00 deposit on 12-09 (linked).
  // An unrelated $50.00 interest deposit is coded revenue and not linked.
  const goLive = d("2026-11-01");
  const docs = [
    invoice("A", "2026-11-05", [{ gl: SVC, q: 1000, p: 100000 }]),
    invoice("B", "2026-11-10", [{ gl: BILL, q: 1000, p: 22000 }]),
  ];
  const payments = [
    pay("PA", "2026-12-02", 100000, 0, [{ on: "2026-12-02", cents: 100000 }]),
    pay("PB", "2026-12-09", 22000, 0, [{ on: "2026-12-09", cents: 22000 }]),
  ];
  const entries = deriveLedger(docs, payments);
  const revenueAccounts = [{ glCodeId: SVC, code: "4000", name: "Services" }, { glCodeId: BILL, code: "4100", name: "Billable Expense Income" }];
  const expense = [{ glCodeId: "gl-supplies", code: "6100", name: "Supplies", cents: 20000 }];
  const interest = [{ transactionId: "T-int", postedAt: d("2026-12-15"), amountCents: 5000 }];

  it("is balanced", () => expect(isBalanced(entries)).toBe(true));

  it("accrual revenue November = $1,220.00 and nothing from deposits", () => {
    const nov = buildAccrualPl({ from: d("2026-11-01"), to: d("2026-11-30"), goLiveOn: goLive, entries, revenueAccounts, ledgerExpenseLines: expense, unlinkedRevenueDeposits: interest });
    expect(nov.invoicedRevenueCents).toBe(122000);
    expect(nov.otherRevenueNotInvoicedCents).toBe(0);
    expect(nov.totalRevenueCents).toBe(122000);
    expect(nov.netCents).toBe(122000 - 20000);
  });
  it("accrual revenue December = $50.00 (other revenue only)", () => {
    const dec = buildAccrualPl({ from: d("2026-12-01"), to: d("2026-12-31"), goLiveOn: goLive, entries, revenueAccounts, ledgerExpenseLines: [], unlinkedRevenueDeposits: interest });
    expect(dec.invoicedRevenueCents).toBe(0);
    expect(dec.otherRevenueNotInvoicedCents).toBe(5000);
    expect(dec.totalRevenueCents).toBe(5000);
  });
  it("the ledger view for December still shows $1,270.00 (linked deposits keep their revenue GL there) and cash receipts are $1,220.00", () => {
    const ledgerDecRevenue = 100000 + 22000 + 5000; // the three revenue-coded deposits, unchanged by this build
    expect(ledgerDecRevenue).toBe(127000);
    const cashPayments: CashPayment[] = [
      { id: "PA", clientId: "c", receivedOn: d("2026-12-02"), amountCents: 100000, feeCents: 0, status: "recorded", depositPostedAt: d("2026-12-02"), depositArchived: false },
      { id: "PB", clientId: "c", receivedOn: d("2026-12-09"), amountCents: 22000, feeCents: 0, status: "recorded", depositPostedAt: d("2026-12-09"), depositArchived: false },
    ];
    const receipts = cashReceipts(cashPayments, d("2026-12-01"), d("2026-12-31"));
    const s = summarizeCash(receipts);
    expect(s.grossCents).toBe(122000);
    const rec = reconcileToLedger(s.grossCents, ledgerDecRevenue);
    expect(rec.differenceCents).toBe(5000); // the unlinked interest deposit, listed by the hygiene panel
    expect(rec.matches).toBe(false);
  });
  it("A/R at 2026-11-30 = $1,220.00 and at 2026-12-31 = $0.00", () => {
    expect(balancesByAccount(entries, d("2026-11-30")).get(ACCOUNT_AR)).toBe(122000);
    expect(balancesByAccount(entries, d("2026-12-31")).get(ACCOUNT_AR) ?? 0).toBe(0);
  });
  it("a range before go-live has no accrual view; a range straddling go-live is clamped and flagged", () => {
    const before = buildAccrualPl({ from: d("2026-09-01"), to: d("2026-09-30"), goLiveOn: goLive, entries, revenueAccounts, ledgerExpenseLines: [], unlinkedRevenueDeposits: interest });
    expect(before.entirelyBeforeGoLive).toBe(true);
    expect(before.totalRevenueCents).toBe(0);
    const straddle = buildAccrualPl({ from: d("2026-10-01"), to: d("2026-11-30"), goLiveOn: goLive, entries, revenueAccounts, ledgerExpenseLines: [], unlinkedRevenueDeposits: [] });
    expect(straddle.partlyBeforeGoLive).toBe(true);
    expect(straddle.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(straddle.totalRevenueCents).toBe(122000);
  });
  it("discounts and fees flow through the accrual P&L", () => {
    const e = deriveLedger(
      [invoice("I1", "2026-11-05", [{ gl: SVC, q: 1000, p: 100000 }], { kind: "fixed", value: 10000 })],
      [pay("P1", "2026-11-20", 90000, 2000, [{ on: "2026-11-20", cents: 90000 }])]
    );
    const pl = buildAccrualPl({ from: d("2026-11-01"), to: d("2026-11-30"), goLiveOn: goLive, entries: e, revenueAccounts, ledgerExpenseLines: [], unlinkedRevenueDeposits: [] });
    expect(pl.invoicedRevenueCents).toBe(100000);
    expect(pl.discountsCents).toBe(10000);
    expect(pl.totalRevenueCents).toBe(90000);
    expect(pl.processingFeesCents).toBe(2000);
    expect(pl.netCents).toBe(88000);
  });
});

describe("cash-basis view", () => {
  const base: CashPayment = { id: "P", clientId: "c1", receivedOn: d("2026-12-01"), amountCents: 10000, feeCents: 300, status: "recorded", depositPostedAt: null, depositArchived: false };
  it("uses the deposit date when linked, else the received date flagged 'no bank deposit linked'", () => {
    const r = cashReceipts([{ ...base, depositPostedAt: d("2026-12-05") }, { ...base, id: "Q" }], d("2026-12-01"), d("2026-12-31"));
    expect(r.map((x) => [x.paymentId, x.date.toISOString().slice(0, 10), x.noDepositLinked])).toEqual([["Q", "2026-12-01", true], ["P", "2026-12-05", false]]);
  });
  it("a payment whose deposit is in another month moves to that month; void payments are excluded", () => {
    const r = cashReceipts([{ ...base, receivedOn: d("2026-12-30"), depositPostedAt: d("2027-01-03") }, { ...base, id: "V", status: "void" }], d("2026-12-01"), d("2026-12-31"));
    expect(r).toHaveLength(0);
    const jan = cashReceipts([{ ...base, receivedOn: d("2026-12-30"), depositPostedAt: d("2027-01-03") }], d("2027-01-01"), d("2027-01-31"));
    expect(jan).toHaveLength(1);
    expect(jan[0]!.month).toBe("2027-01");
  });
  it("a deposit linked but archived falls back to the received date and is flagged", () => {
    const r = cashReceipts([{ ...base, depositArchived: true }], d("2026-12-01"), d("2026-12-31"));
    expect(r[0]!.noDepositLinked).toBe(true);
    expect(r[0]!.depositArchived).toBe(true);
  });
  it("groups by month and by client with the fee shown separately", () => {
    const s = summarizeCash(cashReceipts([{ ...base }, { ...base, id: "Q", clientId: "c2", amountCents: 500, feeCents: 0 }], d("2026-12-01"), d("2026-12-31")));
    expect(s.grossCents).toBe(10500);
    expect(s.feeCents).toBe(300);
    expect(s.byMonth.get("2026-12")?.grossCents).toBe(10500);
    expect(s.byClient.get("c1")?.feeCents).toBe(300);
    expect(s.unlinkedCount).toBe(2);
  });
});

describe("hygiene panel", () => {
  it("(a) linked deposits not revenue-typed, (b) revenue deposits not linked, (c) payments without a deposit", () => {
    const h = buildHygiene(
      [
        { paymentId: "P1", status: "recorded", receivedOn: d("2026-12-01"), amountCents: 100, depositId: "T1", depositArchived: false, depositGlType: "asset" },
        { paymentId: "P2", status: "recorded", receivedOn: d("2026-12-02"), amountCents: 200, depositId: null, depositArchived: false, depositGlType: null },
        { paymentId: "P3", status: "recorded", receivedOn: d("2026-12-03"), amountCents: 300, depositId: "T3", depositArchived: true, depositGlType: "revenue" },
        { paymentId: "P4", status: "void", receivedOn: d("2026-12-04"), amountCents: 400, depositId: null, depositArchived: false, depositGlType: null },
        { paymentId: "P5", status: "recorded", receivedOn: d("2026-12-05"), amountCents: 500, depositId: "T5", depositArchived: false, depositGlType: "revenue" },
      ],
      [{ transactionId: "T9", postedAt: d("2026-12-15"), amountCents: 5000, linked: false }, { transactionId: "T5", postedAt: d("2026-12-05"), amountCents: 500, linked: true }]
    );
    expect(h.linkedNotRevenueTyped.map((x) => x.paymentId)).toEqual(["P1"]);
    expect(h.paymentsWithoutDeposit.map((x) => [x.paymentId, x.deposit])).toEqual([["P2", "none"], ["P3", "archived"]]);
    expect(h.revenueDepositsNotLinked.map((x) => x.transactionId)).toEqual(["T9"]);
  });
});

describe("deposit lifecycle fuzz (Coder-authored; D-13): apply / remove / RE-APPLY / void payment / void invoice, same day and later days", () => {
  // Independent oracle: Unearned = amount - allocations in force at the end of the day (0 once the payment is void), A/R = open balances.
  // The generator allows a re-apply on the receipt day on purpose (that is the "applied to the wrong invoice, fix it" sequence).
  interface Al { inv: number; cents: number; appliedOn: Date; voidedAt: Date | null }
  function run(seed: number): string[] {
    let x = seed >>> 0 || 1;
    const rnd = () => {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      return x / 0xffffffff;
    };
    const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
    const DAY = 86_400_000;
    const base = Date.UTC(2026, 11, 1);
    const problems: string[] = [];
    const invCount = int(1, 3);
    const issueDay = 0;
    const invs = Array.from({ length: invCount }, (_, i) => ({ id: `I${i}`, total: int(50, 400) * 100, status: "issued" as "issued" | "void", voidedAt: null as Date | null }));
    const amount = int(50, 600) * 100;
    const fee = rnd() < 0.3 ? int(1, 4000) : 0;
    const receivedDay = int(0, 2);
    const receivedOn = new Date(base + receivedDay * DAY);
    const als: Al[] = [];
    let payStatus: "recorded" | "void" = "recorded";
    let payVoidedAt: Date | null = null;
    let day = receivedDay + (rnd() < 0.6 ? 0 : int(1, 2)); // recorded on the receipt day or later
    let hour = 1;
    const at = (dd: number, h: number) => new Date(base + dd * DAY + h * 3_600_000);
    const active = (a: Al, e: Date) => a.appliedOn.getTime() <= e.getTime() && (a.voidedAt === null || a.voidedAt.getTime() > e.getTime());
    const open = (i: number) => invs[i]!.total - als.filter((a) => a.inv === i && a.voidedAt === null).reduce((s, a) => s + a.cents, 0);
    const rem = () => amount - als.filter((a) => a.voidedAt === null).reduce((s, a) => s + a.cents, 0);

    const check = (label: string) => {
      const docs: LedgerDoc[] = invs.map((v) => ({
        id: v.id, kind: "invoice", status: v.status, issueDate: at(issueDay, 0), voidedAt: v.voidedAt, totalCents: v.total, discountCents: 0, lines: [{ glCodeId: SVC, lineTotalCents: v.total }],
      }));
      const payments: LedgerPayment[] = [{
        id: "P", receivedOn, amountCents: amount, feeCents: fee, status: payStatus, voidedAt: payVoidedAt,
        allocations: als.map((a) => ({ appliedOn: a.appliedOn, amountCents: a.cents, voidedAt: a.voidedAt })),
      }];
      const entries = deriveLedger(docs, payments);
      if (!isBalanced(entries)) problems.push(`${label}: ledger not balanced`);
      const eod = new Date(base + day * DAY + DAY - 1);
      const bal = balancesByAccount(entries, eod);
      const unearned = 0 - (bal.get(ACCOUNT_UNEARNED) ?? 0);
      const wantUnearned = payStatus === "void" ? 0 : amount - als.filter((a) => active(a, eod)).reduce((s, a) => s + a.cents, 0);
      if (unearned !== wantUnearned) problems.push(`${label}: Unearned ${unearned} != unapplied deposit ${wantUnearned}`);
      const wantAr = invs.reduce((s, v, i) => (v.status === "issued" ? s + v.total - als.filter((a) => a.inv === i && active(a, eod)).reduce((t, a) => t + a.cents, 0) : s), 0);
      if ((bal.get(ACCOUNT_AR) ?? 0) !== wantAr) problems.push(`${label}: A/R ${bal.get(ACCOUNT_AR) ?? 0} != open balances ${wantAr}`);
    };

    // record the payment with some record-time applications (dated on the receipt day, never before it)
    for (let i = 0; i < invs.length; i += 1) {
      if (rnd() < 0.6) {
        const c = Math.min(open(i), rem(), int(1, 400) * 100);
        if (c > 0) als.push({ inv: i, cents: c, appliedOn: receivedOn, voidedAt: null });
      }
    }
    check("recorded");
    for (let step = 0; step < 14 && payStatus === "recorded"; step += 1) {
      if (rnd() < 0.3) {
        day += int(0, 2);
        hour = 1;
      }
      hour = Math.min(hour + 1, 22);
      const r = rnd();
      const label = `step ${step}`;
      if (r < 0.4) {
        const i = int(0, invCount - 1);
        const c = Math.min(open(i), rem(), int(1, 500) * 100);
        if (invs[i]!.status === "issued" && c > 0) als.push({ inv: i, cents: c, appliedOn: new Date(base + Math.max(day, receivedDay) * DAY), voidedAt: null });
      } else if (r < 0.7) {
        const live = als.filter((a) => a.voidedAt === null);
        if (live.length > 0) live[int(0, live.length - 1)]!.voidedAt = at(day, hour);
      } else if (r < 0.8) {
        if (als.every((a) => a.voidedAt !== null)) {
          payStatus = "void";
          payVoidedAt = at(day, hour);
        }
      } else {
        const i = int(0, invCount - 1);
        if (invs[i]!.status === "issued" && !als.some((a) => a.inv === i && a.voidedAt === null)) {
          invs[i]!.status = "void";
          invs[i]!.voidedAt = at(day, hour);
        }
      }
      check(label);
    }
    return problems.map((p) => `seed ${seed} ${p}`);
  }

  it("1,500 random lifecycles (apply, remove, re-apply on the receipt day or later, void payment, void invoice): balanced, Unearned = unapplied deposit, A/R = open balances", () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 1500; seed += 1) problems.push(...run(seed * 2654435761));
    expect(problems).toEqual([]);
  });

  it("the minimal D-13 sequence: applied, removed, applied again on the receipt day", () => {
    const day = d("2026-12-01");
    const docs = [invoice("I1", "2026-12-01", [{ gl: SVC, q: 1000, p: 10000 }])];
    const payments = [pay("P1", "2026-12-01", 10000, 0, [{ on: "2026-12-01", cents: 10000, voidedAt: "2026-12-01" }, { on: "2026-12-01", cents: 10000 }])];
    const entries = deriveLedger(docs, payments);
    expect(isBalanced(entries)).toBe(true);
    const bal = balancesByAccount(entries, new Date(day.getTime() + 86_399_999));
    expect(bal.get(ACCOUNT_UNEARNED) ?? 0).toBe(0);
    expect(bal.get(ACCOUNT_AR) ?? 0).toBe(0);
  });
});
