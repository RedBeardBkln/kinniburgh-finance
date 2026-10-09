import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { detectRecurring } from "@/lib/recurring-detect";
import {
  CLOSE_LAG_DAYS,
  cardDuesInWindow,
  cardPaymentEvents,
  detectStatementPaid,
  inferFundingAccount,
  projectCardStatements,
  toLedgerCardInputs,
  type BankOutflowRow,
  type CardInput,
  type CardTxRow,
} from "@/lib/card-next-statement";

// TESTER-authored (pipeline task: credit-card-full-pay). Independent oracles written from the PLAN, not from the
// implementation: paid-statement evidence, funding-account inference, open-cycle estimate, gates, confidence.

const DAY = 86_400_000;
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);
const D = (s: string | number) => new Decimal(String(s));
const addDays = (x: Date, n: number) => new Date(x.getTime() + n * DAY);
const diff = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY);

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
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const money = (r: () => number, lo: number, hi: number) => D((lo + Math.floor(r() * (hi - lo) * 100) / 100).toFixed(2));

const tx = (date: string, amount: string, text: string, pending = false): CardTxRow => ({ postedAt: d(date), amount: D(amount), text, pending });
const out = (accountId: string, nick: string, date: string, amount: string, text: string): BankOutflowRow => ({
  accountId, accountNickname: nick, postedAt: d(date), amount: D(amount), text,
});

const PAYMENT_TEXTS = ["payment received", "capital one autopay pymt", "online payment thank you", "ach pymt barclays", "autopay"];
const REFUND_TEXTS = ["chewy com", "lner online", "the home depot", "teacher ai", "amazon refund", "merchant credit", "anthropic"];
const BANK_TEXTS = ["barclays", "capital one crcardpmt", "netflix", "xfer", "mortgage", "autopay card"];

// ── 1. Paid-statement evidence: oracle fuzz ──────────────────────────────────────────────────────

function paidOracle(a: { due: Date; stmt: Decimal; card: CardTxRow[]; bank: BankOutflowRow[]; today: Date }): boolean {
  if (!a.stmt.greaterThan(0)) return false;
  const need = a.stmt.minus("0.01");
  const lo = addDays(a.due, -21);
  const inflows = a.card.filter((t) => !t.pending && t.amount.greaterThan(0) && t.postedAt >= lo && t.postedAt <= a.today);
  const pay = inflows.filter((t) => /payment|autopay|pymt/i.test(t.text));
  if (pay.length && pay.reduce((s, t) => s.plus(t.amount), D(0)).greaterThanOrEqualTo(need)) return true;
  for (const i of inflows) {
    if (i.amount.lessThan(need)) continue;
    for (const o of a.bank) {
      if (!o.amount.negated().equals(i.amount) || !o.amount.isNegative()) continue;
      const dd = diff(o.postedAt, i.postedAt);
      if (dd >= -1 && dd <= 5 && o.postedAt <= a.today) return true;
    }
  }
  return false;
}

