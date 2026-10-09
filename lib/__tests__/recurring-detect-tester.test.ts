// TESTER-authored adversarial tests for lib/recurring-detect.ts (pipeline task: recurring-detection).
// The detector is imported dynamically so the tester's mutation runner can point RD_MUT at a mutated copy; with
// RD_MUT unset these tests run against the real module.
//
// The oracle below is written from the PLAN (section 5), not from the implementation: median interval picks the
// cadence band, per-cadence minimum occurrences, >= 80% of intervals fit (band +-1 day, or a skipped cycle),
// fixed (+-10% or $2) / varies (+-50% or $5) on the median, weekly / biweekly / annual must be fixed.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import type * as RD from "@/lib/recurring-detect";

const modPath = process.env.RD_MUT ?? "@/lib/recurring-detect";
const mod = (await import(/* @vite-ignore */ modPath)) as typeof RD;
const { detectRecurring, canonicalPayee } = mod;

const DAY = 86_400_000;
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const T0 = Date.UTC(2026, 0, 3);

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

function mk(
  payee: string | null,
  dates: (string | number)[],
  amount: number | string | (number | string)[],
  o: Partial<RD.TxRow> = {}
): RD.TxRow[] {
  return dates.map((d, i) => ({
    entityId: "E1",
    accountId: "A1",
    accountType: "checking",
    payee,
    amount: new Decimal(Array.isArray(amount) ? (amount[i] as number | string) : amount).negated(),
    postedAt: typeof d === "number" ? new Date(d) : D(d),
    tagIds: [],
    ...o,
  }));
}
const monthlyDates = (y: number, m0: number, n: number, day: number) =>
  Array.from({ length: n }, (_, i) => isoOf(Date.UTC(y, m0 + i, day)));
const run = (rows: RD.TxRow[], today: string | Date, modelled: RD.DetectInput["modelled"] = []) =>
  detectRecurring({ rows, modelled, today: typeof today === "string" ? D(today) : today });

// ── Independent oracle ───────────────────────────────────────────────────────────────────────────

type Cad = "weekly" | "biweekly" | "monthly" | "quarterly" | "annual";
const BAND: Record<Cad, [number, number]> = { weekly: [6, 8], biweekly: [12, 16], monthly: [26, 35], quarterly: [84, 98], annual: [350, 380] };
const MINOCC: Record<Cad, number> = { weekly: 5, biweekly: 4, monthly: 3, quarterly: 3, annual: 2 };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}
function medD(xs: Decimal[]): Decimal {
  const s = [...xs].sort((a, b) => a.comparedTo(b));
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as Decimal) : (s[m - 1] as Decimal).plus(s[m] as Decimal).div(2).toDecimalPlaces(2);
}
function cadenceOf(med: number): Cad | null {
  for (const c of ["weekly", "biweekly", "monthly", "quarterly", "annual"] as Cad[]) if (med >= BAND[c][0] && med <= BAND[c][1]) return c;
  return null;
}
function fits(iv: number, c: Cad, loose: boolean): boolean {
  const [lo, hi] = BAND[c];
  if (iv >= lo - 1 && iv <= hi + 1) return true;
  return loose ? iv >= 2 * lo - 1 && iv <= 2 * hi + 1 : iv >= 2 * lo && iv <= 2 * hi;
}
function share(amts: Decimal[], med: Decimal, pct: number, abs: number): number {
  const tol = Decimal.max(med.times(pct), abs);
  return amts.filter((a) => a.minus(med).abs().lte(tol)).length / amts.length;
}
interface Verdict {
  accept: boolean | "maybe";
  cadence?: Cad;
  mode?: "fixed" | "varies";
  median?: Decimal;
}
function oracle(ms: number[], amts: Decimal[]): Verdict {
  const n = ms.length;
  if (n < 2) return { accept: false };
  const iv: number[] = [];
  for (let i = 1; i < n; i++) iv.push(Math.round(((ms[i] as number) - (ms[i - 1] as number)) / DAY));
  const c = cadenceOf(median(iv));
  if (!c || n < MINOCC[c]) return { accept: false };
  const strict = iv.filter((x) => fits(x, c, false)).length / iv.length >= 0.8;
  const loose = iv.filter((x) => fits(x, c, true)).length / iv.length >= 0.8;
  if (!strict && !loose) return { accept: false };
  const med = medD(amts);
  const fixed = share(amts, med, 0.1, 2) >= 0.8;
  const varies = share(amts, med, 0.5, 5) >= 0.8;
  const mode: "fixed" | "varies" | null = fixed ? "fixed" : varies ? "varies" : null;
  let accept: boolean | "maybe" = true;
  if (!mode) accept = n >= 6 ? "maybe" : false; // the price-rise rescue (n >= 6) is an implementation refinement
  else if ((c === "weekly" || c === "biweekly" || c === "annual") && mode !== "fixed") accept = n >= 6 ? "maybe" : false;
  if (mode === "varies" && n >= 6) accept = "maybe"; // a two-payment price rise may rescue a varies series into fixed (documented refinement)
  if (strict !== loose && accept === true) accept = "maybe"; // doubled-band edge reading differs
  if (mode === "fixed" && n >= 6) {
    // a price-rise rescue may replace the median with the last-two median; only the mode is asserted then
  }
  return { accept, cadence: c, mode: mode ?? undefined, median: med };
}

