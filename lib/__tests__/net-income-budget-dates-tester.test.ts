// TESTER (net-income-budget-dates): independent oracles written from the plan's rules (not from the code), seeded
// fuzz, and boundary probes. Pure modules only (no database).
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  resolveNetIncome,
  type DepositRow,
  type IncomeSourceInput,
  type StubRow,
} from "@/lib/net-income";
import {
  buildBudgetScheduleIndex,
  effectiveSchedule,
  generateBillOccurrencesBudgetDated,
  type BillDateBill,
  type BudgetScheduleRow,
} from "@/lib/bill-dates";
import { generateBillOccurrences, perOccurrenceAmount } from "@/lib/forecast";
import { detectRecurring, type TxRow } from "@/lib/recurring-detect";
import type { ModelledRef } from "@/lib/upcoming-ledger";

// ── seeded PRNG ──────────────────────────────────────────────────────────────
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
  return { next, int, pick, chance: (p: number) => next() < p };
}

const DAY = 86400000;
const utc = (y: number, m1: number, d: number) => new Date(Date.UTC(y, m1 - 1, d));
const TODAY = utc(2026, 10, 9);

// ══════════════════════════════════════════════════════════════════════════════
// 1. NET INCOME: oracle fuzz (integer cents; rules from the plan, section 4.1)
// ══════════════════════════════════════════════════════════════════════════════

interface Employer {
  full: string;
  tokens: string[];
  payees: string[];
}
const EMPLOYERS: Employer[] = [
  { full: "Alpine Bio Inc", tokens: ["alpine", "bio"], payees: ["alpine bio inc payroll", "alpine bio payroll", "alpine bio inc"] },
  { full: "Seacoast Mushrooms LLC", tokens: ["seacoast", "mushrooms"], payees: ["seacoast mushroo payroll", "seacoast mushrooms llc payroll"] },
  { full: "Northern Lights Co", tokens: ["northern", "lights"], payees: ["northern lights payroll", "northern light payroll"] },
];
const NOISE_PAYEES = ["venmo", "iaic claim pymt", "irs treas 310 tax ref", "amazon refund", "seacoast bank interest", "alpine animal hospital"];
const STOP = new Set(["inc", "llc", "corp", "co", "the", "ltd", "company", "corporation", "payroll", "and"]);

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function oracleWordMatch(pw: string, ew: string) {
  return pw === ew || (pw.length >= 5 && ew.startsWith(pw));
}
function oracleHasAll(text: string, tokens: string[]) {
  const ws = words(text);
  return tokens.length > 0 && tokens.every((t) => ws.some((w) => oracleWordMatch(w, t)));
}
const cents = (d: Decimal) => d.times(100).toNumber();
const dec = (c: number) => new Decimal(c).div(100);

interface OSrc extends IncomeSourceInput {
  emp: Employer;
  grossC: number;
}
interface ODep extends DepositRow {
  c: number;
}