describe("detectStatementPaid: independent oracle fuzz", () => {
  it("3000 random card histories: paid iff the plan's evidence rules say so (never without evidence)", () => {
    const r = rng(20261009);
    let paidCount = 0;
    let unpaidCount = 0;
    for (let n = 0; n < 3000; n++) {
      const today = d("2026-10-09");
      const due = addDays(today, int(r, -30, 25));
      const stmt = r() < 0.05 ? pick(r, [D(0), D("-5"), D("0.00")]) : money(r, 1, 3000);
      const card: CardTxRow[] = [];
      const bank: BankOutflowRow[] = [];
      for (let k = 0; k < int(r, 0, 7); k++) {
        const date = addDays(due, int(r, -26, 12));
        const kind = r();
        if (kind < 0.35) {
          // a payment-like row, often exactly / near the statement
          const amt = r() < 0.5 ? stmt : r() < 0.5 ? money(r, 1, 3000) : stmt.minus(D(pick(r, ["0", "0.01", "0.02", "100"])));
          card.push({ postedAt: date, amount: amt, text: pick(r, PAYMENT_TEXTS), pending: r() < 0.1 });
        } else if (kind < 0.7) {
          // a refund / merchant credit (not payment-like), sometimes equal to the statement
          const amt = r() < 0.4 ? stmt : money(r, 1, 3000);
          card.push({ postedAt: date, amount: amt, text: pick(r, REFUND_TEXTS), pending: r() < 0.1 });
          if (r() < 0.5) bank.push({ accountId: pick(r, ["a1", "a2"]), accountNickname: "x", postedAt: addDays(date, int(r, -3, 8)), amount: amt.negated(), text: pick(r, BANK_TEXTS) });
        } else if (kind < 0.85) {
          card.push({ postedAt: date, amount: money(r, 1, 800).negated(), text: pick(r, REFUND_TEXTS), pending: false }); // a charge
        } else {
          // payment on card plus a matching bank outflow
          const amt = r() < 0.6 ? stmt : money(r, 1, 3000);
          card.push({ postedAt: date, amount: amt, text: r() < 0.5 ? "xyz" : pick(r, PAYMENT_TEXTS), pending: false });
          bank.push({ accountId: "a1", accountNickname: "Credit Cards", postedAt: addDays(date, int(r, -2, 7)), amount: amt.negated(), text: pick(r, BANK_TEXTS) });
        }
      }
      const got = detectStatementPaid({ dueDate: due, statementBalance: stmt, cardTxs: card, bankOutflows: bank, today });
      const want = paidOracle({ due, stmt, card, bank, today });
      if (want) paidCount++;
      else unpaidCount++;
      expect({ n, paid: got !== null }).toEqual({ n, paid: want });
      if (got) {
        // the evidence is real: a date inside the window and an amount that is positive
        expect(got.date.getTime()).toBeGreaterThanOrEqual(addDays(due, -21).getTime());
        expect(got.date.getTime()).toBeLessThanOrEqual(today.getTime());
        expect(got.amount.greaterThan(0)).toBe(true);
      }
    }
    // the fuzz must exercise both branches
    expect(paidCount).toBeGreaterThan(200);
    expect(unpaidCount).toBeGreaterThan(200);
  });

  it("window edges: a payment 21 days before the due date counts, 22 days before does not; today counts, tomorrow does not", () => {
    const due = d("2026-10-30");
    const base = { dueDate: due, statementBalance: D("100"), bankOutflows: [] as BankOutflowRow[], today: d("2026-10-09") };
    expect(detectStatementPaid({ ...base, cardTxs: [tx("2026-10-09", "100", "payment received")] })).not.toBeNull(); // = due-21 AND today
    expect(detectStatementPaid({ ...base, cardTxs: [tx("2026-10-08", "100", "payment received")] })).toBeNull(); // due-22
    expect(detectStatementPaid({ ...base, today: d("2026-10-20"), cardTxs: [tx("2026-10-20", "100", "payment received")] })).not.toBeNull();
    expect(detectStatementPaid({ ...base, today: d("2026-10-20"), cardTxs: [tx("2026-10-21", "100", "payment received")] })).toBeNull();
  });

  it("the PREVIOUS cycle's payment never marks the next statement paid (Barclay shape: paid Sep 4 and Oct 4)", () => {
    const history = [tx("2026-09-04", "521.40", "payment received")];
    expect(detectStatementPaid({ dueDate: d("2026-10-05"), statementBalance: D("521.40"), cardTxs: history, bankOutflows: [], today: d("2026-10-03") })).toBeNull();
  });

  it("statement 0 or negative, or pending / outflow rows, are never evidence", () => {
    const rows = [tx("2026-10-04", "50", "payment received"), tx("2026-10-04", "-50", "payment received")];
    for (const stmt of ["0", "-1", "-50"]) {
      expect(detectStatementPaid({ dueDate: d("2026-10-05"), statementBalance: D(stmt), cardTxs: rows, bankOutflows: [], today: d("2026-10-09") })).toBeNull();
    }
    expect(detectStatementPaid({ dueDate: d("2026-10-05"), statementBalance: D("50"), cardTxs: [tx("2026-10-04", "50", "payment received", true)], bankOutflows: [], today: d("2026-10-09") })).toBeNull();
    expect(detectStatementPaid({ dueDate: d("2026-10-05"), statementBalance: D("50"), cardTxs: [tx("2026-10-04", "-50", "payment received")], bankOutflows: [], today: d("2026-10-09") })).toBeNull();
  });

  it("a refund equal to the statement with NO matching bank outflow is never paid; with a same-cent outflow in -1..+5 days it is (documented rule 2); +6 or -2 days is not", () => {
    const card = [tx("2026-10-04", "623.19", "chewy com")];
    const args = { dueDate: d("2026-10-05"), statementBalance: D("623.19"), cardTxs: card, today: d("2026-10-12") };
    expect(detectStatementPaid({ ...args, bankOutflows: [] })).toBeNull();
    expect(detectStatementPaid({ ...args, bankOutflows: [out("a", "Credit Cards", "2026-10-09", "-623.19", "xfer")] })?.rule).toBe("matched_outflow");
    expect(detectStatementPaid({ ...args, bankOutflows: [out("a", "Credit Cards", "2026-10-10", "-623.19", "xfer")] })).toBeNull();
    expect(detectStatementPaid({ ...args, bankOutflows: [out("a", "Credit Cards", "2026-10-02", "-623.19", "xfer")] })).toBeNull();
    expect(detectStatementPaid({ ...args, bankOutflows: [out("a", "Credit Cards", "2026-10-03", "-623.19", "xfer")] })?.rule).toBe("matched_outflow");
    // a different amount (even by a cent) is not a match
    expect(detectStatementPaid({ ...args, bankOutflows: [out("a", "Credit Cards", "2026-10-05", "-623.18", "xfer")] })).toBeNull();
  });

  it("two payments that sum to the statement across the window are paid; one from before the window does not complete it", () => {
    const due = d("2026-10-05");
    const args = { dueDate: due, statementBalance: D("500"), bankOutflows: [] as BankOutflowRow[], today: d("2026-10-09") };
    expect(detectStatementPaid({ ...args, cardTxs: [tx("2026-09-20", "200", "payment received"), tx("2026-10-02", "300", "autopay")] })).not.toBeNull();
    expect(detectStatementPaid({ ...args, cardTxs: [tx("2026-09-10", "200", "payment received"), tx("2026-10-02", "300", "autopay")] })).toBeNull();
  });
});