function genCase(r: () => number) {
  const target = pick(r, ["weekly", "biweekly", "monthly", "quarterly", "annual"] as Cad[]);
  const nominal = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, annual: 365 }[target];
  const n = int(r, 2, 10);
  const ms: number[] = [T0];
  for (let i = 1; i < n; i++) {
    const roll = r();
    let iv: number;
    if (roll < 0.78) iv = nominal + int(r, -2, 2);
    else if (roll < 0.9) iv = 2 * nominal + int(r, -1, 1);
    else iv = int(r, 1, 120);
    ms.push((ms[i - 1] as number) + Math.max(1, iv) * DAY);
  }
  const base = pick(r, [4.25, 15, 28.7, 100, 505.76]);
  const amode = pick(r, ["tight", "fixedwide", "mixed", "wild"] as const);
  const amts: Decimal[] = ms.map(() => {
    let f: number;
    if (amode === "tight") f = 1 + (r() - 0.5) * 0.04;
    else if (amode === "fixedwide") f = 1 + (r() - 0.5) * 0.2;
    else if (amode === "mixed") f = 0.5 + r() * 1.1;
    else f = 0.1 + r() * 3;
    return new Decimal(Math.max(2, base * f).toFixed(2)); // keep clear of the $2 floor, which is an exclusion rule
  });
  return { ms, amts, target };
}

describe("oracle fuzz: acceptance, cadence and amount mode agree with the plan's rules", () => {
  it("2,500 random single-payee series", () => {
    const r = rng(20261008);
    let accepted = 0;
    let rejected = 0;
    const byCad: Record<string, number> = {};
    for (let round = 0; round < 2500; round++) {
      const { ms, amts } = genCase(r);
      const last = ms[ms.length - 1] as number;
      const rows: RD.TxRow[] = ms.map((m, i) => ({
        entityId: "E1",
        accountId: "A1",
        accountType: "checking",
        payee: "Zzyzx Widgets",
        amount: (amts[i] as Decimal).negated(),
        postedAt: new Date(m),
        tagIds: [],
      }));
      const res = run(rows, new Date(last + 2 * DAY));
      const all = [...res.suggestions, ...res.suppressed];
      const v = oracle(ms, amts);
      const label = `round ${round}: dates ${ms.map(isoOf).join(",")} amts ${amts.map(String).join(",")}`;
      if (v.accept === "maybe") continue;
      if (v.accept) {
        accepted += 1;
        byCad[v.cadence as string] = (byCad[v.cadence as string] ?? 0) + 1;
        expect(all.length, label).toBe(1);
        const s = all[0] as RD.Series;
        expect(s.cadence, label).toBe(v.cadence);
        expect(s.amountMode, label).toBe(v.mode);
        expect(s.occurrences, label).toBe(ms.length);
        expect(s.firstSeen.getTime(), label).toBe(ms[0]);
        expect(s.lastSeen.getTime(), label).toBe(last);
        expect(s.nextExpected.getTime(), label).toBeGreaterThan(last);
        expect(s.minAmount.lte(s.typicalAmount) && s.typicalAmount.lte(s.maxAmount), label).toBe(true);
        if (ms.length < 6) expect(s.typicalAmount.toFixed(2), label).toBe((v.median as Decimal).toFixed(2));
        if (s.cadence === "annual") expect(s.confidence, label).toBe("low");
        if (s.cadence === "weekly" || s.cadence === "biweekly" || s.cadence === "annual") expect(s.amountMode, label).toBe("fixed");
      } else {
        rejected += 1;
        expect(all.length, label).toBe(0);
      }
    }
    // the generator must exercise every cadence both ways
    expect(accepted).toBeGreaterThan(300);
    expect(rejected).toBeGreaterThan(300);
    for (const c of ["weekly", "biweekly", "monthly", "quarterly", "annual"]) expect(byCad[c] ?? 0, c).toBeGreaterThan(10);
  });
});

