// TESTER-authored tests: suppression, late / amount-change / history-differs flag boundaries, month-end handling
// (pipeline task: recurring-detection). Expected values are derived from the plan (section 5.5 / 5.6), not from
// the implementation. RD_MUT points the mutation runner at a mutated copy of lib/recurring-detect.ts.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import type * as RD from "@/lib/recurring-detect";
import type { ModelledRef } from "@/lib/upcoming-ledger";

const modPath = process.env.RD_MUT ?? "@/lib/recurring-detect";
const mod = (await import(/* @vite-ignore */ modPath)) as typeof RD;
const { detectRecurring, circularDays, cycleDates } = mod;

const DAY = 86_400_000;
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function mk(payee: string, dates: string[], amount: number | string | (number | string)[], o: Partial<RD.TxRow> = {}): RD.TxRow[] {
  return dates.map((d, i) => ({
    entityId: "E1",
    accountId: "A1",
    accountType: "checking",
    payee,
    amount: new Decimal(Array.isArray(amount) ? (amount[i] as number | string) : amount).negated(),
    postedAt: D(d),
    tagIds: [],
    ...o,
  }));
}
const months = (y: number, m0: number, n: number, day: number) => Array.from({ length: n }, (_, i) => iso(Date.UTC(y, m0 + i, day)));
const ref = (o: Partial<ModelledRef> & Pick<ModelledRef, "label">): ModelledRef => ({
  source: "scheduled_bill",
  sourceId: `ref-${o.label}`,
  entityId: "E1",
  accountId: null,
  direction: "outflow",
  tagKey: null,
  monthly: null,
  day: null,
  cadence: "monthly",
  expectedAmount: null,
  ...o,
});
const run = (rows: RD.TxRow[], today: string, modelled: ModelledRef[] = []) => detectRecurring({ rows, modelled, today: D(today) });

describe("suppression (plan 5.5)", () => {
  const rows = (tagged: number, total = 6) =>
    mk("zzyzx widgets", months(2026, 3, total, 10), 40).map((r, i) => ({ ...r, tagIds: i < tagged ? ["T1"] : [] }));
  it("tag rule: at least half of the rows carry the modelled tag; fewer does not suppress", () => {
    const m = [ref({ label: "Unrelated Label", tagKey: "E1|T1" })];
    expect(run(rows(3), "2026-10-08", m).suppressed[0]?.suppressedBy?.kind).toBe("tag");
    expect(run(rows(2), "2026-10-08", m).suggestions).toHaveLength(1);
  });
  it("tag key is entity-scoped: the same tag id in another entity never suppresses", () => {
    const m = [ref({ label: "Unrelated Label", tagKey: "E2|T1", entityId: "E2" })];
    expect(run(rows(6), "2026-10-08", m).suggestions).toHaveLength(1);
  });
  it("name rule: a shared distinctive word suppresses; stop words alone do not", () => {
    expect(run(mk("comcast", months(2026, 3, 6, 10), 70), "2026-10-08", [ref({ label: "Comcast Internet" })]).suppressed).toHaveLength(1);
    expect(run(mk("amica home insurance", months(2026, 3, 6, 10), 70), "2026-10-08", [ref({ label: "Chubb Home Insurance" })]).suggestions).toHaveLength(1);
  });
  it("name rule respects entity and account compatibility", () => {
    const base = mk("comcast", months(2026, 3, 6, 10), 70);
    expect(run(base, "2026-10-08", [ref({ label: "Comcast", entityId: "E2" })]).suggestions).toHaveLength(1);
    expect(run(base, "2026-10-08", [ref({ label: "Comcast", accountId: "A2" })]).suggestions).toHaveLength(1);
    expect(run(base, "2026-10-08", [ref({ label: "Comcast", accountId: "A1" })]).suggestions).toHaveLength(0);
    expect(run(base, "2026-10-08", [ref({ label: "Comcast", accountId: null })]).suggestions).toHaveLength(0);
  });
  it("amount+day rule: 5% / $1 tolerance, null day compatible, day within 3 (circular), other direction ignored", () => {
    const base = mk("xfinity", months(2026, 3, 6, 10), "65.95");
    const m = (o: Partial<ModelledRef>) => [ref({ label: "Comcast", monthly: new Decimal("65.95"), ...o })];
    expect(run(base, "2026-10-08", m({ day: null })).suppressed[0]?.suppressedBy?.kind).toBe("amount_day");
    expect(run(base, "2026-10-08", m({ monthly: new Decimal("69.20") })).suppressed).toHaveLength(1); // 5% of 69.20 = 3.46 >= 3.25
    expect(run(base, "2026-10-08", m({ monthly: new Decimal("69.50") })).suggestions).toHaveLength(1); // diff 3.55 > 3.475
    expect(run(base, "2026-10-08", m({ day: 13 })).suppressed).toHaveLength(1);
    expect(run(base, "2026-10-08", m({ day: 14 })).suggestions).toHaveLength(1);
    expect(run(base, "2026-10-08", m({ direction: "inflow" })).suggestions).toHaveLength(1);
    expect(run(base, "2026-10-08", m({ entityId: "E2" })).suggestions).toHaveLength(1);
  });
  it("amount+day rule also respects account compatibility", () => {
    const base = mk("xfinity", months(2026, 3, 6, 10), "65.95");
    const m = (accountId: string | null) => [ref({ label: "Comcast", monthly: new Decimal("65.95"), day: null, accountId })];
    expect(run(base, "2026-10-08", m("A2")).suggestions).toHaveLength(1);
    expect(run(base, "2026-10-08", m("A1")).suppressed).toHaveLength(1);
    expect(run(base, "2026-10-08", m(null)).suppressed).toHaveLength(1);
  });
  it("month-end day wrap: a bill on the 30th/31st is the same day as a record on the 1st", () => {
    const base = mk("xfinity", ["2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30"], "65.95");
    expect(run(base, "2026-10-08", [ref({ label: "Comcast", monthly: new Decimal("65.95"), day: 1 })]).suppressed).toHaveLength(1);
  });
  it("suppressed series are counted, not offered, and the count matches", () => {
    const rowsAll = [...mk("comcast", months(2026, 3, 6, 10), 70), ...mk("zzyzx widgets", months(2026, 3, 6, 12), 40)];
    const res = run(rowsAll, "2026-10-08", [ref({ label: "Comcast" })]);
    expect(res.suppressedCount).toBe(1);
    expect(res.suggestions.map((s) => s.payee)).toEqual(["Zzyzx Widgets"]);
  });
});