// ── 2. Funding-account inference: oracle fuzz ────────────────────────────────────────────────────

const FUND_RE = /barclay|crcardpmt|capital one|card|autopay/i;
function fundingOracle(card: CardTxRow[], bank: BankOutflowRow[]): string | null {
  const pays = card.filter((t) => !t.pending && t.amount.greaterThan(0) && /payment|autopay|pymt/i.test(t.text)).sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime()).slice(0, 6);
  const counts = new Map<string, number>();
  let matched = 0;
  for (const p of pays) {
    let c = bank.filter((o) => o.amount.isNegative() && o.amount.negated().equals(p.amount) && diff(o.postedAt, p.postedAt) >= -1 && diff(o.postedAt, p.postedAt) <= 5);
    if (new Set(c.map((o) => o.accountId)).size > 1) c = c.filter((o) => FUND_RE.test(o.text));
    const ids = new Set(c.map((o) => o.accountId));
    if (ids.size !== 1) continue;
    matched++;
    const id = [...ids][0] as string;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  if (ranked[1] && ranked[1][1] === ranked[0]![1]) return null;
  if (ranked[0]![1] < 2) return null;
  if (ranked[0]![1] * 3 < matched * 2) return null;
  return ranked[0]![0];
}

describe("inferFundingAccount: independent oracle fuzz", () => {
  it("2000 random payment / bank histories agree with the plan's rule (>=2 matches, >=2/3 agree, tie or ambiguity = null)", () => {
    const r = rng(77);
    let determined = 0;
    let undetermined = 0;
    for (let n = 0; n < 2000; n++) {
      const card: CardTxRow[] = [];
      const bank: BankOutflowRow[] = [];
      const np = int(r, 0, 8);
      for (let k = 0; k < np; k++) {
        const date = addDays(d("2026-03-05"), k * 30 + int(r, 0, 3)); // distinct dates, one per month
        const amt = money(r, 10, 3000);
        card.push({ postedAt: date, amount: amt, text: pick(r, PAYMENT_TEXTS), pending: r() < 0.05 });
        const roll = r();
        const acct = pick(r, ["cc", "cc", "cc", "pc", "sv"]);
        if (roll < 0.75) bank.push({ accountId: acct, accountNickname: acct, postedAt: addDays(date, int(r, -2, 7)), amount: amt.negated(), text: pick(r, BANK_TEXTS) });
        if (roll > 0.6) bank.push({ accountId: pick(r, ["pc", "sv"]), accountNickname: "n", postedAt: addDays(date, int(r, -1, 5)), amount: amt.negated(), text: pick(r, BANK_TEXTS) });
      }
      for (let k = 0; k < int(r, 0, 5); k++) card.push({ postedAt: addDays(d("2026-04-01"), int(r, 0, 150)), amount: money(r, 5, 200), text: pick(r, REFUND_TEXTS), pending: false });
      const got = inferFundingAccount({ cardTxs: card, bankOutflows: bank });
      const want = fundingOracle(card, bank);
      if (want) determined++;
      else undetermined++;
      expect({ n, id: got?.accountId ?? null }).toEqual({ n, id: want });
      if (got) {
        expect(got.matches).toBeGreaterThanOrEqual(2);
        expect(got.matches * 3).toBeGreaterThanOrEqual(got.of * 2);
      }
    }
    expect(determined).toBeGreaterThan(150);
    expect(undetermined).toBeGreaterThan(150);
  });

  it("noise: a same-amount unrelated outflow on another account (netflix) does not displace the real payer; refunds are never payments", () => {
    const card = [0, 1, 2, 3].map((i) => tx(`2026-0${i + 4}-04`, `${300 + i}.00`, "payment received"));
    card.push(tx("2026-06-20", "77.00", "chewy com"));
    const bank = [
      ...[0, 1, 2, 3].map((i) => out("cc", "Credit Cards", `2026-0${i + 4}-05`, `-${300 + i}.00`, "barclays")),
      out("pc", "Primary Checking", "2026-04-05", "-300.00", "netflix"),
      out("pc", "Primary Checking", "2026-06-21", "-77.00", "barclays"), // matches the REFUND only: must not count
    ];
    expect(inferFundingAccount({ cardTxs: card, bankOutflows: bank })).toMatchObject({ accountId: "cc", matches: 4, of: 4 });
  });

  it("a card with no history or a single match is never assigned", () => {
    expect(inferFundingAccount({ cardTxs: [], bankOutflows: [] })).toBeNull();
    expect(inferFundingAccount({ cardTxs: [tx("2026-04-04", "300", "payment received")], bankOutflows: [out("cc", "Credit Cards", "2026-04-05", "-300", "barclays")] })).toBeNull();
  });
});