describe("boundary pins (independent of the Coder's tests)", () => {
  const monthlyN = (n: number, amt: number | (number | string)[], day = 10) => mk("Zzyzx Widgets", monthlyDates(2026, 9 - n, n, day), amt);
  const find = (rows: RD.TxRow[], today = "2026-10-08") => run(rows, today).suggestions[0];

  it("minimum occurrences per cadence: n-1 is not a series, n is", () => {
    for (const [cad, step, min] of [["weekly", 7, 5], ["biweekly", 14, 4], ["quarterly", 91, 3]] as const) {
      const mkSeries = (n: number) => mk("Zzyzx Widgets", Array.from({ length: n }, (_, i) => T0 + i * step * DAY), 50);
      const lastOf = (n: number) => T0 + (n - 1) * step * DAY + DAY;
      expect(run(mkSeries(min - 1), new Date(lastOf(min - 1))).suggestions, `${cad} n-1`).toHaveLength(0);
      const ok = run(mkSeries(min), new Date(lastOf(min))).suggestions;
      expect(ok, `${cad} n`).toHaveLength(1);
      expect(ok[0]?.cadence).toBe(cad);
    }
    expect(find(monthlyN(2, 30))).toBeUndefined();
    expect(find(monthlyN(3, 30))?.cadence).toBe("monthly");
  });

  it("monthly median interval 26..35 in; 25 and 36 out (pure interval series)", () => {
    for (const iv of [25, 26, 35, 36]) {
      const dates = Array.from({ length: 5 }, (_, i) => T0 + i * iv * DAY);
      const res = run(mk("Zzyzx Widgets", dates, 40), new Date(dates[4] as number + DAY));
      const got = res.suggestions[0]?.cadence;
      expect(got, `interval ${iv}`).toBe(iv === 26 || iv === 35 ? "monthly" : undefined);
    }
  });

  it("weekly 6..8 in, 5 and 9 out; biweekly 12..16 in, 11 and 17 out", () => {
    const cadFor = (iv: number, n: number) => {
      const dates = Array.from({ length: n }, (_, i) => T0 + i * iv * DAY);
      return run(mk("Zzyzx Widgets", dates, 40), new Date((dates[n - 1] as number) + DAY)).suggestions[0]?.cadence;
    };
    expect(cadFor(6, 6)).toBe("weekly");
    expect(cadFor(8, 6)).toBe("weekly");
    expect(cadFor(5, 6)).toBeUndefined();
    expect(cadFor(9, 6)).toBeUndefined();
    expect(cadFor(12, 5)).toBe("biweekly");
    expect(cadFor(16, 5)).toBe("biweekly");
    expect(cadFor(11, 5)).toBeUndefined();
    expect(cadFor(17, 5)).toBeUndefined();
  });

  it("fixed tolerance edges: exactly 10% in, one cent over out; $2 floor on small bills", () => {
    // median 100: five payments, four of them at the edge value
    const edge = (v: string) => find(monthlyN(5, [100, 100, 100, v, v]));
    expect(edge("110.00")?.amountMode).toBe("fixed");
    expect(edge("90.00")?.amountMode).toBe("fixed");
    expect(edge("110.01")?.amountMode).toBe("varies");
    expect(edge("89.99")?.amountMode).toBe("varies");
    // small bill: median 10, others 12 (exactly $2) fixed, 12.01 varies
    const small = (v: string) => find(monthlyN(5, [10, 10, 10, v, v]));
    expect(small("12.00")?.amountMode).toBe("fixed");
    expect(small("12.01")?.amountMode).toBe("varies"); // only 3 of 5 within $2 of the median
  });

  it("80% share: 4 of 5 fixed, 3 of 5 is not", () => {
    expect(find(monthlyN(5, [100, 100, 100, 100, 200]))?.amountMode).toBe("fixed");
    const three = find(monthlyN(5, [100, 100, 100, 140, 140]));
    expect(three?.amountMode).toBe("varies");
  });

  it("varies edges: +50% in, beyond rejected; $5 floor for tiny medians", () => {
    expect(find(monthlyN(5, [100, 100, 100, 150, 150]))?.amountMode).toBe("varies");
    expect(find(monthlyN(5, [100, 100, 100, 150.01, 150.01]))).toBeUndefined();
    // median 8, +$5 = 13 in, 13.01 out
    expect(find(monthlyN(5, [8, 8, 8, 13, 13]))?.amountMode).toBe("varies");
    expect(find(monthlyN(5, [8, 8, 8, 13.01, 13.01]))).toBeUndefined();
  });

  it("weekly and biweekly with a varying amount are never series; annual needs a fixed amount", () => {
    const wk = Array.from({ length: 8 }, (_, i) => T0 + i * 7 * DAY);
    expect(run(mk("Zzyzx Widgets", wk, [100, 140, 110, 130, 100, 150, 120, 180]), new Date(wk[7] as number + DAY)).suggestions).toHaveLength(0);
    const bw = Array.from({ length: 6 }, (_, i) => T0 + i * 14 * DAY);
    expect(run(mk("Zzyzx Widgets", bw, [100, 140, 110, 130, 100, 150]), new Date(bw[5] as number + DAY)).suggestions).toHaveLength(0);
    const yr = [T0, T0 + 365 * DAY];
    expect(run(mk("Zzyzx Widgets", yr, [100, 140]), new Date(yr[1] as number + DAY)).suggestions).toHaveLength(0);
    const ok = run(mk("Zzyzx Widgets", yr, [100, 100]), new Date(yr[1] as number + DAY)).suggestions;
    expect(ok).toHaveLength(1);
    expect(ok[0]?.confidence).toBe("low");
    expect(ok[0]?.cadence).toBe("annual");
  });

  it("annual: 349 / 381 days apart is not annual; 12 months of a single payment is not annual; 6-month history never gives annual", () => {
    for (const gap of [349, 381]) {
      const yr = [T0, T0 + gap * DAY];
      expect(run(mk("Zzyzx Widgets", yr, 100), new Date(yr[1] as number + DAY)).suggestions).toHaveLength(0);
    }
    const six = Array.from({ length: 6 }, (_, i) => T0 + i * 30 * DAY);
    const res = run(mk("Zzyzx Widgets", six, 100), new Date(six[5] as number + DAY));
    expect(res.suggestions.every((s) => s.cadence !== "annual")).toBe(true);
  });

  it("stale boundary per cadence: 1.5 cycles + 7 days (monthly 52 / 53, weekly 17 / 18, quarterly 143 / 144, annual 554 / 555)", () => {
    const cases: [string, number[], number, number][] = [
      ["monthly", [0, 30, 60, 90], 52, 53],
      ["weekly", [0, 7, 14, 21, 28, 35], 17, 18],
      ["quarterly", [0, 91, 182, 273], 143, 144],
    ];
    for (const [name, offs, active, stale] of cases) {
      const dates = offs.map((o) => T0 + o * DAY);
      const last = dates[dates.length - 1] as number;
      const at = (days: number) => run(mk("Zzyzx Widgets", dates, 40), new Date(last + days * DAY));
      expect(at(active).suggestions.length, `${name} ${active}`).toBe(1);
      expect(at(stale).suggestions.length, `${name} ${stale}`).toBe(0);
      expect(at(stale).staleCount, `${name} ${stale}`).toBe(1);
    }
    const yr = [T0, T0 + 365 * DAY];
    const at = (days: number) => run(mk("Zzyzx Widgets", yr, 100), new Date(yr[1] as number + days * DAY));
    expect(at(554).suggestions.length).toBe(1);
    expect(at(555).suggestions.length).toBe(0);
  });
});