function oracle(src: OSrc, deps: ODep[], stubs: StubRow[], today: Date) {
  const tokens = words(src.description.replace(/^[^(]*\(/, "").replace(/\).*$/, "")).filter((w) => !STOP.has(w));
  const grossC = src.grossC;
  const matched = deps
    .filter(
      (d) =>
        d.accountId === src.accountId &&
        d.entityId === src.entityId &&
        d.c > 0 &&
        d.payee != null &&
        oracleHasAll(d.payee, tokens) &&
        d.c * 100 <= grossC * 105 &&
        d.c * 100 >= grossC * 25
    )
    .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
  const cycle = src.cadence === "weekly" ? 7 : src.cadence === "biweekly" ? 14 : src.cadence === "semi_monthly" ? 15.2 : 30.4;
  const limit = Math.max(45, Math.ceil(cycle * 2.5));
  const age = matched[0] ? Math.round((today.getTime() - matched[0].postedAt.getTime()) / DAY) : 9999;
  if (matched.length >= 3 && age <= limit) {
    const used = matched.slice(0, 6).map((d) => d.c).sort((a, b) => a - b);
    const n = used.length;
    const medTimes2 = n % 2 === 1 ? used[(n - 1) / 2]! * 2 : used[n / 2 - 1]! + used[n / 2]!;
    const net = n % 2 === 1 ? used[(n - 1) / 2]! : Math.floor((used[n / 2 - 1]! + used[n / 2]! + 1) / 2);
    const variable = (used[n - 1]! - used[0]!) * 2 * 20 > medTimes2;
    return { basis: "deposits" as const, netC: net, samples: n, variable, min: used[0]!, max: used[n - 1]! };
  }
  const okStubs = stubs
    .filter((s) => {
      if (s.netPayCents == null || s.netPayCents <= 0) return false;
      if (s.grossPayCents == null || s.grossPayCents <= 0) return false;
      if (Math.abs(s.grossPayCents - grossC) * 100 > grossC) return false;
      if (s.depositAccountId != null && s.depositAccountId !== src.accountId) return false;
      const empOk = s.employerName != null && oracleHasAll(s.employerName, tokens);
      const freqOk = s.payFrequency === src.cadence;
      return empOk || freqOk;
    })
    .sort((a, b) => (b.payDate?.getTime() ?? 0) - (a.payDate?.getTime() ?? 0));
  if (okStubs[0]) return { basis: "paystub" as const, netC: okStubs[0].netPayCents!, samples: 1, variable: false, min: null, max: null };
  return { basis: "gross_unknown" as const, netC: grossC, samples: 0, variable: false, min: null, max: null };
}

function genScenario(r: ReturnType<typeof rng>) {
  const nSrc = r.int(1, 3);
  const emps = [...EMPLOYERS].sort(() => r.next() - 0.5).slice(0, nSrc);
  const accts = ["A1", "A2"];
  const ents = ["E1", "E2"];
  const sources: OSrc[] = emps.map((emp, i) => {
    const grossC = r.int(100000, 1200000);
    const cadence = r.pick(["weekly", "biweekly", "semi_monthly", "monthly"] as const);
    return {
      id: `s${i}`,
      accountId: r.pick(accts),
      entityId: r.pick(ents),
      description: `payroll (${emp.full})`,
      cadence,
      dayRules: {},
      amount: dec(grossC),
      active: true,
      emp,
      grossC,
    };
  });
  const deps: ODep[] = [];
  for (const s of sources) {
    const base = Math.floor(s.grossC * (0.55 + r.next() * 0.4));
    const n = r.int(0, 9);
    for (let k = 0; k < n; k++) {
      const c = r.chance(0.2) ? Math.floor(base * (0.8 + r.next() * 0.4)) : base + r.int(-300, 300);
      deps.push({
        c,
        amount: dec(c),
        postedAt: new Date(TODAY.getTime() - r.int(0, 140) * DAY),
        payee: r.pick(s.emp.payees),
        accountId: r.chance(0.9) ? s.accountId : r.pick(accts),
        entityId: r.chance(0.95) ? s.entityId : r.pick(ents),
      });
    }
    // boundary amounts
    if (r.chance(0.3)) {
      for (const c of [Math.floor((s.grossC * 105) / 100), Math.floor((s.grossC * 105) / 100) + 1, Math.ceil((s.grossC * 25) / 100), Math.ceil((s.grossC * 25) / 100) - 1]) {
        deps.push({ c, amount: dec(c), postedAt: new Date(TODAY.getTime() - r.int(0, 20) * DAY), payee: r.pick(s.emp.payees), accountId: s.accountId, entityId: s.entityId });
      }
    }
  }
  for (let k = 0; k < r.int(0, 12); k++) {
    const c = r.chance(0.2) ? -r.int(1000, 90000) : r.int(1000, 200000);
    deps.push({ c, amount: dec(c), postedAt: new Date(TODAY.getTime() - r.int(0, 140) * DAY), payee: r.chance(0.1) ? null : r.pick(NOISE_PAYEES), accountId: r.pick(accts), entityId: r.pick(ents) });
  }
  // dedupe dates per (source) is not required: ties do not affect a median of amounts, only the newest-date check.
  const stubs: StubRow[] = [];
  for (let k = 0; k < r.int(0, 4); k++) {
    const s = r.pick(sources);
    stubs.push({
      employerName: r.chance(0.7) ? s.emp.full : r.chance(0.5) ? null : "Someone Else Inc",
      payDate: new Date(TODAY.getTime() - (k * 14 + r.int(0, 5) + 1) * DAY * 3),
      payFrequency: r.chance(0.6) ? s.cadence : r.pick(["weekly", "monthly", null]),
      grossPayCents: r.chance(0.7) ? s.grossC + (r.chance(0.5) ? 0 : r.int(-2 * Math.floor(s.grossC / 100), 2 * Math.floor(s.grossC / 100))) : r.chance(0.5) ? null : r.int(1000, 900000),
      netPayCents: r.chance(0.85) ? Math.floor(s.grossC * (0.6 + r.next() * 0.3)) : r.pick([null, 0]),
      depositAccountId: r.chance(0.6) ? null : r.pick(accts),
    });
  }
  // make payDates unique
  stubs.forEach((st, i) => (st.payDate = new Date(utc(2026, 9, 28).getTime() - i * DAY * 7)));
  return { sources, deps, stubs };
}

describe("net income: independent oracle fuzz", () => {
  it("1,500 random households: basis, net, samples, variable and range equal the plan-derived oracle", () => {
    const r = rng(20261009);
    let deposits = 0;
    let stubsUsed = 0;
    let gross = 0;
    for (let i = 0; i < 1500; i++) {
      const { sources, deps, stubs } = genScenario(r);
      for (const s of sources) {
        const want = oracle(s, deps, stubs, TODAY);
        const got = resolveNetIncome(s, deps, stubs, TODAY);
        const ctx = `iter ${i} src ${s.id} ${s.cadence}`;
        expect(got.basis, ctx).toBe(want.basis);
        expect(cents(got.net), ctx).toBe(want.netC);
        expect(got.samples, ctx).toBe(want.samples);
        expect(got.variable, ctx).toBe(want.variable);
        expect(got.assumption, ctx).toBe(want.basis === "gross_unknown");
        if (want.min != null) {
          expect(cents(got.min!), ctx).toBe(want.min);
          expect(cents(got.max!), ctx).toBe(want.max);
        }
        // never silently gross: gross is only ever used with the flag and the words in the label
        if (got.basis === "gross_unknown") {
          expect(got.label).toContain("take-home unknown");
          gross++;
        }
        if (got.basis === "deposits") deposits++;
        if (got.basis === "paystub") stubsUsed++;
        // gross is carried unchanged, exactly
        expect(got.gross.toFixed(2)).toBe(dec(s.grossC).toFixed(2));
        // the net is never above 105% of gross unless it IS the gross fallback
        if (got.basis !== "gross_unknown") expect(got.net.lessThanOrEqualTo(got.gross.times("1.05"))).toBe(true);
      }
    }
    // the fuzz must exercise all three branches or it proves nothing
    expect(deposits).toBeGreaterThan(300);
    expect(stubsUsed).toBeGreaterThan(30);
    expect(gross).toBeGreaterThan(100);
  });

  it("two sources sharing ONE account and entity never take each other's deposits (shuffled inputs)", () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const a = EMPLOYERS[0]!;
      const b = EMPLOYERS[1]!;
      const mk = (id: string, e: Employer, g: number): IncomeSourceInput => ({ id, accountId: "A1", entityId: "E1", description: `payroll (${e.full})`, cadence: "biweekly", dayRules: {}, amount: dec(g), active: true });
      const sa = mk("a", a, 900000);
      const sb = mk("b", b, 255500);
      const deps: DepositRow[] = [];
      const aAmts: number[] = [];
      const bAmts: number[] = [];
      for (let k = 0; k < 8; k++) {
        const ca = 600000 + r.int(0, 50) ;
        const cb = 190000 + r.int(0, 60000);
        aAmts.push(ca);
        bAmts.push(cb);
        deps.push({ amount: dec(ca), postedAt: new Date(TODAY.getTime() - k * 14 * DAY), payee: r.pick(a.payees), accountId: "A1", entityId: "E1" });
        deps.push({ amount: dec(cb), postedAt: new Date(TODAY.getTime() - (k * 14 + 2) * DAY), payee: r.pick(b.payees), accountId: "A1", entityId: "E1" });
      }
      deps.sort(() => r.next() - 0.5);
      const ra = resolveNetIncome(sa, deps, [], TODAY);
      const rb = resolveNetIncome(sb, deps, [], TODAY);
      const med = (xs: number[]) => {
        const s = xs.slice(0, 6).sort((x, y) => x - y);
        return Math.floor((s[2]! + s[3]! + 1) / 2);
      };
      expect(cents(ra.net)).toBe(med(aAmts));
      expect(cents(rb.net)).toBe(med(bAmts));
      expect(ra.samples).toBe(6);
      expect(rb.samples).toBe(6);
    }
  });
});