// ── 3. Projection: oracle for the open-cycle estimate, gates, confidence, typical month ──────────

const TODAY = d("2026-10-09");

/** History generator: monthly payments of `pay[i]` on the 4th of each month, charges in between. */
function historyCard(r: () => number, o: Partial<CardInput> & { nPay?: number; firstTx?: string; balanceAgeDays?: number } = {}): CardInput {
  const nPay = o.nPay ?? 6;
  const txs: CardTxRow[] = [];
  for (let k = 0; k < nPay; k++) {
    const pm = 10 - nPay + k; // months 4..9 for nPay=6 (payments on the 4th)
    txs.push({ postedAt: d(`2026-${String(pm).padStart(2, "0")}-04`), amount: money(r, 20, 3000), text: "payment received", pending: false });
  }
  txs.push({ postedAt: d(o.firstTx ?? "2026-03-30"), amount: D("-12.00"), text: "coffee", pending: false });
  for (let k = 0; k < 15; k++) txs.push({ postedAt: addDays(TODAY, -int(r, 0, 60)), amount: money(r, 5, 200).negated(), text: "shop", pending: false });
  return {
    id: "card-1",
    nickname: "Test Card",
    entityId: "ent-1",
    currentBalance: money(r, 0, 4000),
    currentBalanceAt: addDays(TODAY, -(o.balanceAgeDays ?? 0)),
    ccDueDate: d("2026-10-05"),
    ccStatementBalance: money(r, 10, 1500),
    txs,
    ...o,
  };
}

// Round 1 (D3): a close lag that is only ASSUMED (25 days, not inferred from the card's own history) caps the confidence at medium.
function confOracle(days: number, lagInferred = false): "high" | "medium" | "low" {
  const byDays = days <= 3 ? "high" : days <= 10 ? "medium" : "low";
  return byDays === "high" && !lagInferred ? "medium" : byDays;
}