describe("row exclusions", () => {
  const cases: [string, Partial<RD.TxRow>][] = [
    ["online xfer transfer to sv ck x1234", {}],
    ["betterment sec transfer", {}],
    ["paypal inst xfer", {}],
    ["nontd atm fee", {}],
    ["zelle payment to bob", {}],
    ["venmo payment", {}],
    ["provisional credit", {}],
    ["acctverify deposit", {}],
    ["alpine payroll", {}],
    ["lowe s refund", {}],
    ["interest paid", {}],
    ["reversal of fee", {}],
    ["zzyzx widgets", { accountType: "loan" }],
    ["zzyzx widgets", { accountType: "mortgage" }],
    ["zzyzx widgets", { accountType: "investment" }],
    ["zzyzx widgets", { accountType: "insurance" }],
  ];
  for (const [payee, o] of cases) {
    it(`${payee} (${o.accountType ?? "checking"}) is never a series`, () => {
      const res = run(mk(payee, monthlyDates(2026, 3, 6, 10), 40, o), "2026-10-08");
      expect(res.suggestions).toHaveLength(0);
      expect(res.suppressed).toHaveLength(0);
    });
  }
  it("a card payment-received inflow is excluded", () => {
    const rows = mk("payment received", monthlyDates(2026, 3, 6, 10), -40, { accountType: "credit_card" });
    expect(run(rows, "2026-10-08").suggestions).toHaveLength(0);
    expect(run(mk("payment received", monthlyDates(2026, 3, 6, 10), -40, { accountType: "checking" }), "2026-10-08").suggestions).toHaveLength(1);
  });
  it("a credit-card INFLOW is excluded but the same card's outflow is a bill", () => {
    const inflow = mk("zzyzx widgets", monthlyDates(2026, 3, 6, 10), -40, { accountType: "credit_card" });
    expect(run(inflow, "2026-10-08").suggestions).toHaveLength(0);
    const outflow = mk("zzyzx widgets", monthlyDates(2026, 3, 6, 10), 40, { accountType: "credit_card" });
    expect(run(outflow, "2026-10-08").suggestions).toHaveLength(1);
  });
  it("amounts under $2 and exactly $2 (boundary)", () => {
    expect(run(mk("zzyzx widgets", monthlyDates(2026, 3, 6, 10), "1.99"), "2026-10-08").suggestions).toHaveLength(0);
    expect(run(mk("zzyzx widgets", monthlyDates(2026, 3, 6, 10), "2.00"), "2026-10-08").suggestions).toHaveLength(1);
  });
  it("a zero-amount row and a NaN-free blank payee never throw", () => {
    const rows = [...mk("   ", monthlyDates(2026, 3, 6, 10), 40), ...mk(null, monthlyDates(2026, 3, 6, 10), 40), ...mk("zzyzx widgets", monthlyDates(2026, 3, 6, 10), 0)];
    expect(() => run(rows, "2026-10-08")).not.toThrow();
    expect(run(rows, "2026-10-08").suggestions).toHaveLength(0);
  });
});

