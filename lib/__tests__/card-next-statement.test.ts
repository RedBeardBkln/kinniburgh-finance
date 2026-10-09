import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  cardDuesInWindow,
  cardPaymentEvents,
  detectStatementPaid,
  inferCloseLag,
  inferFundingAccount,
  observedPayments,
  projectCardStatements,
  toLedgerCardInputs,
  type BankOutflowRow,
  type CardInput,
  type CardProjection,
  type CardTxRow,
} from "@/lib/card-next-statement";

// All dates are UTC midnight (how Plaid dates and the ledger's "today" are stored).
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const D = (s: string | number) => new Decimal(String(s));
const iso = (x: Date) => x.toISOString().slice(0, 10);

function tx(date: string, amount: string, text: string, pending = false): CardTxRow {
  return { postedAt: d(date), amount: D(amount), text, pending };
}
function out(accountId: string, nickname: string, date: string, amount: string, text: string): BankOutflowRow {
  return { accountId, accountNickname: nickname, postedAt: d(date), amount: D(amount), text };
}

const TODAY = d("2026-10-09");

// ── detectStatementPaid ──────────────────────────────────────────────────────

describe("detectStatementPaid", () => {
  const base = { dueDate: d("2026-10-05"), statementBalance: D("623.19"), today: TODAY, bankOutflows: [] as BankOutflowRow[] };

  it("a payment-like inflow equal to the statement means paid, with the payment date as evidence", () => {
    const ev = detectStatementPaid({ ...base, cardTxs: [tx("2026-10-04", "623.19", "payment received")] });
    expect(ev).not.toBeNull();
    expect(ev?.rule).toBe("payment_inflows");
    expect(iso(ev!.date)).toBe("2026-10-04");
    expect(ev?.amount.toFixed(2)).toBe("623.19");
  });

  it("an overpayment counts as paid", () => {
    expect(detectStatementPaid({ ...base, cardTxs: [tx("2026-10-04", "700.00", "payment received")] })).not.toBeNull();
  });

  it("a partial payment is not paid (no claim without evidence)", () => {
    expect(detectStatementPaid({ ...base, cardTxs: [tx("2026-10-04", "300.00", "payment received")] })).toBeNull();
  });

  it("two payment rows that add up to the statement are paid", () => {
    const ev = detectStatementPaid({
      ...base,
      cardTxs: [tx("2026-10-02", "400.00", "payment received"), tx("2026-10-04", "223.19", "payment received")],
    });
    expect(ev?.amount.toFixed(2)).toBe("623.19");
    expect(iso(ev!.date)).toBe("2026-10-04");
  });

  it("is tolerant by exactly one cent", () => {
    expect(detectStatementPaid({ ...base, cardTxs: [tx("2026-10-04", "623.18", "payment received")] })).not.toBeNull();
    expect(detectStatementPaid({ ...base, cardTxs: [tx("2026-10-04", "623.17", "payment received")] })).toBeNull();
  });

  it("a refund of the same amount is NOT a payment", () => {
    expect(detectStatementPaid({ ...base, cardTxs: [tx("2026-10-04", "623.19", "chewy com")] })).toBeNull();
  });

  it("'pymt' (Capital One autopay text) counts as payment-like", () => {
    expect(
      detectStatementPaid({ ...base, cardTxs: [tx("2026-10-04", "623.19", "capital one autopay pymt")] })?.rule
    ).toBe("payment_inflows");
    expect(detectStatementPaid({ ...base, cardTxs: [tx("2026-10-04", "623.19", "online pymt thank you")] })).not.toBeNull();
  });

  it("a non-payment-looking inflow IS accepted when the exact amount also left a bank account within -1..+5 days", () => {
    const outflow = out("acct-cc", "Credit Cards", "2026-10-06", "-623.19", "xfer");
    const ev = detectStatementPaid({ ...base, cardTxs: [tx("2026-10-04", "623.19", "online transfer")], bankOutflows: [outflow] });
    expect(ev?.rule).toBe("matched_outflow");
    expect(ev?.via).toContain("Credit Cards");
  });

  it("the outflow must match to the cent and fall inside -1..+5 days", () => {
    const card = [tx("2026-10-04", "623.19", "online transfer")];
    expect(detectStatementPaid({ ...base, cardTxs: card, bankOutflows: [out("a", "A", "2026-10-06", "-623.18", "x")] })).toBeNull();
    expect(detectStatementPaid({ ...base, cardTxs: card, bankOutflows: [out("a", "A", "2026-10-09", "-623.19", "x")] })).not.toBeNull(); // +5
    expect(detectStatementPaid({ ...base, cardTxs: card, bankOutflows: [out("a", "A", "2026-10-10", "-623.19", "x")] })).toBeNull(); // +6 (and in the future)
    expect(detectStatementPaid({ ...base, cardTxs: card, bankOutflows: [out("a", "A", "2026-10-03", "-623.19", "x")] })).not.toBeNull(); // -1
    expect(detectStatementPaid({ ...base, cardTxs: card, bankOutflows: [out("a", "A", "2026-10-02", "-623.19", "x")] })).toBeNull(); // -2
  });

  it("an early payment before a FUTURE due date is detected", () => {
    const ev = detectStatementPaid({
      dueDate: d("2026-10-25"),
      statementBalance: D("500.00"),
      today: TODAY,
      bankOutflows: [],
      cardTxs: [tx("2026-10-06", "500.00", "payment received")],
    });
    expect(ev).not.toBeNull();
  });

  it("a payment before the window (the previous cycle's) does not count toward this statement", () => {
    const ev = detectStatementPaid({
      ...base,
      cardTxs: [tx("2026-09-04", "623.19", "payment received")], // a month earlier: the previous statement
    });
    expect(ev).toBeNull();
  });

  it("pending and future-dated rows are ignored", () => {
    expect(detectStatementPaid({ ...base, cardTxs: [tx("2026-10-04", "623.19", "payment received", true)] })).toBeNull();
    expect(detectStatementPaid({ ...base, cardTxs: [tx("2026-10-12", "623.19", "payment received")] })).toBeNull();
  });

  it("a zero or negative statement is never 'paid'", () => {
    expect(detectStatementPaid({ ...base, statementBalance: D(0), cardTxs: [tx("2026-10-04", "10", "payment received")] })).toBeNull();
    expect(detectStatementPaid({ ...base, statementBalance: D(-5), cardTxs: [tx("2026-10-04", "10", "payment received")] })).toBeNull();
  });

  it("no card activity at all is simply null", () => {
    expect(detectStatementPaid({ ...base, cardTxs: [] })).toBeNull();
  });
});