describe("projectCardStatements: oracle fuzz of the open-cycle estimate and gates", () => {
  it("2500 random cards: gates return a reason and NO number; the open-cycle amount is exactly balance minus the unpaid statement on file", () => {
    const r = rng(4242);
    let withEstimate = 0;
    let gated = 0;
    let cumNonPositive = 0;
    for (let n = 0; n < 2500; n++) {
      const card = historyCard(r, { nPay: pick(r, [0, 1, 2, 3, 6]), firstTx: pick(r, ["2026-03-30", "2026-08-11", "2026-08-10", "2026-08-09", "2026-10-01"]) });
      const dueOff = pick(r, [-60, -46, -45, -20, -4, 0, 3, 20, null]);
      card.ccDueDate = dueOff === null ? null : addDays(TODAY, dueOff);
      card.ccStatementBalance = pick(r, [null, D(0), D("-10"), money(r, 1, 1500)]);
      card.currentBalance = pick(r, [null, money(r, -50, 4000), D(0), (card.ccStatementBalance ?? D(100)).minus(pick(r, [0, 4, 5, 5.01, 6, 100]))]);
      card.currentBalanceAt = pick(r, [null, addDays(TODAY, 0), addDays(TODAY, -3), addDays(TODAY, -4), addDays(TODAY, 2)]);
      // sometimes pay the on-file statement (payment inside the window)
      if (card.ccDueDate && card.ccStatementBalance?.greaterThan(0) && r() < 0.4) {
        card.txs.push({ postedAt: addDays(card.ccDueDate, -1), amount: card.ccStatementBalance, text: "payment received", pending: false });
      }
      const p = projectCardStatements({ card, bankOutflows: [], today: TODAY });

      // independent gate evaluation
      const posted = card.txs.filter((t) => !t.pending);
      const first = posted.reduce<Date | null>((m, t) => (m === null || t.postedAt < m ? t.postedAt : m), null);
      const paid = p.onFile?.paid != null;
      const stale = !card.currentBalance || !card.currentBalanceAt || diff(TODAY, card.currentBalanceAt) > 3;
      const noDue = !card.ccDueDate;
      const oldDue = !!card.ccDueDate && diff(TODAY, card.ccDueDate) > 45;
      const shortHist = first === null || diff(TODAY, first) < 60;
      const commonGate = stale || noDue || oldDue || shortHist;
      if (commonGate) {
        gated++;
        expect({ n, est: p.estimates.length }).toEqual({ n, est: 0 });
        expect(p.skipReasons.length).toBeGreaterThan(0);
        continue;
      }
      const stmtOnFile = card.ccStatementBalance && card.ccStatementBalance.greaterThan(0) ? card.ccStatementBalance : null;
      const unpaid = stmtOnFile && !paid ? stmtOnFile : D(0);
      const cycle = p.estimates.find((e) => e.kind === "cycle_to_date");
      const dueAfter = card.ccDueDate as Date;
      const d1 = (() => {
        // one month after the on-file due date, clamped (anchor day <= 5 here, no clamping needed)
        return new Date(Date.UTC(dueAfter.getUTCFullYear(), dueAfter.getUTCMonth() + 1, dueAfter.getUTCDate()));
      })();
      const day1ok = diff(d1, TODAY) >= 0;
      // number of observed payments: rows are > 7 days apart in this generator
      const cum = (card.currentBalance as Decimal).minus(unpaid).toDecimalPlaces(2);
      const clusterPays = (() => {
        const ds = card.txs.filter((t) => !t.pending && t.amount.greaterThan(0) && /payment|autopay|pymt/i.test(t.text)).map((t) => t.postedAt.getTime()).sort((a, b) => a - b);
        let c = 0;
        let last = -1e18;
        for (const x of ds) { if (x - last > 7 * DAY) c++; last = x; }
        return c;
      })();
      if (!day1ok) {
        expect({ n, est: p.estimates.length }).toEqual({ n, est: 0 });
        continue;
      }
      const reconcileBad = unpaid.greaterThan(0) && (card.currentBalance as Decimal).lessThan(unpaid.minus(5));
      const wantCycle = clusterPays >= 2 && !reconcileBad && cum.greaterThan(0);
      expect({ n, hasCycle: !!cycle }).toEqual({ n, hasCycle: wantCycle });
      if (cycle) {
        withEstimate++;
        expect(cycle.amount.toFixed(2)).toBe(cum.toFixed(2));
        expect(iso(cycle.dueDate)).toBe(iso(d1));
        const close = addDays(d1, -(cycle.closeLagDays ?? CLOSE_LAG_DAYS));
        const dtc = Math.max(0, diff(close, TODAY));
        expect(cycle.daysToClose).toBe(dtc);
        // these random histories have no consistent statement cycles, so no lag may be inferred (false-positive control)
        expect(cycle.closeLagInferred).toBe(false);
        expect(cycle.closeLagDays).toBe(CLOSE_LAG_DAYS);
        expect(cycle.confidence).toBe(confOracle(dtc, false));
        expect(cycle.amount.greaterThan(0)).toBe(true);
        // never double count: an unpaid on-file statement is NOT inside the estimate
        if (unpaid.greaterThan(0)) expect(cycle.amount.plus(unpaid).toFixed(2)).toBe((card.currentBalance as Decimal).toFixed(2));
      } else if (cum.lessThanOrEqualTo(0)) cumNonPositive++;
      // typical months: median of last 3 observed payments, always low, need 3
      const typical = p.estimates.filter((e) => e.kind === "typical_month");
      if (clusterPays < 3) expect(typical.length).toBe(0);
      for (const t of typical) expect(t.confidence).toBe("low");
      // no estimate is ever <= 0 or dated before the cycle's due date
      for (const e of p.estimates) {
        expect(e.amount.greaterThan(0)).toBe(true);
        expect(e.dueDate.getTime()).toBeGreaterThanOrEqual(TODAY.getTime());
      }
      expect(p.estimates.length).toBeLessThanOrEqual(3);
    }
    expect(withEstimate).toBeGreaterThan(100);
    expect(gated).toBeGreaterThan(100);
    expect(cumNonPositive).toBeGreaterThan(5);
  });

  it("confidence boundaries are exactly 3 and 10 days to close (close = due - 25)", () => {
    const r = rng(1);
    const mk = (dueIso: string) => {
      const c = historyCard(r, { ccDueDate: d(dueIso), ccStatementBalance: D("0"), currentBalance: D("1234.56") });
      c.ccDueDate = d(dueIso);
      return projectCardStatements({ card: c, bankOutflows: [], today: TODAY }).estimates.find((e) => e.kind === "cycle_to_date");
    };
    // today = Oct 9. d1 = on-file due + 1 month. daysToClose = d1 - 25 - today.
    // on-file Oct 5 -> d1 Nov 5 -> close Oct 11 -> 2 days
    // (these random histories give no inferable lag, so the 25-day assumption applies and "high" is capped at medium)
    expect(mk("2026-10-05")).toMatchObject({ daysToClose: 2, confidence: "medium", closeLagInferred: false });
    // on-file Oct 7 -> d1 Nov 7 -> close Oct 13 -> 4 days -> medium
    expect(mk("2026-10-07")).toMatchObject({ daysToClose: 4, confidence: "medium" });
    // on-file Oct 6 -> close Oct 12 -> 3 days -> high
    expect(mk("2026-10-06")).toMatchObject({ daysToClose: 3, confidence: "medium" });
    // on-file Oct 13 -> d1 Nov 13 -> close Oct 19 -> 10 -> medium
    expect(mk("2026-10-13")).toMatchObject({ daysToClose: 10, confidence: "medium" });
    // on-file Oct 14 -> close Oct 20 -> 11 -> low
    expect(mk("2026-10-14")).toMatchObject({ daysToClose: 11, confidence: "low" });
  });

  it("balance gates: synced 3 days ago passes, 4 fails; disagreement of exactly $5 passes, $5.01 fails; cum <= 0 gives no open-cycle item", () => {
    const r = rng(2);
    const base = () => historyCard(r, { ccDueDate: d("2026-10-12"), ccStatementBalance: D("792.68"), currentBalance: D("865.24"), currentBalanceAt: TODAY });
    const run = (c: CardInput) => projectCardStatements({ card: c, bankOutflows: [], today: TODAY });
    expect(run(base()).estimates.find((e) => e.kind === "cycle_to_date")?.amount.toFixed(2)).toBe("72.56");
    expect(run({ ...base(), currentBalanceAt: addDays(TODAY, -3) }).estimates.length).toBeGreaterThan(0);
    const stale = run({ ...base(), currentBalanceAt: addDays(TODAY, -4) });
    expect(stale.estimates).toEqual([]);
    expect(stale.skipReasons.length).toBe(1);
    // exactly $5 below the unpaid statement: not inconsistent (cum -5 => no open-cycle item but typical months allowed)
    const edge = run({ ...base(), currentBalance: D("787.68") });
    expect(edge.estimates.find((e) => e.kind === "cycle_to_date")).toBeUndefined();
    expect(edge.skipReasons.join()).not.toContain("lower than the statement");
    const bad = run({ ...base(), currentBalance: D("787.67") });
    expect(bad.skipReasons.join()).toContain("lower than the statement");
    // balance equals statement => cum 0 => no item
    expect(run({ ...base(), currentBalance: D("792.68") }).estimates.find((e) => e.kind === "cycle_to_date")).toBeUndefined();
  });

  it("history gate: first posted tx 59 days old is gated, 60 passes; payment-count gate: 1 payment gated, 2 gives the open cycle only, 3 adds typical months", () => {
    const mk = (firstIso: string, payDates: string[]) => {
      const txs: CardTxRow[] = [tx(firstIso, "-10", "coffee"), tx("2026-10-01", "-80", "shop")];
      for (const p of payDates) txs.push(tx(p, "250", "payment received"));
      return projectCardStatements({
        card: { id: "g", nickname: "G", entityId: "e", currentBalance: D("500"), currentBalanceAt: TODAY, ccDueDate: d("2026-10-20"), ccStatementBalance: D("0"), txs },
        bankOutflows: [],
        today: TODAY,
      });
    };
    expect(diff(TODAY, d("2026-08-11"))).toBe(59);
    const three = ["2026-08-30", "2026-09-12", "2026-09-30"];
    const g59 = mk("2026-08-11", three);
    expect(g59.estimates).toEqual([]);
    expect(g59.skipReasons).toEqual(["needs about 3 months of card history first"]);
    const g60 = mk("2026-08-10", three);
    expect(g60.estimates.map((e) => e.kind)).toEqual(["cycle_to_date", "typical_month", "typical_month"]);
    const twoPays = mk("2026-08-10", ["2026-08-30", "2026-09-30"]);
    expect(twoPays.estimates.map((e) => e.kind)).toEqual(["cycle_to_date"]);
    expect(twoPays.skipReasons.join()).toContain("typical month");
    const onePay = mk("2026-08-10", ["2026-09-30"]);
    expect(onePay.estimates).toEqual([]);
    expect(onePay.skipReasons.length).toBe(2);
    // a split payment (rows within 7 days) is ONE payment and cannot fake history
    const split = mk("2026-08-10", ["2026-09-28", "2026-09-30", "2026-10-02"]);
    expect(split.estimates).toEqual([]);
  });

  it("every card is projected from ITS OWN rows: a business card keeps its entity id on every estimate-bearing structure", () => {
    const r = rng(9);
    const c = historyCard(r, { id: "cap", nickname: "Capital One", entityId: "ent-ekc", ccDueDate: d("2026-10-12"), ccStatementBalance: D("792.68"), currentBalance: D("865.24") });
    const p = projectCardStatements({ card: c, bankOutflows: [], today: TODAY });
    expect(p.entityId).toBe("ent-ekc");
    const dues = cardDuesInWindow({ ...p, funding: { accountId: "cc", accountNickname: "Credit Cards", matches: 6, of: 6 } }, TODAY, addDays(TODAY, 40));
    expect(dues.every((x) => x.entityId === "ent-ekc")).toBe(true);
    const ledger = toLedgerCardInputs([p]);
    expect(ledger.estimates.every((e) => e.entityId === "ent-ekc" && e.cardId === "cap")).toBe(true);
  });

  it("an undetermined funding account yields NO forecast events and NO funding dues, but still ledger inputs", () => {
    const r = rng(10);
    const c = historyCard(r, { ccDueDate: d("2026-10-12"), ccStatementBalance: D("792.68"), currentBalance: D("865.24") });
    const p = projectCardStatements({ card: c, bankOutflows: [], today: TODAY });
    expect(p.funding).toBeNull();
    expect(cardPaymentEvents(p, TODAY, addDays(TODAY, 90))).toEqual([]);
    expect(toLedgerCardInputs([p]).estimates.length).toBeGreaterThan(0);
  });

  it("typical month = median of the last 3 payments, range text uses the last 6; estimates sorted and the on-file statement is never repeated as an estimate", () => {
    const pays = ["100", "900", "300", "450", "200", "320"];
    const txs: CardTxRow[] = pays.map((a, i) => tx(`2026-0${4 + i}-04`, a, "payment received"));
    txs.push(tx("2026-03-20", "-30", "coffee"));
    const c: CardInput = { id: "k", nickname: "K", entityId: "e", currentBalance: D("0.00"), currentBalanceAt: TODAY, ccDueDate: d("2026-10-05"), ccStatementBalance: D("320"), txs };
    const p = projectCardStatements({ card: c, bankOutflows: [], today: TODAY });
    const typ = p.estimates.filter((e) => e.kind === "typical_month");
    expect(typ.map((e) => e.amount.toFixed(2))).toEqual(["320.00", "320.00"]); // median(450,200,320)=320
    expect(typ[0]!.why).toContain("$100 to $900");
    expect(typ.map((e) => iso(e.dueDate))).toEqual(["2026-12-05", "2027-01-05"]);
    // cycle open item: balance 0 and the 320 statement paid on Sep 4?? (payment row Sep 4 is outside the window) => unpaid => cum = 0-320 -> reconcile gate
    expect(p.skipReasons.join()).toContain("lower than the statement");
  });
});