describe("net income: boundaries", () => {
  const src = (over: Partial<IncomeSourceInput> = {}): IncomeSourceInput => ({
    id: "s",
    accountId: "A1",
    entityId: "E1",
    description: "payroll (Alpine Bio Inc)",
    cadence: "semi_monthly",
    dayRules: { daysOfMonth: [15, 31] },
    amount: "9000.00",
    active: true,
    ...over,
  });
  const dep = (amt: string, daysAgo: number, payee = "alpine bio inc payroll"): DepositRow => ({
    amount: new Decimal(amt),
    postedAt: new Date(TODAY.getTime() - daysAgo * DAY),
    payee,
    accountId: "A1",
    entityId: "E1",
  });

  it("a half-cent median rounds half up (100.01 and 100.02 -> 100.02), never float", () => {
    const r = resolveNetIncome(src({ amount: "150.00" }), [dep("100.01", 1), dep("100.02", 15), dep("100.01", 30), dep("100.02", 45)], [], TODAY);
    expect(r.net.toFixed(2)).toBe("100.02");
  });

  it("the stale boundary: newest deposit exactly 45 days old is used for a semi-monthly source, 46 is not", () => {
    const mkd = (age: number) => [dep("6064.85", age), dep("6064.86", age + 15), dep("6064.87", age + 30)];
    expect(resolveNetIncome(src(), mkd(45), [], TODAY).basis).toBe("deposits");
    expect(resolveNetIncome(src(), mkd(46), [], TODAY).basis).toBe("gross_unknown");
    // monthly source: 2.5 cycles = 76 days
    expect(resolveNetIncome(src({ cadence: "monthly", dayRules: { dayOfMonth: 1 } }), mkd(76), [], TODAY).basis).toBe("deposits");
    expect(resolveNetIncome(src({ cadence: "monthly", dayRules: { dayOfMonth: 1 } }), mkd(77), [], TODAY).basis).toBe("gross_unknown");
  });

  it("exactly 3 deposits is enough, 2 is not; a 7th-newest deposit is ignored (window of 6)", () => {
    expect(resolveNetIncome(src(), [dep("6000", 1), dep("6000", 16), dep("6000", 31)], [], TODAY).basis).toBe("deposits");
    expect(resolveNetIncome(src(), [dep("6000", 1), dep("6000", 16)], [], TODAY).basis).toBe("gross_unknown");
    const seven = [1, 2, 3, 4, 5, 6].map((k) => dep("6000", k * 10)).concat([dep("1", 70)]);
    const r = resolveNetIncome(src(), seven, [], TODAY);
    expect(r.samples).toBe(6);
    expect(r.min!.toFixed(2)).toBe("6000.00");
  });

  it("the sanity band is inclusive: exactly 105% and exactly 25% of gross count, a cent beyond does not", () => {
    const g = src({ amount: "1000.00", cadence: "biweekly", dayRules: { anchorDate: "2026-08-28" } });
    const ok = [dep("1050.00", 1), dep("250.00", 15), dep("900.00", 29)];
    expect(resolveNetIncome(g, ok, [], TODAY).samples).toBe(3);
    const bad = [dep("1050.01", 1), dep("249.99", 15), dep("900.00", 29)];
    expect(resolveNetIncome(g, bad, [], TODAY).basis).toBe("gross_unknown");
  });

  it("the paystub gross tolerance is 1% inclusive; frequency OR employer must agree", () => {
    const stub = (gross: number, over: Partial<StubRow> = {}): StubRow => ({
      employerName: "Alpine Bio Inc",
      payDate: utc(2026, 9, 28),
      payFrequency: "semi_monthly",
      grossPayCents: gross,
      netPayCents: 606485,
      depositAccountId: null,
      ...over,
    });
    expect(resolveNetIncome(src(), [], [stub(900000)], TODAY).basis).toBe("paystub");
    expect(resolveNetIncome(src(), [], [stub(909000)], TODAY).basis).toBe("paystub"); // +1.0000%
    expect(resolveNetIncome(src(), [], [stub(909001)], TODAY).basis).toBe("gross_unknown"); // just over
    expect(resolveNetIncome(src(), [], [stub(891000)], TODAY).basis).toBe("paystub"); // -1.0000%
    expect(resolveNetIncome(src(), [], [stub(890999)], TODAY).basis).toBe("gross_unknown");
    // neither employer nor frequency matches -> not used
    expect(resolveNetIncome(src(), [], [stub(900000, { employerName: "Other Co", payFrequency: "weekly" })], TODAY).basis).toBe("gross_unknown");
    // employer matches but the stub says a different frequency: still used today (observation recorded in the report)
    expect(resolveNetIncome(src(), [], [stub(900000, { payFrequency: "monthly" })], TODAY).basis).toBe("paystub");
  });

  it("an unconfirmed-looking stub (net 0 / null) never produces a zero paycheck", () => {
    const s: StubRow = { employerName: "Alpine Bio Inc", payDate: utc(2026, 9, 28), payFrequency: "semi_monthly", grossPayCents: 900000, netPayCents: 0, depositAccountId: null };
    const r = resolveNetIncome(src(), [], [s], TODAY);
    expect(r.basis).toBe("gross_unknown");
    expect(r.net.toFixed(2)).toBe("9000.00");
  });

  it("a zero-gross source never divides by zero and never throws", () => {
    const r = resolveNetIncome(src({ amount: "0" }), [dep("100", 1), dep("100", 16), dep("100", 31)], [], TODAY);
    expect(["deposits", "gross_unknown"]).toContain(r.basis);
  });

  it("the truncation prefix boundary: a 4-letter payee fragment of an employer word does not match, a 5-letter one does", () => {
    const s = src({ description: "payroll (Seacoast Mushrooms LLC)", amount: "2555.00" });
    const four = [1, 16, 31].map((d) => dep("2000", d, "seacoast mush payroll"));
    const five = [1, 16, 31].map((d) => dep("2000", d, "seacoast mushr payroll"));
    expect(resolveNetIncome(s, four, [], TODAY).basis).toBe("gross_unknown");
    expect(resolveNetIncome(s, five, [], TODAY).basis).toBe("deposits");
  });

  it("variable is strictly above 5%: a spread of exactly 5% of the median is NOT variable, one cent more is", () => {
    const s = src({ cadence: "biweekly", dayRules: { anchorDate: "2026-08-28" }, amount: "2000.00" });
    const exact = [dep("975.00", 1), dep("1000.00", 15), dep("1025.00", 29)];
    expect(resolveNetIncome(s, exact, [], TODAY).variable).toBe(false);
    const over = [dep("975.00", 1), dep("1000.00", 15), dep("1025.01", 29)];
    expect(resolveNetIncome(s, over, [], TODAY).variable).toBe(true);
    // the label wording follows the flag
    expect(resolveNetIncome(s, exact, [], TODAY).label).toBe("take-home $1,000.00, from your last 3 deposits");
    expect(resolveNetIncome(s, over, [], TODAY).label).toBe("about $1,000.00 take-home (usually $975.00 to $1,025.01), median of your last 3 deposits");
  });

  it("a payee that merely STARTS with the employer's first word does not match when another employer word is absent", () => {
    const r = resolveNetIncome(src(), [dep("6000", 1, "alpine animal hospital"), dep("6000", 16, "alpine animal hospital"), dep("6000", 31, "alpine animal hospital")], [], TODAY);
    expect(r.basis).toBe("gross_unknown");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. BUDGET-DATED BILLS: independent day-by-day oracle
// ══════════════════════════════════════════════════════════════════════════════

const KEY_E = "E1";
const KEY_T = "T1";
const periodOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const dim = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

function genRows(r: ReturnType<typeof rng>, freq: string, periods: string[]): BudgetScheduleRow[] {
  const rows: BudgetScheduleRow[] = [];
  for (const period of periods) {
    if (r.chance(0.25)) continue; // no Budget row
    const sameFreq = r.chance(0.8);
    const frequency = sameFreq ? freq : r.pick(["monthly", "weekly", "biweekly", "annual", "semiannual"].filter((f) => f !== freq));
    rows.push({
      entityId: KEY_E,
      tagId: KEY_T,
      period,
      payDay: r.chance(0.15) ? null : r.int(1, 31),
      frequency,
      payDayOfWeek: r.chance(0.15) ? null : r.int(0, 6),
      biweeklyAnchorDate: r.chance(0.15) ? null : utc(2026, r.int(1, 12), r.int(1, 28)),
      payMonth: r.chance(0.15) ? null : r.int(1, 12),
      annualAmountDue: null,
    });
  }
  return rows;
}

function rowUsable(row: BudgetScheduleRow | undefined, freq: string, hasAnnualBudget: boolean) {
  if (!row || row.frequency !== freq) return false;
  const dayOk = row.payDay != null && row.payDay >= 1 && row.payDay <= 31;
  if (freq === "annual" || freq === "semiannual") return hasAnnualBudget && dayOk && row.payMonth != null && row.payMonth >= 1 && row.payMonth <= 12;
  if (freq === "weekly") return row.payDayOfWeek != null;
  if (freq === "biweekly") return row.biweeklyAnchorDate != null;
  return dayOk;
}

describe("bill dates: day-by-day oracle over random Budget rows (monthly / weekly / biweekly / annual / semiannual)", () => {
  it("1,200 random bills x random windows (up to 400 days): dates AND amounts equal the oracle", () => {
    const r = rng(424242);
    let usedBudget = 0;
    let mixedMonths = 0;
    for (let i = 0; i < 1200; i++) {
      const freq = r.pick(["monthly", "monthly", "weekly", "biweekly", "annual", "semiannual"] as const);
      const lump = freq === "annual" || freq === "semiannual";
      const from = new Date(utc(2026, r.int(1, 12), r.int(1, 28)).getTime());
      const to = new Date(from.getTime() + r.int(1, 400) * DAY);
      const periods: string[] = [];
      for (let t = utc(from.getUTCFullYear(), from.getUTCMonth() + 1, 1); t < to; t = utc(t.getUTCFullYear(), t.getUTCMonth() + 2, 1)) periods.push(periodOf(t));
      const rows = genRows(r, freq, periods);
      const bill: BillDateBill = {
        id: "b",
        accountId: "acct",
        payee: "Bill",
        amountType: "static",
        expectedAmount: r.chance(0.9) ? dec(r.int(1000, 900000)) : null,
        autopayDay: r.chance(0.1) ? null : r.int(1, 31),
        annualBudget: lump && r.chance(0.85) ? dec(r.int(10000, 900000)) : null,
        frequency: freq,
        payDayOfWeek: r.chance(0.1) ? null : r.int(0, 6),
        biweeklyAnchorDate: utc(2026, r.int(1, 12), r.int(1, 28)),
        payMonth: r.chance(0.1) ? null : r.int(1, 12),
        entityId: KEY_E,
        budgetTagId: KEY_T,
        budgetEntityId: KEY_E,
      };
      const index = buildBudgetScheduleIndex(rows);
      const got = generateBillOccurrencesBudgetDated(bill, index, from, to, []);
      const byPeriod = new Map(rows.map((x) => [x.period, x]));

      // Oracle: walk every day of the window.
      const want: { iso: string; amt: string }[] = [];
      const perAmt = (): Decimal | null => {
        if (lump) return bill.annualBudget == null ? null : new Decimal(String(bill.annualBudget)).negated();
        return bill.expectedAmount == null ? null : perOccurrenceAmount(new Decimal(String(bill.expectedAmount)), freq).negated();
      };
      const amt = perAmt();
      for (let t = from.getTime(); t < to.getTime(); t += DAY) {
        const d = new Date(t);
        const per = periodOf(d);
        const row = byPeriod.get(per);
        const useRow = rowUsable(row, freq, bill.annualBudget != null);
        if (useRow) usedBudget++;
        const day = useRow ? row!.payDay : bill.autopayDay;
        const dow = useRow ? row!.payDayOfWeek : bill.payDayOfWeek;
        const anchor = useRow ? row!.biweeklyAnchorDate! : bill.biweeklyAnchorDate!;
        const pm = useRow ? row!.payMonth : bill.payMonth;
        let hit = false;
        if (freq === "monthly") hit = d.getUTCDate() === Math.min(day ?? 1, dim(d.getUTCFullYear(), d.getUTCMonth()));
        else if (freq === "weekly") hit = d.getUTCDay() === (dow ?? 1);
        else if (freq === "biweekly") hit = Math.round((t - new Date(anchor).getTime()) / DAY) % 14 === 0;
        else {
          if (pm != null && day != null) {
            const months = freq === "annual" ? [pm] : [pm, ((pm - 1 + 6) % 12) + 1];
            hit = months.includes(d.getUTCMonth() + 1) && d.getUTCDate() === Math.min(day, dim(d.getUTCFullYear(), d.getUTCMonth()));
          }
        }
        if (hit && amt && !amt.isZero()) want.push({ iso: d.toISOString().slice(0, 10), amt: amt.toFixed(2) });
      }
      if (rows.some((x) => rowUsable(x, freq, bill.annualBudget != null)) && rows.some((x) => !rowUsable(x, freq, bill.annualBudget != null))) mixedMonths++;
      expect(got.map((e) => ({ iso: e.date.toISOString().slice(0, 10), amt: e.amount.toFixed(2) })), `iter ${i} ${freq} ${from.toISOString()}..${to.toISOString()}`).toEqual(want);
      // events ascending, UTC midnight, all inside the window
      for (const e of got) {
        expect(e.date.getTime() % DAY).toBe(0);
        expect(e.date >= from && e.date < to).toBe(true);
      }
    }
    expect(usedBudget).toBeGreaterThan(1000);
    expect(mixedMonths).toBeGreaterThan(100);
  });

  it("splitting a window anywhere gives the same events as the whole window (no gap, no duplicate) for anchored schedules", () => {
    const r = rng(99);
    for (let i = 0; i < 400; i++) {
      const freq = r.pick(["monthly", "weekly", "biweekly", "annual", "semiannual"] as const);
      const lump = freq === "annual" || freq === "semiannual";
      const from = utc(2026, r.int(1, 12), r.int(1, 28));
      const to = new Date(from.getTime() + r.int(5, 300) * DAY);
      const mid = new Date(from.getTime() + r.int(1, Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY) - 1)) * DAY);
      const periods: string[] = [];
      for (let t = utc(from.getUTCFullYear(), from.getUTCMonth() + 1, 1); t < to; t = utc(t.getUTCFullYear(), t.getUTCMonth() + 2, 1)) periods.push(periodOf(t));
      const bill: BillDateBill = {
        id: "b", accountId: "a", payee: "p", amountType: "static", expectedAmount: "100", autopayDay: r.int(1, 31),
        annualBudget: lump ? "1200" : null, frequency: freq, payDayOfWeek: r.int(0, 6), biweeklyAnchorDate: utc(2026, 1, 7), payMonth: r.int(1, 12),
        entityId: KEY_E, budgetTagId: KEY_T, budgetEntityId: KEY_E,
      };
      const index = buildBudgetScheduleIndex(genRows(r, freq, periods));
      const whole = generateBillOccurrencesBudgetDated(bill, index, from, to).map((e) => e.date.getTime());
      const parts = [...generateBillOccurrencesBudgetDated(bill, index, from, mid), ...generateBillOccurrencesBudgetDated(bill, index, mid, to)].map((e) => e.date.getTime());
      expect(parts, `iter ${i} ${freq}`).toEqual(whole);
    }
  });

  it("empty index, untagged bill, or another category's rows == the plain generator, byte for byte", () => {
    const r = rng(5);
    for (let i = 0; i < 300; i++) {
      const freq = r.pick(["monthly", "weekly", "biweekly", "annual", "semiannual"] as const);
      const lump = freq === "annual" || freq === "semiannual";
      const from = utc(2026, r.int(1, 12), r.int(1, 28));
      const to = new Date(from.getTime() + r.int(1, 200) * DAY);
      const bill: BillDateBill = {
        id: "b", accountId: "a", payee: "p", amountType: r.pick(["static", "fluctuating"]), expectedAmount: "123.45", autopayDay: r.int(1, 31),
        annualBudget: lump ? "999.99" : null, frequency: freq, payDayOfWeek: r.int(0, 6), biweeklyAnchorDate: utc(2026, 2, 3), payMonth: r.int(1, 12),
        entityId: KEY_E, budgetTagId: KEY_T, budgetEntityId: KEY_E,
      };
      const plain = generateBillOccurrences(bill, from, to, []);
      const other = buildBudgetScheduleIndex(genRows(r, freq, ["2026-10", "2026-11", "2026-12"]).map((x) => ({ ...x, tagId: "OTHER" })));
      const untagged = { ...bill, budgetTagId: null };
      for (const ev of [generateBillOccurrencesBudgetDated(bill, new Map(), from, to), generateBillOccurrencesBudgetDated(bill, other, from, to), generateBillOccurrencesBudgetDated(untagged, buildBudgetScheduleIndex(genRows(r, freq, ["2026-10"])), from, to)]) {
        expect(ev.map((e) => [e.date.getTime(), e.amount.toFixed(2)])).toEqual(plain.map((e) => [e.date.getTime(), e.amount.toFixed(2)]));
      }
    }
  });

  it("a different payDay in each of three months across one 90-day window (Solar-shaped, day 31 clamps, leap year Feb)", () => {
    const bill: BillDateBill = { id: "s", accountId: "a", payee: "Solar", amountType: "static", expectedAmount: "505.70", autopayDay: 17, annualBudget: null, frequency: "monthly", entityId: KEY_E, budgetTagId: KEY_T, budgetEntityId: KEY_E };
    const row = (period: string, payDay: number | null): BudgetScheduleRow => ({ entityId: KEY_E, tagId: KEY_T, period, payDay, frequency: "monthly", payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null });
    const idx = buildBudgetScheduleIndex([row("2027-01", 14), row("2027-02", 31), row("2027-03", 5), row("2028-02", 30)]);
    const ev = generateBillOccurrencesBudgetDated(bill, idx, utc(2027, 1, 1), utc(2027, 4, 1));
    expect(ev.map((e) => e.date.toISOString().slice(0, 10))).toEqual(["2027-01-14", "2027-02-28", "2027-03-05"]);
    const leap = generateBillOccurrencesBudgetDated(bill, idx, utc(2028, 2, 1), utc(2028, 3, 1));
    expect(leap.map((e) => e.date.toISOString().slice(0, 10))).toEqual(["2028-02-29"]);
    for (const e of ev) expect(e.amount.toFixed(2)).toBe("-505.70");
  });

  it("effectiveSchedule never reports a budget basis for a row that is not usable", () => {
    const r = rng(11);
    for (let i = 0; i < 500; i++) {
      const freq = r.pick(["monthly", "weekly", "biweekly", "annual", "semiannual"] as const);
      const lump = freq === "annual" || freq === "semiannual";
      const bill: BillDateBill = { id: "b", accountId: "a", payee: "p", amountType: "static", expectedAmount: "1", autopayDay: 3, annualBudget: lump && r.chance(0.5) ? "10" : null, frequency: freq, entityId: KEY_E, budgetTagId: KEY_T, budgetEntityId: KEY_E };
      const rows = genRows(r, freq, ["2026-10"]);
      const eff = effectiveSchedule(bill, buildBudgetScheduleIndex(rows), "2026-10");
      const usable = rowUsable(rows[0], freq, bill.annualBudget != null);
      expect(eff.basis === "budget").toBe(usable);
      if (!usable) expect(eff.fields.autopayDay).toBe(3);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. LATE FLAG floor: monotonic property (a due-day floor can only DELAY a flag)
// ══════════════════════════════════════════════════════════════════════════════

describe("late flag floor: never earlier than the observed-day rule, never before due + grace", () => {
  const mk = (day: number, n = 6): TxRow[] =>
    Array.from({ length: n }, (_, i) => ({
      entityId: "E1",
      accountId: "A1",
      accountType: "checking",
      payee: "solar",
      amount: new Decimal(-200),
      postedAt: utc(2026, 4 + i, day),
      tagIds: [],
    }));
  const ref = (day: number | null): ModelledRef => ({
    source: "scheduled_bill",
    sourceId: "r",
    entityId: "E1",
    accountId: null,
    label: "Solar",
    direction: "outflow",
    tagKey: null,
    monthly: new Decimal(200),
    day,
    cadence: "monthly",
    expectedAmount: null,
  });
  const flagged = (rows: TxRow[], today: Date, day: number | null) => detectRecurring({ rows, modelled: [ref(day)], today }).flags.some((f) => f.type === "late" && f.modelled !== null);

  it("for every observed day and due day in 1..28, the FIRST flagged day with a due-day floor is never earlier than without it", () => {
    // (The floor shifts the whole 5..25-day flag window later, so a day inside the shifted tail can be flagged with the
    // floor and not without it; what must never happen is the flag STARTING earlier.)
    const first = (rows: TxRow[], day: number | null) => {
      for (let t = utc(2026, 10, 1).getTime(); t < utc(2026, 12, 20).getTime(); t += DAY) if (flagged(rows, new Date(t), day)) return t;
      return Infinity;
    };
    let compared = 0;
    for (let observed = 1; observed <= 28; observed += 3) {
      const rows = mk(observed);
      const base = first(rows, null);
      for (let due = 1; due <= 28; due += 2) {
        const f = first(rows, due);
        if (Number.isFinite(base) && Number.isFinite(f)) {
          expect(f, `observed ${observed} due ${due}`).toBeGreaterThanOrEqual(base);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it("when the due day is 1-7 days after the observed day, nothing is flagged before due + 5 days", () => {
    for (const [observed, due] of [[14, 20], [10, 17], [3, 5], [20, 27]] as const) {
      const rows = mk(observed);
      for (let dd = due; dd < due + 5 && dd <= 31; dd++) {
        expect(flagged(rows, utc(2026, 10, dd), due), `observed ${observed} due ${due} Oct ${dd}`).toBe(false);
      }
    }
  });

  it("due 14, clears 17: not flagged on the 15th, 16th, 20th or 21st; flagged on the 23rd (observed 17 + grace 5 + 1)", () => {
    const rows = mk(17);
    for (const dd of [15, 16, 20, 21]) expect(flagged(rows, utc(2026, 10, dd), 14)).toBe(false);
    expect(flagged(rows, utc(2026, 10, 23), 14)).toBe(true);
  });
});