describe("confidence tiers (plan 5.4)", () => {
  // n weekly payments with ONE 10-day gap (outside both the 5-9 band and the doubled 11-17 band).
  const withOneBadInterval = (n: number) => {
    const ms: number[] = [Date.UTC(2026, 6, 1)];
    for (let i = 1; i < n; i++) ms.push((ms[i - 1] as number) + (i === 3 ? 10 : 7) * DAY);
    return mk("zzyzx widgets", ms.map(iso), 40);
  };
  it("high needs >= 90% of intervals in band: 1 bad of 10 is high, 1 bad of 6 is only medium", () => {
    const last = (rows: RD.TxRow[]) => iso(Math.max(...rows.map((r) => r.postedAt.getTime())) + 3 * DAY);
    const r11 = withOneBadInterval(11); // 10 intervals, 9 fit = 90%
    expect(run(r11, last(r11)).suggestions[0]?.confidence).toBe("high");
    const r7 = withOneBadInterval(7); // 6 intervals, 5 fit = 83%
    expect(run(r7, last(r7)).suggestions[0]?.confidence).toBe("medium");
  });
  it("varies is capped at medium even with a steady day and many payments", () => {
    const dates = months(2026, 1, 8, 10);
    const rows = mk("zzyzx widgets", dates, [40, 60, 45, 70, 50, 62, 41, 66]);
    const s = run(rows, "2026-10-08").suggestions[0];
    expect(s?.amountMode).toBe("varies");
    expect(s?.confidence).toBe("medium");
  });
  it("3 monthly payments are low; 4 are medium; 6 fixed on a steady day are high", () => {
    expect(run(mk("zzyzx widgets", months(2026, 6, 3, 10), 40), "2026-10-08").suggestions[0]?.confidence).toBe("low");
    expect(run(mk("zzyzx widgets", months(2026, 5, 4, 10), 40), "2026-10-08").suggestions[0]?.confidence).toBe("medium");
    expect(run(mk("zzyzx widgets", months(2026, 3, 6, 10), 40), "2026-10-08").suggestions[0]?.confidence).toBe("high");
  });
  it("a day-of-month spread above 7 caps a monthly series at low; a spread of 4-7 cannot be high", () => {
    const wide = mk("zzyzx widgets", ["2026-04-05", "2026-05-08", "2026-06-12", "2026-07-15", "2026-08-19", "2026-09-22"], 40);
    expect(run(wide, "2026-10-08").suggestions[0]?.confidence).toBe("low");
    const loose = mk("zzyzx widgets", ["2026-04-08", "2026-05-12", "2026-06-10", "2026-07-14", "2026-08-11", "2026-09-09"], 40);
    expect(run(loose, "2026-10-08").suggestions[0]?.confidence).toBe("medium");
  });
});