// ── observedPayments ─────────────────────────────────────────────────────────

describe("observedPayments", () => {
  it("sums a split payment, ignores refunds and pending rows, keeps order", () => {
    const rows = [
      tx("2026-09-02", "100", "payment received"),
      tx("2026-09-04", "50", "payment received"), // within 7 days of the first: one payment of 150
      tx("2026-09-05", "30", "chewy com"), // refund
      tx("2026-10-04", "200", "payment received"),
      tx("2026-10-06", "999", "payment received", true), // pending
    ];
    const p = observedPayments(rows);
    expect(p.map((x) => x.amount.toFixed(2))).toEqual(["150.00", "200.00"]);
    expect(iso(p[0]!.date)).toBe("2026-09-04");
  });
});

// ── inferFundingAccount ──────────────────────────────────────────────────────

describe("inferFundingAccount", () => {
  const pays = (n: number) =>
    Array.from({ length: n }, (_, i) => tx(`2026-0${i + 3}-04`, String(100 + i * 10), "payment received"));
  const flowFor = (i: number, accountId: string, nick: string, text = "barclays", lag = 1) =>
    out(accountId, nick, `2026-0${i + 3}-${String(4 + lag).padStart(2, "0")}`, `-${100 + i * 10}`, text);

  it("picks the account that matched every payment", () => {
    const inf = inferFundingAccount({
      cardTxs: pays(4),
      bankOutflows: [0, 1, 2, 3].map((i) => flowFor(i, "cc", "Credit Cards")),
    });
    expect(inf).toEqual({ accountId: "cc", accountNickname: "Credit Cards", matches: 4, of: 4 });
  });

  it("is 'not determined' (null) with a single match", () => {
    expect(inferFundingAccount({ cardTxs: pays(4), bankOutflows: [flowFor(0, "cc", "Credit Cards")] })).toBeNull();
  });

  it("is null on a tie between accounts", () => {
    const flows = [flowFor(0, "a", "A"), flowFor(1, "a", "A"), flowFor(2, "b", "B"), flowFor(3, "b", "B")];
    expect(inferFundingAccount({ cardTxs: pays(4), bankOutflows: flows })).toBeNull();
  });

  it("needs at least 2/3 of the matched payments on the winner", () => {
    // winner a: 2, b: 1, c: 1 -> 4 matched; 2 of 4 is under 2/3
    const flows = [flowFor(0, "a", "A"), flowFor(1, "a", "A"), flowFor(2, "b", "B"), flowFor(3, "c", "C")];
    expect(inferFundingAccount({ cardTxs: pays(4), bankOutflows: flows })).toBeNull();
    // winner a: 2, b: 1 -> 3 matched; 2 of 3 is exactly 2/3 -> accepted
    const ok = inferFundingAccount({ cardTxs: pays(3), bankOutflows: [flowFor(0, "a", "A"), flowFor(1, "a", "A"), flowFor(2, "b", "B")] });
    expect(ok).toEqual({ accountId: "a", accountNickname: "A", matches: 2, of: 3 });
  });

  it("an unrelated same-amount outflow on another account does not hijack the answer (payee text breaks the tie)", () => {
    const flows = [
      flowFor(0, "cc", "Credit Cards"),
      flowFor(1, "cc", "Credit Cards"),
      flowFor(2, "cc", "Credit Cards"),
      out("pc", "Primary Checking", "2026-04-04", "-110", "netflix"), // same amount as payment #1, other account
    ];
    expect(inferFundingAccount({ cardTxs: pays(3), bankOutflows: flows })).toMatchObject({ accountId: "cc", matches: 3, of: 3 });
  });

  it("when several accounts match and none looks like a card payment, that payment is skipped", () => {
    const flows = [
      out("a", "A", "2026-03-05", "-100", "netflix"),
      out("b", "B", "2026-03-05", "-100", "spotify"),
      flowFor(1, "cc", "Credit Cards"),
      flowFor(2, "cc", "Credit Cards"),
    ];
    expect(inferFundingAccount({ cardTxs: pays(3), bankOutflows: flows })).toMatchObject({ accountId: "cc", matches: 2, of: 2 });
  });

  it("outflows outside -1..+5 days do not match", () => {
    const late = [0, 1, 2].map((i) => flowFor(i, "cc", "Credit Cards", "barclays", 6));
    expect(inferFundingAccount({ cardTxs: pays(3), bankOutflows: late })).toBeNull();
    const ok = [0, 1, 2].map((i) => flowFor(i, "cc", "Credit Cards", "barclays", 5));
    expect(inferFundingAccount({ cardTxs: pays(3), bankOutflows: ok })).not.toBeNull();
  });

  it("refunds are not payments, so they never produce a match", () => {
    const refunds = [tx("2026-03-04", "100", "chewy com"), tx("2026-04-04", "110", "the home depot")];
    const flows = [out("cc", "Credit Cards", "2026-03-05", "-100", "barclays"), out("cc", "Credit Cards", "2026-04-05", "-110", "barclays")];
    expect(inferFundingAccount({ cardTxs: refunds, bankOutflows: flows })).toBeNull();
  });

  it("looks at the last 6 payments only", () => {
    // 9 payments; only the newest 6 can match. Outflows exist for the OLDEST 3 only -> nothing matches.
    const many = Array.from({ length: 9 }, (_, i) => tx(`2026-0${(i % 9) + 1}-04`, String(100 + i), "payment received"));
    const flows = [0, 1, 2].map((i) => out("cc", "Credit Cards", `2026-0${i + 1}-05`, `-${100 + i}`, "barclays"));
    expect(inferFundingAccount({ cardTxs: many, bankOutflows: flows })).toBeNull();
  });
});