describe("payee cleaning does not merge distinct merchants", () => {
  it("canonical forms", () => {
    expect(canonicalPayee("dda purchase ap 403482 lowe s 2938 lisbon ct")).toBe("lowe s lisbon");
    expect(canonicalPayee("visa dda pur ap 469216 apple com bill 866 712 7753 ca")).toBe("apple com bill");
    expect(canonicalPayee("dda purch w cb stop shop 4411")).toBe("stop shop");
    expect(canonicalPayee("NETFLIX.COM")).toBe("netflix com");
  });
  it("two different merchants with a common first word stay separate (neither is a token prefix of the other)", () => {
    const rows = [
      ...mk("apple com bill", monthlyDates(2026, 3, 6, 5), 9.99),
      ...mk("apple store", monthlyDates(2026, 3, 6, 20), 49),
    ];
    const res = run(rows, "2026-10-08");
    expect(res.suggestions.map((s) => s.payee).sort()).toEqual(["Apple Com Bill", "Apple Store"]);
  });
  it("a bare root absorbing a longer name: when the merged group fails, both survive as their own series", () => {
    const rows = [
      ...mk("amazon prime", monthlyDates(2026, 3, 6, 5), 14.99),
      ...mk("amazon", ["2026-04-03", "2026-04-17", "2026-05-02", "2026-06-20", "2026-07-07", "2026-09-09"], [31, 9, 77, 18, 120, 44]),
    ];
    const res = run(rows, "2026-10-08");
    expect(res.suggestions.map((s) => s.payee)).toContain("Amazon Prime");
    expect(res.suggestions.map((s) => s.payee)).not.toContain("Amazon");
  });
  it("prefix merge needs a root of 4+ characters: a descriptor change under a 4-char root is ONE series, under a 3-char root two", () => {
    const four = [...mk("rent hub", monthlyDates(2026, 3, 3, 5), 900), ...mk("rent", monthlyDates(2026, 6, 3, 5), 900)];
    const r4 = run(four, "2026-10-08").suggestions;
    expect(r4.map((x) => [x.key, x.occurrences])).toEqual([["E1|A1|out|rent", 6]]);
    const three = [...mk("net hub", monthlyDates(2026, 3, 3, 5), 900), ...mk("net", monthlyDates(2026, 6, 3, 5), 900)];
    const r3 = run(three, "2026-10-08");
    expect(r3.suggestions.map((x) => [x.key, x.occurrences])).toEqual([["E1|A1|out|net", 3]]);
    expect(r3.staleCount).toBe(1); // the older "net hub" group is its own (stale) series
  });
  it("a bare xfer word is skipped even without the word transfer", () => {
    expect(run(mk("xfer to savings", monthlyDates(2026, 3, 6, 5), 900), "2026-10-08").suggestions).toHaveLength(0);
    expect(run(mk("xfinity", monthlyDates(2026, 3, 6, 5), 70), "2026-10-08").suggestions).toHaveLength(1);
  });
  it("same payee on two accounts, two entities and both signs are four separate series", () => {
    const base = monthlyDates(2026, 3, 6, 10);
    const rows = [
      ...mk("zzyzx widgets", base, 40, { accountId: "A1" }),
      ...mk("zzyzx widgets", base, 40, { accountId: "A2" }),
      ...mk("zzyzx widgets", base, 40, { entityId: "E2" }),
      ...mk("zzyzx widgets", base, -40),
    ];
    const res = run(rows, "2026-10-08");
    expect(res.suggestions.map((s) => s.key).sort()).toEqual([
      "E1|A1|in|zzyzx widgets",
      "E1|A1|out|zzyzx widgets",
      "E1|A2|out|zzyzx widgets",
      "E2|A1|out|zzyzx widgets",
    ]);
  });
});