describe("late flag (plan 5.6): monthly, grace counted from the OBSERVED day", () => {
  // Mortgage-like: bill says day 1, history posts on the 3rd.
  const hist = mk("mortgage payment", months(2026, 3, 6, 3), 1500); // Apr..Sep 3
  const m = [ref({ label: "Mortgage", monthly: new Decimal(1500), day: 1, expectedAmount: new Decimal(1500) })];
  const lateOn = (today: string, rows = hist) => run(rows, today, m).flags.filter((f) => f.type === "late");
  it("not at grace-1 (Oct 7), flagged at grace (Oct 8)", () => {
    // observed day 3, expected Oct 3; +5 days = Oct 8
    const withoutOct = hist; // last row Sep 3
    expect(lateOn("2026-10-07", withoutOct)).toHaveLength(0);
    const f = lateOn("2026-10-08", withoutOct);
    expect(f).toHaveLength(1);
    expect(f[0]?.text).toBe("Mortgage usually posts around the 3rd; none seen yet this month.");
  });
  it("not flagged when this cycle posted (within 10 days before expected counts too)", () => {
    expect(lateOn("2026-10-08", [...hist, ...mk("mortgage payment", ["2026-10-03"], 1500)])).toHaveLength(0);
    expect(lateOn("2026-10-08", [...hist, ...mk("mortgage payment", ["2026-09-23"], 1500)])).toHaveLength(0);
  });
  it("stops once the next cycle takes over (expected + 25 days)", () => {
    expect(lateOn("2026-10-27")).toHaveLength(1);
    expect(lateOn("2026-10-28")).toHaveLength(0);
  });
  it("fewer than 3 matched history rows never flag", () => {
    expect(lateOn("2026-10-08", mk("mortgage payment", ["2026-08-03", "2026-09-03"], 1500))).toHaveLength(0);
    expect(lateOn("2026-10-08", mk("mortgage payment", ["2026-07-03", "2026-08-03", "2026-09-03"], 1500))).toHaveLength(1);
  });
  it("a bill that stopped more than 75 days before the expected date is not 'late'", () => {
    // last row Aug 3; expected Nov 3 = 92 days later -> none. Expected Oct 3 = 61 days later -> flagged.
    const old = mk("mortgage payment", months(2026, 2, 6, 3), 1500).slice(0, 5); // Mar..Jul 3
    expect(lateOn("2026-10-08", old)).toHaveLength(0); // last Jul 3 -> Oct 3 is 92 days
    const aug = mk("mortgage payment", months(2026, 3, 5, 3), 1500); // Apr..Aug 3
    expect(lateOn("2026-10-08", aug)).toHaveLength(1); // Aug 3 -> Oct 3 is 61 days
  });
  it("75-day rule boundary: last payment 75 days before the expected date still flags, 76 does not", () => {
    // expected = Oct 3 (day 3 observed). Jul 20 -> Oct 3 is 75 days; Jul 19 is 76.
    const mkHist = (lastIso: string) => [...mk("mortgage payment", ["2026-04-03", "2026-05-03", "2026-06-03"], 1500), ...mk("mortgage payment", [lastIso], 1500)];
    expect(lateOn("2026-10-08", mkHist("2026-07-20"))).toHaveLength(1);
    expect(lateOn("2026-10-08", mkHist("2026-07-19"))).toHaveLength(0);
  });
  it("quarterly, annual and semiannual records are never flagged late", () => {
    for (const cadence of ["quarterly", "annual", "semiannual"] as const) {
      const rows = mk("mortgage payment", months(2026, 3, 6, 3), 1500);
      const res = run(rows, "2026-10-20", [ref({ label: "Mortgage", cadence, monthly: new Decimal(1500) })]);
      expect(res.flags.filter((f) => f.type === "late"), cadence).toHaveLength(0);
    }
  });
  it("an inflow record is never flagged", () => {
    // (the learned "Mortgage Payment" series may carry its own flag; a flag about a RECORD must not exist)
    const res = run(hist, "2026-10-08", [ref({ label: "Mortgage", direction: "inflow" })]);
    expect(res.flags.filter((f) => f.modelled !== null)).toHaveLength(0);
  });
  it("a record in another entity does not look at this entity's history", () => {
    const res = run(hist, "2026-10-08", [ref({ label: "Mortgage", entityId: "E2" })]);
    expect(res.flags.filter((f) => f.modelled !== null)).toHaveLength(0);
  });
});