// ── projectCardStatements ────────────────────────────────────────────────────

/** Barclay-shaped history: payments on the 4th, funded from "Credit Cards" the next day. */
const BARCLAY_PAYMENTS: [string, string][] = [
  ["2026-04-04", "500.00"],
  ["2026-05-04", "800.00"],
  ["2026-06-04", "1200.00"],
  ["2026-07-04", "400.00"],
  ["2026-08-04", "900.00"],
  ["2026-09-04", "700.00"],
  ["2026-10-04", "623.19"],
];

function bankFor(payments: [string, string][] = BARCLAY_PAYMENTS): BankOutflowRow[] {
  return payments.map(([date, amt]) => {
    const next = new Date(d(date).getTime() + 86400000);
    return out("acct-cc", "Credit Cards", iso(next), `-${amt}`, "barclays");
  });
}

function barclayCard(over: Partial<CardInput> = {}): CardInput {
  return {
    id: "card-barclay",
    nickname: "Barclay",
    entityId: "ent-personal",
    currentBalance: D("2914.91"),
    currentBalanceAt: d("2026-10-09"),
    ccDueDate: d("2026-10-05"),
    ccStatementBalance: D("623.19"),
    txs: [
      tx("2026-03-30", "-50.00", "starbucks"),
      ...BARCLAY_PAYMENTS.map(([date, amt]) => tx(date, amt, "payment received")),
      tx("2026-09-27", "-1500.00", "british airways"),
      tx("2026-10-02", "-1414.91", "anthropic"),
    ],
    ...over,
  };
}