describe("dates are UTC only", () => {
  it("23:30Z timestamps keep their UTC day across both DST changes and the result is the same as midnight", () => {
    const days = ["2026-02-08", "2026-03-08", "2026-04-08", "2026-05-08", "2026-06-08", "2026-07-08", "2026-08-08", "2026-09-08"];
    const late = days.map((x) => new Date(`${x}T23:30:00Z`).getTime());
    const a = run(mk("zzyzx widgets", days, 40), "2026-10-08");
    const b = run(mk("zzyzx widgets", late, 40), "2026-10-08");
    expect(b.suggestions[0]?.typicalDay).toBe(8);
    expect(a.suggestions[0]?.typicalDay).toBe(8);
    expect(b.suggestions[0]?.nextExpected.toISOString()).toBe(a.suggestions[0]?.nextExpected.toISOString());
    expect(a.suggestions[0]?.nextExpected.toISOString().slice(0, 10)).toBe("2026-10-08");
  });
  it("a Nov 1 DST day does not shift a weekly series by a day", () => {
    const dates = Array.from({ length: 8 }, (_, i) => Date.UTC(2026, 9, 4) + i * 7 * DAY);
    const res = run(mk("zzyzx widgets", dates, 40), new Date((dates[7] as number) + DAY));
    expect(res.suggestions[0]?.cadence).toBe("weekly");
    expect(res.suggestions[0]?.nextExpected.getTime()).toBe((dates[7] as number) + 7 * DAY);
  });
});