describe("late flag: weekly / biweekly", () => {
  const wk = Array.from({ length: 6 }, (_, i) => iso(Date.UTC(2026, 7, 1) + i * 7 * DAY)); // Aug 1 .. Sep 5
  const lastWk = Date.UTC(2026, 8, 5);
  const m = [ref({ label: "Doggy Daycare", cadence: "weekly", day: null })];
  const at = (offset: number) =>
    run(mk("doggy daycare", wk, 77.64), iso(lastWk + offset * DAY), m).flags.filter((f) => f.type === "late");
  it("expected = last + 7; flagged from +3 days of grace; the third missed cycle ends it", () => {
    expect(at(7 + 2)).toHaveLength(0);
    expect(at(7 + 3)).toHaveLength(1);
    expect(at(7 + 20)).toHaveLength(1);
    expect(at(7 + 21)).toHaveLength(0);
  });
  it("biweekly grace is 4 days", () => {
    const bw = Array.from({ length: 5 }, (_, i) => iso(Date.UTC(2026, 6, 4) + i * 14 * DAY));
    const last = Date.UTC(2026, 6, 4) + 4 * 14 * DAY;
    const f = (off: number) =>
      run(mk("doggy daycare", bw, 90), iso(last + off * DAY), [ref({ label: "Doggy Daycare", cadence: "biweekly" })]).flags.filter((x) => x.type === "late");
    expect(f(14 + 3)).toHaveLength(0);
    expect(f(14 + 4)).toHaveLength(1);
  });
});

describe("amount-change flag (plan 5.6)", () => {
  const series = (amts: (number | string)[]) => {
    const dates = months(2026, 9 - amts.length, amts.length, 10);
    return run(mk("netflix", dates, amts), "2026-10-08");
  };
  const flagsOf = (amts: (number | string)[]) => series(amts).flags.filter((f) => f.type === "amount_change");
  it("reports 'was about X, latest was Y' for a fixed series", () => {
    const f = flagsOf([19.13, 19.13, 19.13, 19.13, 19.13, 19.13, 22.99]);
    expect(f).toHaveLength(1);
    expect(f[0]?.text).toBe("Netflix: was about $19.13, latest was $22.99.");
  });
  it("needs BOTH 10% and $2: 9.9% no, 10% yes; $1.99 no, $2.00 yes", () => {
    const big = (latest: string) => flagsOf([1000, 1000, 1000, 1000, 1000, latest]).length;
    expect(big("1099.00")).toBe(0);
    expect(big("1100.00")).toBe(1);
    const small = (latest: string) => flagsOf([10, 10, 10, 10, 10, latest]).length;
    expect(small("11.99")).toBe(0); // 19.9% but only $1.99
    expect(small("12.00")).toBe(1); // 20% and exactly $2.00
  });
  it("downward changes are flagged too, using the same thresholds", () => {
    expect(flagsOf([30, 30, 30, 30, 30, 26]).length).toBe(1);
    expect(flagsOf([30, 30, 30, 30, 30, 27.5]).length).toBe(0);
  });
  it("needs at least 4 prior occurrences", () => {
    expect(flagsOf([19.13, 19.13, 19.13, 22.99])).toHaveLength(0); // 3 prior
    expect(flagsOf([19.13, 19.13, 19.13, 19.13, 22.99])).toHaveLength(1); // 4 prior
  });
  it("a varies-amount series (Eversource-style) is never flagged", () => {
    expect(flagsOf([41, 120, 665, 90, 300, 150, 600]).length).toBe(0);
    expect(flagsOf([100, 100, 100, 150, 150, 220]).length).toBe(0);
  });
  it("two in a row says so", () => {
    const f = flagsOf([19.13, 19.13, 19.13, 19.13, 19.13, 22.99, 22.99]);
    expect(f).toHaveLength(1);
    expect(f[0]?.text).toBe("Netflix: was about $19.13, now about $22.99 (2 in a row).");
  });
  it("flags about a suppressed (already recorded) series use the record's label and are still produced", () => {
    const rows = mk("netflix", months(2026, 3, 7, 10), [19.13, 19.13, 19.13, 19.13, 19.13, 19.13, 22.99]);
    const res = run(rows, "2026-10-08", [ref({ label: "Netflix Subscription" })]);
    expect(res.suggestions).toHaveLength(0);
    expect(res.flags.filter((f) => f.type === "amount_change")[0]?.text).toBe("Netflix Subscription: was about $19.13, latest was $22.99.");
  });
});