describe("projectCardStatements: Barclay-shaped (statement on file already paid)", () => {
  const p = projectCardStatements({ card: barclayCard(), bankOutflows: bankFor(), today: TODAY });

  it("detects the on-file statement as paid and infers the funding account", () => {
    expect(p.onFile?.paid?.rule).toBe("payment_inflows");
    expect(iso(p.onFile!.paid!.date)).toBe("2026-10-04");
    expect(p.onFile?.isFuture).toBe(false);
    expect(p.funding).toMatchObject({ accountId: "acct-cc", accountNickname: "Credit Cards", matches: 6, of: 6 });
  });

  it("the open cycle is the WHOLE balance (the paid statement is not subtracted), due one month later; the close lag is only assumed here, so medium", () => {
    const e = p.estimates[0]!;
    expect(e.kind).toBe("cycle_to_date");
    expect(e.amount.toFixed(2)).toBe("2914.91");
    expect(iso(e.dueDate)).toBe("2026-11-05");
    expect(iso(e.closeDate!)).toBe("2026-10-11");
    expect(e.daysToClose).toBe(2);
    expect(e.closeLagInferred).toBe(false);
    expect(e.closeLagDays).toBe(25);
    expect(e.confidence).toBe("medium"); // 2 days to close would be high, but an assumed close date caps it at medium
    expect(e.why).toContain("based on charges posted so far this cycle");
    expect(e.why).toContain("expected to close in about 2 days");
    expect(e.why).toContain("the close date is assumed to be 25 days before the due date and could be off by several days");
    expect(e.why).not.toMatch(/confidence/i);
  });

  it("'could reach about' uses the trailing 90-day pace and is not the point estimate", () => {
    const e = p.estimates[0]!;
    const expected = D("2914.91").plus(D("2914.91").div(90).times(2)).toDecimalPlaces(2);
    expect(e.upTo?.toFixed(2)).toBe(expected.toFixed(2));
    expect(e.amount.lessThan(e.upTo!)).toBe(true);
    expect(e.why).toContain("could reach about");
  });

  it("typical months use the MEDIAN of the last 3 payments, low confidence, on the following due dates", () => {
    const typical = p.estimates.filter((e) => e.kind === "typical_month");
    expect(typical.map((e) => iso(e.dueDate))).toEqual(["2026-12-05", "2027-01-05"]);
    for (const e of typical) {
      expect(e.amount.toFixed(2)).toBe("700.00"); // median of 900, 700, 623.19
      expect(e.confidence).toBe("low");
      expect(e.why).toContain("based on a typical month");
      expect(e.why).toContain("$400 to $1,200"); // last 6 payments range
    }
    expect(p.skipReasons).toEqual([]);
  });
});

describe("projectCardStatements: Capital One-shaped (statement on file still unpaid)", () => {
  const card: CardInput = {
    id: "card-cap1",
    nickname: "Capital One",
    entityId: "ent-ekc",
    currentBalance: D("865.24"),
    currentBalanceAt: d("2026-10-09"),
    ccDueDate: d("2026-10-12"),
    ccStatementBalance: D("792.68"),
    txs: [
      tx("2026-03-01", "-20.00", "coffee"),
      tx("2026-07-12", "300.00", "capital one autopay pymt"),
      tx("2026-08-12", "400.00", "capital one autopay pymt"),
      tx("2026-09-12", "500.00", "capital one autopay pymt"),
    ],
  };
  const bank = [
    out("acct-cc", "Credit Cards", "2026-07-13", "-300.00", "capital one crcardpmt"),
    out("acct-cc", "Credit Cards", "2026-08-13", "-400.00", "capital one crcardpmt"),
    out("acct-cc", "Credit Cards", "2026-09-13", "-500.00", "capital one crcardpmt"),
  ];
  const p = projectCardStatements({ card, bankOutflows: bank, today: TODAY });

  it("keeps the on-file statement as unpaid and subtracts it from the balance for the open cycle", () => {
    expect(p.onFile?.paid).toBeNull();
    expect(p.onFile?.isFuture).toBe(true);
    const e = p.estimates[0]!;
    expect(e.amount.toFixed(2)).toBe("72.56"); // 865.24 - 792.68
    expect(iso(e.dueDate)).toBe("2026-11-12");
    expect(e.daysToClose).toBe(9); // closes about Oct 18 (25 days before Nov 12)
    expect(e.confidence).toBe("medium");
    expect(e.why).toContain("based only on charges posted so far this cycle");
    expect(e.why).toContain("more may post");
  });

  it("funding comes from the matched crcardpmt outflows ('pymt' payments count as payments)", () => {
    expect(p.funding).toMatchObject({ accountId: "acct-cc", matches: 3, of: 3 });
  });
});

/**
 * A history in which the statement really closes `lags[k]` days before due date k (due on `anchorDay` of the months
 * `months[k]`, "YYYY-MM"). Cycle k's charges: a background charge 10 days before the close, one ON the close day and
 * one the day AFTER it (which belongs to the next statement); the payment (the whole statement) posts the day before
 * the due date. A cycle is only conclusive when it and the cycle before it have the SAME lag (the previous cycle's
 * charges sit on its own close day); a change of lag therefore leaves one inconclusive cycle in between, by design.
 */