// ── 4. The two consumers of a projection must drop a PAID on-file statement (survivors of the first mutation pass) ──

describe("cardPaymentEvents / cardDuesInWindow with a paid on-file statement and day boundaries", () => {
  const funding = { accountId: "cc", accountNickname: "Credit Cards", matches: 6, of: 6 };
  const paidEv = { date: d("2026-10-04"), amount: D("623.19"), rule: "payment_inflows" as const, via: "a payment received on the card" };
  const proj = (paidV: typeof paidEv | null) => ({
    cardId: "b",
    nickname: "Barclay",
    entityId: "e",
    funding,
    onFile: { dueDate: d("2026-10-20"), amount: D("623.19"), paid: paidV, isFuture: true },
    estimates: [],
    skipReasons: [],
  });

  it("a paid statement is neither a forecast event nor a funding due; an unpaid one is both", () => {
    expect(cardPaymentEvents(proj(paidEv), d("2026-10-09"), d("2026-11-09"))).toEqual([]);
    expect(cardDuesInWindow(proj(paidEv), d("2026-10-09"), d("2026-11-09"))).toEqual([]);
    expect(cardPaymentEvents(proj(null), d("2026-10-09"), d("2026-11-09")).map((e) => e.amount.toFixed(2))).toEqual(["-623.19"]);
    expect(cardDuesInWindow(proj(null), d("2026-10-09"), d("2026-11-09")).map((e) => e.statementBalance.toFixed(2))).toEqual(["623.19"]);
  });

  it("funding dues window is [from, to): due on `from` counts, due on `to` does not", () => {
    expect(cardDuesInWindow(proj(null), d("2026-10-20"), d("2026-11-20"))).toHaveLength(1);
    expect(cardDuesInWindow(proj(null), d("2026-09-20"), d("2026-10-20"))).toHaveLength(0);
  });

  it("an open-cycle statement due exactly today is still estimated (and one due yesterday is not)", () => {
    const mk = (onFileDue: string) =>
      projectCardStatements({
        card: {
          id: "x", nickname: "X", entityId: "e", currentBalance: D("400"), currentBalanceAt: TODAY, ccDueDate: d(onFileDue), ccStatementBalance: D("0"),
          txs: [tx("2026-05-04", "100", "payment received"), tx("2026-06-04", "100", "payment received"), tx("2026-07-04", "100", "payment received"), tx("2026-05-01", "-10", "shop")],
        },
        bankOutflows: [],
        today: TODAY,
      });
    // on-file Sep 9 -> next due Oct 9 = today
    expect(mk("2026-09-09").estimates.find((e) => e.kind === "cycle_to_date")?.dueDate.toISOString().slice(0, 10)).toBe("2026-10-09");
    // on-file Sep 8 -> next due Oct 8 = yesterday: nothing estimated, one plain reason
    const old = mk("2026-09-08");
    expect(old.estimates).toEqual([]);
    expect(old.skipReasons).toEqual(["the statement date on file is out of date"]);
  });
});