describe("history differs (Lexus-style, plan 5.6)", () => {
  const weekly = Array.from({ length: 10 }, (_, i) => iso(Date.UTC(2026, 6, 6) + i * 7 * DAY)); // Jul 6 .. Sep 7
  const lexus = (o: Partial<ModelledRef> = {}) =>
    [ref({ label: "Lexus Financial", tagKey: "E1|TL", monthly: new Decimal(250), day: null, cadence: "monthly", expectedAmount: new Decimal(250), ...o })];
  const tagged = mk("toyota", weekly, 250).map((r) => ({ ...r, tagIds: ["TL"] }));
  it("monthly record vs weekly history", () => {
    const f = run(tagged, "2026-09-10", lexus()).flags.filter((x) => x.type === "history_differs");
    expect(f).toHaveLength(1);
    expect(f[0]?.text).toBe("Lexus Financial: your records say $250.00 monthly; history shows about $250.00 every week.");
  });
  it("needs 4+ payments in the history", () => {
    const few = tagged.slice(0, 3);
    expect(run(few, "2026-08-01", lexus()).flags.filter((x) => x.type === "history_differs")).toHaveLength(0);
    expect(run(tagged.slice(0, 4), "2026-08-05", lexus()).flags.filter((x) => x.type === "history_differs")).toHaveLength(1);
  });
  it("the record already weekly: no cadence claim", () => {
    const f = run(tagged, "2026-09-10", lexus({ cadence: "weekly", monthly: new Decimal("1083.33") })).flags.filter((x) => x.type === "history_differs");
    expect(f).toHaveLength(0);
  });
  it("same cadence, amount more than 25% (and $5) away", () => {
    const hist = mk("zzyzx widgets", months(2026, 3, 6, 10), 130);
    const m = (monthly: number) => [ref({ label: "Zzyzx", monthly: new Decimal(monthly), expectedAmount: new Decimal(monthly), day: 10 })];
    const diff = (monthly: number) => run(hist, "2026-10-08", m(monthly)).flags.filter((x) => x.type === "history_differs").length;
    expect(diff(100)).toBe(1); // 30%
    expect(diff(104)).toBe(0); // 26/104 is exactly 25%: not MORE than 25%
    expect(diff(103)).toBe(1); // 27/103 = 26.2%
    // the $5 floor: 30% away but only $3 -> no claim; 32.5% and $6.50 -> claim
    const small = (hist: number, record: number) =>
      run(mk("zzyzx widgets", months(2026, 3, 6, 10), hist), "2026-10-08", [ref({ label: "Zzyzx", monthly: new Decimal(record), expectedAmount: new Decimal(record), day: 10 })]).flags.filter((x) => x.type === "history_differs").length;
    expect(small(13, 10)).toBe(0);
    expect(small(26.5, 20)).toBe(1);
  });
});

describe("month-end handling", () => {
  it("circularDays: 30, 31, 1 are neighbours", () => {
    expect(circularDays([30, 31, 1, 30, 31, 1]).spread).toBeLessThanOrEqual(2);
    expect(circularDays([1, 15, 28]).spread).toBeGreaterThan(7);
  });
  it("a day-31 monthly bill's next date lands on the month's last day, never overflows", () => {
    const dates = ["2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31"];
    const res = run(mk("zzyzx widgets", dates, 40), "2026-09-05");
    const s = res.suggestions[0];
    expect(s?.cadence).toBe("monthly");
    expect(iso(s?.nextExpected.getTime() ?? 0)).toBe("2026-09-30");
  });
  it("cycleDates in February clamps day 30 to the 28th", () => {
    const out = cycleDates("monthly", 30, D("2026-01-30"), D("2026-04-01"));
    expect(out.map((x) => iso(x.getTime()))).toEqual(["2026-02-28", "2026-03-30"]);
  });
});