function cycleHistory(lags: number[], months: string[], anchorDay = 5, step = 10): CardTxRow[] {
  const dueOf = (m: string) => {
    const [y, mo] = m.split("-").map(Number) as [number, number];
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return new Date(Date.UTC(y, mo - 1, Math.min(anchorDay, last)));
  };
  const back = (x: Date, n: number) => new Date(x.getTime() - n * 86400000);
  const txs: CardTxRow[] = [tx(iso(back(dueOf(months[0]!), 45)), "-1.00", "early coffee")];
  const X = (k: number) => 300 + step * k;
  const Y = (k: number) => 500 + step * k;
  const Z = (k: number) => 111 + k;
  months.forEach((m, k) => {
    const close = back(dueOf(m), lags[k]!);
    txs.push(tx(iso(back(close, 10)), `-${Z(k)}.00`, "groceries"));
    txs.push(tx(iso(close), `-${X(k)}.00`, "fuel"));
    txs.push(tx(iso(back(close, -1)), `-${Y(k)}.00`, "hotel"));
    if (k >= 1) {
      const statement = Y(k - 1) + Z(k) + X(k);
      txs.push(tx(iso(back(dueOf(m), 1)), `${statement}.00`, "payment received"));
    }
  });
  return txs;
}
const MONTHS = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];

describe("inferCloseLag: a card's own statement-close lag from its past cycles", () => {
  it.each([18, 22, 25, 27, 30])("recovers a true lag of %i days from 6 past cycles", (lag) => {
    const inf = inferCloseLag({ anchorDay: 5, txs: cycleHistory(MONTHS.map(() => lag), MONTHS) });
    expect(inf?.lag).toBe(lag);
    expect(inf?.agreeing).toBe(6);
    expect(inf?.narrowAgreeing).toBe(6);
  });

  it("needs at least 3 conclusive cycles: 2 past cycles are not enough", () => {
    expect(inferCloseLag({ anchorDay: 5, txs: cycleHistory([27, 27, 27], MONTHS.slice(0, 3)) })).toBeNull();
    expect(inferCloseLag({ anchorDay: 5, txs: cycleHistory([27, 27, 27, 27], MONTHS.slice(0, 4)) })?.lag).toBe(27);
  });

  it("cycles one day apart still agree; the lag that fits the most cycles exactly wins", () => {
    // conclusive cycles: 27, 27 (exact at 27) and 28, 28, 28 (exact at 28); every one is within +-1 of both
    const inf = inferCloseLag({ anchorDay: 5, txs: cycleHistory([27, 27, 27, 28, 28, 28, 28], MONTHS) });
    expect(inf?.lag).toBe(28);
    expect(inf?.agreeing).toBe(5);
  });

  it("a conclusive cycle that disagrees (3 days off) rejects the inference: the assumption is used instead", () => {
    // 3 cycles at 27 and 2 at 30: lag 27 is contradicted by the 30s, lag 30 has only 2 supporters
    expect(inferCloseLag({ anchorDay: 5, txs: cycleHistory([27, 27, 27, 27, 30, 30, 30], MONTHS) })).toBeNull();
  });

  it("a payment must match the charges to within $5: $5 off still counts, $6 off is inconclusive", () => {
    const shifted = (by: string) =>
      cycleHistory(MONTHS.map(() => 27), MONTHS, 5, 100).map((t) => (t.amount.greaterThan(0) ? { ...t, amount: t.amount.plus(D(by)) } : t));
    expect(inferCloseLag({ anchorDay: 5, txs: shifted("0") })?.lag).toBe(27);
    expect(inferCloseLag({ anchorDay: 5, txs: shifted("5") })?.lag).toBe(27);
    expect(inferCloseLag({ anchorDay: 5, txs: shifted("-5") })?.lag).toBe(27);
    expect(inferCloseLag({ anchorDay: 5, txs: shifted("6") })).toBeNull();
    expect(inferCloseLag({ anchorDay: 5, txs: shifted("-6") })).toBeNull();
  });

  it("cycles with no charges near the close fit every lag and never prove one (rejected, not defaulted to 25)", () => {
    // 6 identical quiet cycles: one $100 charge mid-cycle, paid in full each month
    const txs: CardTxRow[] = [tx("2026-01-15", "-1.00", "early coffee")];
    for (const m of MONTHS) {
      txs.push(tx(`${m}-16`, "-100.00", "groceries"));
      txs.push(tx(`${m}-04`, "100.00", "payment received"));
    }
    expect(inferCloseLag({ anchorDay: 5, txs })).toBeNull();
  });

  it("history that does not reach back past the earliest candidate close is not used", () => {
    const txs = cycleHistory(MONTHS.map(() => 27), MONTHS).filter((t) => t.postedAt.getTime() >= d("2026-06-01").getTime());
    expect(inferCloseLag({ anchorDay: 5, txs })).toBeNull();
  });

  it("a day-31 anchor is handled (short months clamp)", () => {
    const months = ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04"];
    const inf = inferCloseLag({ anchorDay: 31, txs: cycleHistory(months.map(() => 26), months, 31) });
    expect(inf?.lag).toBe(26);
  });
});