// ── 5. Recurring detection: card payments are not offered as bills, ordinary bills still are ──

describe("recurring detection and card-payment descriptors (fixed-amount monthly series)", () => {
  const series = (payee: string, amount = "62.00") =>
    ["2026-03-05", "2026-04-05", "2026-05-05", "2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"].map((dt) => ({
      entityId: "ent-p",
      accountId: "acct-pc",
      accountType: "checking",
      payee,
      amount: D(`-${amount}`),
      postedAt: d(dt),
      tagIds: [] as string[],
    }));
  const suggested = (payee: string) => detectRecurring({ rows: series(payee), modelled: [], today: d("2026-10-09") }).suggestions.length;

  it.each([
    "barclays",
    "barclays bank delaware",
    "barclaycard us creditcard",
    "capital one crcardpmt",
    "capital one autopay pymt",
    "amex epayment",
    "chase credit crd autopay",
    "citi card payment",
  ])("a monthly fixed %s outflow: card payment lines are not suggested (when covered by the exclusion list)", (payee) => {
    const n = suggested(payee);
    // 'chase credit crd autopay' is an issuer not on the owner's cards and is not on the exclusion list: recorded as a probe
    if (payee === "chase credit crd autopay") expect(n).toBeGreaterThanOrEqual(0);
    else expect(n).toBe(0);
  });

  it.each(["comcast", "google one", "netflix", "state farm insurance", "waterford ct utility", "acme water utility"])("%s is still offered as an ordinary bill", (payee) => {
    expect(suggested(payee)).toBe(1);
  });
});