describe("calendar fuzz: monthly bills on any day of the month, including 29-31 and weekend slips", () => {
  it("is always detected as monthly with a next date 20-45 days after the last payment and inside a real month", () => {
    const r = rng(424242);
    let monthEnd = 0;
    for (let round = 0; round < 1500; round++) {
      const base = int(r, 1, 31);
      const n = int(r, 4, 9);
      const lastMonth = 8; // September 2026 is the latest month
      const dates: number[] = [];
      for (let i = 0; i < n; i++) {
        const m = lastMonth - (n - 1 - i);
        const dim = new Date(Date.UTC(2026, m + 1, 0)).getUTCDate();
        const slip = pick(r, [0, 0, 0, 1, 2]); // weekend / posting lag
        dates.push(Date.UTC(2026, m, Math.min(base, dim) + slip));
      }
      const last = dates[dates.length - 1] as number;
      // the latest payment might roll into October: keep "today" a few days after it
      const today = new Date(last + 3 * DAY);
      const rows = dates.map((d) => ({ entityId: "E1", accountId: "A1", accountType: "checking", payee: "Zzyzx Widgets", amount: new Decimal(-40), postedAt: new Date(d), tagIds: [] }) as RD.TxRow);
      const res = run(rows, today);
      const label = "base " + base + " dates " + dates.map(isoOf).join(",");
      const sr = res.suggestions[0];
      expect(sr, label).toBeDefined();
      expect(sr?.cadence, label).toBe("monthly");
      const next = sr?.nextExpected.getTime() as number;
      expect(next, label).toBeGreaterThan(last);
      expect((next - last) / DAY, label).toBeGreaterThanOrEqual(20);
      expect((next - last) / DAY, label).toBeLessThanOrEqual(45);
      const nd = new Date(next);
      const dim = new Date(Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth() + 1, 0)).getUTCDate();
      expect(nd.getUTCDate(), label).toBeLessThanOrEqual(dim);
      if (base >= 29) monthEnd += 1;
      // all payments sit within 2 days of one day-of-month (circular), so the day is steady
      expect(sr?.dayRule, label).not.toBe("day not steady");
    }
    expect(monthEnd).toBeGreaterThan(100);
  });
});

describe("determinism", () => {
  it("shuffled input gives the same output (fuzz)", () => {
    const r = rng(11);
    for (let round = 0; round < 40; round++) {
      const rows: RD.TxRow[] = [];
      for (let p = 0; p < 5; p++) {
        const { ms, amts } = genCase(r);
        ms.forEach((m, i) => rows.push({ entityId: pick(r, ["E1", "E2"]), accountId: "A1", accountType: "checking", payee: `Payee ${p}`, amount: (amts[i] as Decimal).negated(), postedAt: new Date(m + 200 * 0), tagIds: [] }));
      }
      const shuffled = [...rows].sort(() => r() - 0.5);
      const ser = (x: RD.DetectResult) => JSON.stringify({ s: x.suggestions.map((s) => [s.key, s.cadence, s.typicalAmount.toString(), s.confidence]), f: x.flags.map((f) => f.text), sup: x.suppressedCount, st: x.staleCount });
      const today = new Date((rows.reduce((a, b) => Math.max(a, b.postedAt.getTime()), 0)) + 2 * DAY);
      expect(ser(run(shuffled, today))).toBe(ser(run(rows, today)));
    }
  });
});