describe("projectCardStatements: confidence boundaries (days to the statement close)", () => {
  // The history pins the close at due - 25 days (INFERRED). Open-cycle due Nov 5 -> close Oct 11.
  const base = (today: Date, txs: CardTxRow[]): CardInput => ({
    id: "c",
    nickname: "Card",
    entityId: "e",
    currentBalance: D("400"),
    currentBalanceAt: today,
    ccDueDate: d("2026-10-05"),
    ccStatementBalance: null,
    txs,
  });
  const run = (todayIso: string) => {
    const today = d(todayIso);
    return projectCardStatements({ card: base(today, cycleHistory(MONTHS.map(() => 25), MONTHS)), bankOutflows: [], today }).estimates[0]!;
  };

  it.each([
    ["2026-10-08", 3, "high"],
    ["2026-10-07", 4, "medium"],
    ["2026-10-01", 10, "medium"],
    ["2026-09-30", 11, "low"],
    ["2026-10-11", 0, "high"], // the close day itself: "expected to close about now"
  ])("today %s -> %i days to close -> %s", (todayIso, days, confidence) => {
    const e = run(todayIso);
    expect(e.closeLagInferred).toBe(true);
    expect(e.closeLagDays).toBe(25);
    expect(e.daysToClose).toBe(days);
    expect(e.confidence).toBe(confidence);
  });

  it("a different inferred lag moves the close date and the days to close (lag 27: close Oct 9)", () => {
    const today = d("2026-10-09");
    const e = projectCardStatements({ card: base(today, cycleHistory(MONTHS.map(() => 27), MONTHS)), bankOutflows: [], today }).estimates[0]!;
    expect(e.closeLagDays).toBe(27);
    expect(iso(e.closeDate!)).toBe("2026-10-09");
    expect(e.daysToClose).toBe(0);
    expect(e.confidence).toBe("high");
    expect(e.why).toContain("worked out from your past statements and could be a day off");
    expect(e.why).toContain("charges posted or pending near the close can change the amount");
  });

  it("when the lag cannot be inferred the 25-day assumption is used, said so, and the confidence is never above medium", () => {
    const today = d("2026-10-08");
    const sparse = [tx("2026-03-01", "-10", "x"), tx("2026-08-04", "100", "payment received"), tx("2026-09-04", "200", "payment received")];
    const e = projectCardStatements({ card: base(today, sparse), bankOutflows: [], today }).estimates[0]!;
    expect(e.closeLagInferred).toBe(false);
    expect(e.closeLagDays).toBe(25);
    expect(e.daysToClose).toBe(3); // would be high with a known close
    expect(e.confidence).toBe("medium");
    expect(e.why).toContain("assumed to be 25 days before the due date");
    // low stays low
    const early = d("2026-09-30");
    expect(projectCardStatements({ card: base(early, sparse), bankOutflows: [], today: early }).estimates[0]!.confidence).toBe("low");
  });

  it("on the close day the text says the statement is expected to close about now and there is no 'could reach'", () => {
    const e = run("2026-10-11");
    expect(e.why).toContain("expected to close about now");
    expect(e.upTo).toBeNull();
  });

  it.each([
    ["2026-10-12", 1, "1 day ago"],
    ["2026-10-13", 2, "2 days ago"],
    ["2026-10-14", 3, "3 days ago"],
  ])("today %s is %i day(s) after the inferred close: never high, and the text says the statement should have closed", (todayIso, past, phrase) => {
    const e = run(todayIso);
    expect(e.closeLagInferred).toBe(true);
    expect(e.daysToClose).toBe(0);
    expect(e.confidence).toBe("medium"); // would be high by days alone, but the close has passed
    expect(e.why).toContain(`should have closed ${phrase}`);
    expect(e.why).toContain("may belong to the next statement");
    expect(e.why).not.toContain("about now");
    expect(e.why).not.toMatch(/confidence/i);
    expect(past).toBeGreaterThan(0);
  });

  it("no owner-visible estimate text prints a confidence tier word", () => {
    for (const day of ["2026-09-30", "2026-10-01", "2026-10-07", "2026-10-08", "2026-10-11", "2026-10-13"]) {
      const e = run(day);
      // ("may be too high" after the close date is plain English about the amount, not a tier word)
      expect(e.why.replace(/too high/g, ""), day).not.toMatch(/\b(high|medium|low)\b/i);
      expect(e.why, day).not.toMatch(/confidence/i);
    }
  });
});

describe("projectCardStatements: gates (never a guessed number)", () => {
  // The Barclay history without the Oct 4 payment: for a statement due Oct 12 the payment window opens Sep 21, so
  // nothing here can be read as paying it.
  const beforeSep21 = () => barclayCard().txs.filter((t) => t.postedAt.getTime() < d("2026-09-21").getTime() || t.amount.isNegative());
  const base = (over: Partial<CardInput> = {}): CardInput => barclayCard({ ccStatementBalance: null, ...over });

  it("history younger than 60 days: no estimate, a reason", () => {
    const young = (firstIso: string) =>
      projectCardStatements({
        card: base({ txs: [tx(firstIso, "-10", "x"), tx("2026-09-04", "100", "payment received"), tx("2026-10-04", "100", "payment received")] }),
        bankOutflows: [],
        today: TODAY,
      });
    const tooYoung = young("2026-08-11"); // 59 days before Oct 9
    expect(tooYoung.estimates).toEqual([]);
    expect(tooYoung.skipReasons.join(" ")).toContain("3 months of card history");
    expect(young("2026-08-10").estimates.length).toBeGreaterThan(0); // exactly 60 days
  });

  it("payment-count gates: 1 payment -> nothing; 2 -> open cycle only; 3 -> open cycle + typical months", () => {
    const withPayments = (n: number) =>
      projectCardStatements({
        card: base({
          txs: [
            tx("2026-03-01", "-10", "x"),
            ...["2026-06-04", "2026-07-04", "2026-08-04", "2026-09-04"].slice(4 - n).map((dt) => tx(dt, "300", "payment received")),
          ],
        }),
        bankOutflows: [],
        today: TODAY,
      });
    const one = withPayments(1);
    expect(one.estimates).toEqual([]);
    expect(one.skipReasons.join(" ")).toContain("at least 2 past payments");
    const two = withPayments(2);
    expect(two.estimates.map((e) => e.kind)).toEqual(["cycle_to_date"]);
    expect(two.skipReasons.join(" ")).toContain("at least 3 past payments");
    const three = withPayments(3);
    expect(three.estimates.map((e) => e.kind)).toEqual(["cycle_to_date", "typical_month", "typical_month"]);
  });

  it("a stale card balance (more than 3 days old) or a missing one gives no estimate", () => {
    const stale = projectCardStatements({ card: base({ currentBalanceAt: d("2026-10-05") }), bankOutflows: [], today: TODAY }); // 4 days
    expect(stale.estimates).toEqual([]);
    expect(stale.skipReasons.join(" ")).toContain("balance");
    expect(projectCardStatements({ card: base({ currentBalanceAt: d("2026-10-06") }), bankOutflows: [], today: TODAY }).estimates.length).toBeGreaterThan(0); // 3 days
    expect(projectCardStatements({ card: base({ currentBalance: null }), bankOutflows: [], today: TODAY }).estimates).toEqual([]);
  });

  it("no due date on file, or one more than 45 days old, gives no estimate", () => {
    expect(projectCardStatements({ card: base({ ccDueDate: null }), bankOutflows: [], today: TODAY }).estimates).toEqual([]);
    const old = projectCardStatements({ card: base({ ccDueDate: d("2026-08-20") }), bankOutflows: [], today: TODAY }); // 50 days
    expect(old.estimates).toEqual([]);
    expect(old.skipReasons.join(" ")).toContain("out of date");
  });

  it("a due date on file whose next month is already in the past gives no estimate", () => {
    const r = projectCardStatements({ card: base({ ccDueDate: d("2026-08-26") }), bankOutflows: [], today: TODAY }); // 44 days; next due Sep 26
    expect(r.estimates).toEqual([]);
  });

  it("an unpaid statement larger than the balance (by more than $5) is inconsistent: no open-cycle estimate", () => {
    const r = projectCardStatements({
      card: barclayCard({ ccDueDate: d("2026-10-12"), ccStatementBalance: D("900.00"), currentBalance: D("700.00"), txs: beforeSep21() }),
      bankOutflows: [],
      today: TODAY,
    });
    expect(r.estimates.some((e) => e.kind === "cycle_to_date")).toBe(false);
    expect(r.skipReasons.join(" ")).toContain("lower than the statement");
  });

  it("nothing charged this cycle (balance equals the unpaid statement, or a credit balance) gives no open-cycle item", () => {
    const equal = projectCardStatements({
      card: barclayCard({ ccDueDate: d("2026-10-12"), ccStatementBalance: D("500.00"), currentBalance: D("500.00"), txs: beforeSep21() }),
      bankOutflows: [],
      today: TODAY,
    });
    expect(equal.estimates.some((e) => e.kind === "cycle_to_date")).toBe(false);
    const credit = projectCardStatements({
      card: barclayCard({ ccStatementBalance: null, currentBalance: D("-30.00") }),
      bankOutflows: [],
      today: TODAY,
    });
    expect(credit.estimates.some((e) => e.kind === "cycle_to_date")).toBe(false);
  });

  it("pending rows are not payments and do not count toward the history or pace", () => {
    const r = projectCardStatements({
      card: base({
        txs: [tx("2026-03-01", "-10", "x"), tx("2026-09-04", "100", "payment received"), tx("2026-10-04", "100", "payment received", true)],
      }),
      bankOutflows: [],
      today: TODAY,
    });
    expect(r.estimates).toEqual([]); // only 1 posted payment
  });
});

describe("projectCardStatements: day-of-month anchors", () => {
  it("a day-31 anchor clamps to the month end and goes back to 31", () => {
    const today = d("2026-02-02");
    const card: CardInput = {
      id: "c",
      nickname: "Card",
      entityId: "e",
      currentBalance: D("300"),
      currentBalanceAt: today,
      ccDueDate: d("2026-01-31"),
      ccStatementBalance: null,
      txs: [
        tx("2025-10-01", "-10", "x"),
        tx("2025-11-30", "100", "payment received"),
        tx("2025-12-31", "200", "payment received"),
        tx("2026-01-31", "300", "payment received"),
      ],
    };
    const r = projectCardStatements({ card, bankOutflows: [], today });
    expect(r.estimates.map((e) => iso(e.dueDate))).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });
});

// ── Consumers ────────────────────────────────────────────────────────────────

describe("cardPaymentEvents / cardDuesInWindow / toLedgerCardInputs", () => {
  const paid = projectCardStatements({ card: barclayCard(), bankOutflows: bankFor(), today: TODAY });
  const FROM = d("2026-10-09");
  const TO = d("2027-01-07");

  it("a paid on-file statement is not a payment event; estimates are, into the funding account, labelled (estimate)", () => {
    const events = cardPaymentEvents(paid, FROM, TO);
    expect(events.map((e) => iso(e.date))).toEqual(["2026-11-05", "2026-12-05", "2027-01-05"]);
    for (const e of events) {
      expect(e.accountId).toBe("acct-cc");
      expect(e.description).toBe("Barclay statement payment (estimate)");
      expect(e.amount.isNegative()).toBe(true);
    }
    expect(events[0]!.amount.negated().toFixed(2)).toBe("2914.91");
  });

  it("an unpaid on-file statement in the window is a payment event of the FULL statement", () => {
    const unpaid: CardProjection = {
      ...paid,
      onFile: { dueDate: d("2026-10-12"), amount: D("792.68"), paid: null, isFuture: true },
      estimates: [],
    };
    const events = cardPaymentEvents(unpaid, FROM, TO);
    expect(events).toHaveLength(1);
    expect(events[0]!.description).toBe("Barclay statement payment");
    expect(events[0]!.amount.toFixed(2)).toBe("-792.68");
  });

  it("a card whose funding account is not determined is assigned to no account", () => {
    expect(cardPaymentEvents({ ...paid, funding: null }, FROM, TO)).toEqual([]);
  });

  it("cardDuesInWindow flags estimates, keeps the on-file statement unflagged and honours a confidence floor", () => {
    const withOnFile: CardProjection = { ...paid, onFile: { dueDate: d("2026-10-12"), amount: D("792.68"), paid: null, isFuture: true } };
    const all = cardDuesInWindow(withOnFile, FROM, TO);
    expect(all.map((c) => c.estimate?.confidence ?? "on-file")).toEqual(["on-file", "medium", "low", "low"]);
    const medium = cardDuesInWindow(withOnFile, FROM, TO, { minConfidence: "medium" });
    expect(medium.map((c) => c.estimate?.confidence ?? "on-file")).toEqual(["on-file", "medium"]);
    expect(cardDuesInWindow(paid, FROM, d("2026-10-20"))).toEqual([]); // paid on-file, nothing else yet
    expect(medium[0]!.entityId).toBe("ent-personal");
  });

  it("toLedgerCardInputs maps paid evidence (null = checked, nothing found) and the estimates", () => {
    const unpaid: CardProjection = { ...paid, cardId: "card-2", onFile: { dueDate: d("2026-10-12"), amount: D("1"), paid: null, isFuture: true }, estimates: [] };
    const none: CardProjection = { ...paid, cardId: "card-3", onFile: null, estimates: [] };
    const { paidByCardId, estimates } = toLedgerCardInputs([paid, unpaid, none]);
    expect(paidByCardId.get("card-barclay")?.via).toBe("a payment received on the card");
    expect(paidByCardId.get("card-2")).toBeNull();
    expect(paidByCardId.has("card-3")).toBe(false);
    expect(estimates).toHaveLength(3);
    expect(estimates[0]).toMatchObject({ cardId: "card-barclay", entityId: "ent-personal", confidence: "medium", kind: "cycle_to_date" });
  });
});
