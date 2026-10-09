import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  addDismissed,
  applyDismissals,
  canonicalPayee,
  circularDays,
  cycleDates,
  detectRecurring,
  DISMISSED_CAP,
  expandSeriesDates,
  isDismissed,
  keysRelated,
  parseDismissed,
  removeDismissed,
  serializeDismissed,
  type DetectResult,
  type Series,
  type TxRow,
} from "@/lib/recurring-detect";
import type { ModelledRef } from "@/lib/upcoming-ledger";

// Fixtures mirror the shapes read live on 2026-10-08 (names, spacing, amounts); no real account numbers.

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const TODAY = d("2026-10-08"); // a Thursday
const E1 = "ent-1";
const E2 = "ent-2";
const A1 = "acc-1";
const A2 = "acc-2";

function row(date: string, over: Partial<TxRow> = {}, amount = -19.99): TxRow {
  return {
    entityId: E1,
    accountId: A1,
    accountType: "checking",
    payee: "netflix",
    amount: new Decimal(amount),
    postedAt: new Date(date.includes("T") ? date : `${date}T00:00:00Z`),
    tagIds: [],
    ...over,
  };
}

/** One row per date, same payee; `amounts` may be a number or one per date. */
function rowsFor(dates: string[], amounts: number | number[], over: Partial<TxRow> = {}): TxRow[] {
  return dates.map((date, i) => row(date, over, -(Array.isArray(amounts) ? (amounts[i] as number) : amounts)));
}

/** `n` consecutive month dates on `day` ending in `lastYm` (day clamped to the month length). */
function monthly(day: number, n: number, lastYm = "2026-09"): string[] {
  const [y, m] = lastYm.split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const first = new Date(Date.UTC(y, m - 1 - i, 1));
    const dim = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    out.push(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, dim))).toISOString().slice(0, 10));
  }
  return out;
}

/** `n` dates every `step` days, the last one on `last`. */
function every(step: number, n: number, last: string): string[] {
  const end = d(last).getTime();
  return Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * step * 86_400_000).toISOString().slice(0, 10));
}

function detect(rows: TxRow[], modelled: ModelledRef[] = [], today = TODAY): DetectResult {
  return detectRecurring({ rows, modelled, today });
}

function ref(over: Partial<ModelledRef> & Pick<ModelledRef, "label">): ModelledRef {
  return {
    source: "scheduled_bill",
    sourceId: "ref-1",
    entityId: E1,
    accountId: null,
    direction: "outflow",
    tagKey: null,
    monthly: null,
    day: null,
    cadence: "monthly",
    expectedAmount: null,
    ...over,
  };
}

const only = (r: DetectResult): Series => {
  expect(r.suggestions).toHaveLength(1);
  return r.suggestions[0] as Series;
};

describe("canonicalPayee", () => {
  const table: [string, string][] = [
    ["dda purchase ap 403482 lowe s 2938 lisbon ct", "lowe s lisbon"],
    ["visa dda pur ap 469216 apple com bill 866 712 7753 ca", "apple com bill"],
    ["dda purch w cb 12345 some store ny", "some store"],
    ["STOP & SHOP #123", "stop shop"],
    ["netflix com", "netflix com"],
    ["ct", "ct"],
    ["12345", "12345"],
  ];
  for (const [raw, expected] of table) {
    it(`${raw} -> ${expected}`, () => expect(canonicalPayee(raw)).toBe(expected));
  }
});

describe("cadence detection (minimum occurrences)", () => {
  it("monthly: 3 occurrences are enough (low), 2 are not", () => {
    const three = only(detect(rowsFor(monthly(14, 3), 28.7)));
    expect(three.cadence).toBe("monthly");
    expect(three.confidence).toBe("low");
    expect(detect(rowsFor(monthly(14, 2), 28.7)).suggestions).toHaveLength(0);
  });

  it("monthly: 4 occurrences are medium, 6 are high", () => {
    expect(only(detect(rowsFor(monthly(14, 4), 28.7))).confidence).toBe("medium");
    expect(only(detect(rowsFor(monthly(14, 6), 28.7))).confidence).toBe("high");
  });

  it("weekly: 5 occurrences, not 4", () => {
    const s = only(detect(rowsFor(every(7, 5, "2026-10-05"), 77.64)));
    expect(s.cadence).toBe("weekly");
    expect(s.typicalDay).toBeNull();
    expect(detect(rowsFor(every(7, 4, "2026-10-05"), 77.64)).suggestions).toHaveLength(0);
  });

  it("biweekly: 4 occurrences, not 3", () => {
    const s = only(detect(rowsFor(every(14, 4, "2026-10-02"), 120)));
    expect(s.cadence).toBe("biweekly");
    expect(detect(rowsFor(every(14, 3, "2026-10-02"), 120)).suggestions).toHaveLength(0);
  });

  it("quarterly: 3 occurrences (medium), not 2", () => {
    const s = only(detect(rowsFor(["2026-01-10", "2026-04-10", "2026-07-10"], 88)));
    expect(s.cadence).toBe("quarterly");
    expect(s.confidence).toBe("medium");
    expect(detect(rowsFor(["2026-04-10", "2026-07-10"], 88)).suggestions).toHaveLength(0);
  });

  it("annual: only with two dates 350-380 days apart; always low", () => {
    const s = only(detect(rowsFor(["2025-03-05", "2026-03-05"], 119.88)));
    expect(s.cadence).toBe("annual");
    expect(s.confidence).toBe("low");
    expect(s.nextExpected.toISOString().slice(0, 10)).toBe("2027-03-05");
  });

  it("annual boundaries: 349 and 381 days apart are not annual", () => {
    expect(detect(rowsFor(["2025-03-23", "2026-03-07"], 50)).suggestions).toHaveLength(0); // 349
    expect(detect(rowsFor(["2025-03-01", "2026-03-17"], 50)).suggestions).toHaveLength(0); // 381
    expect(detect(rowsFor(["2025-03-22", "2026-03-07"], 50)).suggestions).toHaveLength(1); // 350
    expect(detect(rowsFor(["2025-03-01", "2026-03-16"], 50)).suggestions).toHaveLength(1); // 380
  });

  it("a yearly pair with different amounts is a coincidence, not an annual bill", () => {
    expect(detect(rowsFor(["2025-03-05", "2026-03-05"], [52.78, 31.1], { payee: "jiffy mart" })).suggestions).toHaveLength(0);
  });

  it("annual is never produced from a 6-month history", () => {
    const r = detect(rowsFor(monthly(5, 6), 40));
    expect(r.suggestions.every((s) => s.cadence !== "annual")).toBe(true);
  });
});

describe("spacing tolerance", () => {
  for (const [step, ok] of [
    [26, true],
    [35, true],
    [25, false],
    [36, false],
  ] as const) {
    it(`${step} days apart is ${ok ? "monthly" : "rejected"}`, () => {
      const r = detect(rowsFor(every(step, 5, "2026-09-30"), 40));
      expect(r.suggestions).toHaveLength(ok ? 1 : 0);
      if (ok) expect((r.suggestions[0] as Series).cadence).toBe("monthly");
    });
  }

  it("one skipped cycle is tolerated, two are not", () => {
    const base = ["2026-01-10", "2026-02-10", "2026-03-10", "2026-04-10", "2026-05-10", "2026-06-10", "2026-07-10", "2026-08-10", "2026-09-10"];
    const oneSkipped = base.filter((x) => x !== "2026-04-10"); // one 61-day gap (the doubled band) among 7 intervals
    expect(detect(rowsFor(oneSkipped, 40)).suggestions).toHaveLength(1);
    // Two cycles skipped in a row is a ~91-day gap: not a monthly interval and not a single skipped cycle.
    // One such gap among 8 intervals still passes the 80% fit; two of them (6 of 8 = 75%) do not.
    const oneGap = ["2025-12-10", "2026-01-10", "2026-02-10", "2026-03-10", "2026-06-10", "2026-07-10", "2026-08-10", "2026-09-10"];
    expect(detect(rowsFor(oneGap, 40)).suggestions).toHaveLength(1);
    const twoGaps = ["2025-09-10", "2025-10-10", "2025-11-10", "2026-02-10", "2026-03-10", "2026-04-10", "2026-07-10", "2026-08-10", "2026-09-10"];
    expect(detect(rowsFor(twoGaps, 40)).suggestions).toHaveLength(0);
  });
});

describe("amount rules", () => {
  it("fixed: within 10% or $2 of the median for 80%+ of occurrences", () => {
    const s = only(detect(rowsFor(monthly(10, 6), [100, 100, 100, 100, 100, 110])));
    expect(s.amountMode).toBe("fixed");
    expect(s.typicalAmount.toFixed(2)).toBe("100.00");
  });

  it("the $2 floor makes tiny bills fixed: 10 -> 12 is fixed, 10 -> 12.01 is not", () => {
    expect(only(detect(rowsFor(monthly(10, 6), [10, 10, 10, 10, 12, 12]))).amountMode).toBe("fixed");
    expect(only(detect(rowsFor(monthly(10, 6), [10, 12.01, 10, 12.01, 10, 10]))).amountMode).toBe("varies");
  });

  it("varies: within 50% or $5; beyond that the group is rejected", () => {
    const varies = only(detect(rowsFor(monthly(10, 6), [100, 140, 100, 140, 100, 100])));
    expect(varies.amountMode).toBe("varies");
    expect(varies.minAmount.toFixed(2)).toBe("100.00");
    expect(varies.maxAmount.toFixed(2)).toBe("140.00");
    expect(detect(rowsFor(monthly(10, 6), [100, 160, 100, 160, 100, 100])).suggestions).toHaveLength(0);
  });

  it("weekly / biweekly must be a fixed amount (a varying lunch spot is not a bill)", () => {
    const amounts = [10, 30, 10, 30, 10, 30, 10, 30];
    expect(detect(rowsFor(every(7, 8, "2026-10-05"), amounts)).suggestions).toHaveLength(0);
    expect(detect(rowsFor(every(14, 8, "2026-10-02"), amounts)).suggestions).toHaveLength(0);
    // The same amounts monthly are an "amount varies" bill.
    expect(only(detect(rowsFor(monthly(10, 8), amounts))).amountMode).toBe("varies");
  });

  it("a two-payment new price keeps the series and uses the new price", () => {
    const s = only(detect(rowsFor(monthly(10, 8), [19.13, 19.13, 19.13, 19.13, 19.13, 19.13, 22.99, 22.99])));
    expect(s.amountMode).toBe("fixed");
    expect(s.typicalAmount.toFixed(2)).toBe("22.99");
  });
});

describe("grouping", () => {
  it("prefix merge: 'toyota' and 'toyota ach rtl' alternate monthly and merge into 'toyota'", () => {
    const dates = monthly(5, 6);
    const rows = [
      ...rowsFor(dates.filter((_, i) => i % 2 === 0), 250, { payee: "toyota" }),
      ...rowsFor(dates.filter((_, i) => i % 2 === 1), 250, { payee: "toyota ach rtl" }),
    ];
    const r = detect(rows);
    const s = only(r);
    expect(s.key).toBe(`${E1}|${A1}|out|toyota`);
    expect(s.occurrences).toBe(6);
  });

  it("merged group fails, each sub-group is then evaluated alone (soapy noble)", () => {
    const steady = rowsFor(monthly(12, 6), 20, { payee: "soapy noble" });
    const noise = rowsFor(
      ["2026-04-02", "2026-04-23", "2026-05-06", "2026-05-29", "2026-07-03", "2026-08-01", "2026-08-19", "2026-09-26"],
      [8, 55, 12, 90, 30, 7, 70, 15],
      { payee: "soapy noble niantic" }
    );
    const r = detect([...steady, ...noise]);
    const s = only(r);
    expect(s.key).toBe(`${E1}|${A1}|out|soapy noble`);
    expect(s.occurrences).toBe(6);
  });

  it("raw bank descriptions of one merchant canonicalize to the same series", () => {
    const dates = monthly(9, 6);
    const rows = dates.map((date, i) =>
      row(date, { payee: i % 2 === 0 ? "dda purchase ap 403482 hbo max 8007 ny" : "hbo max" }, -19.66)
    );
    // 'hbo max' is a token-prefix of 'hbo max' after canonicalization of the first ("hbo max")
    expect(only(detect(rows)).payee).toBe("Hbo Max");
  });

  it("the same payee on two accounts, or in two entities, is always separate series", () => {
    const dates = monthly(14, 6);
    const rows = [
      ...rowsFor(dates, 28.7, { accountId: A1 }),
      ...rowsFor(dates, 28.7, { accountId: A2 }),
      ...rowsFor(dates, 28.7, { entityId: E2, accountId: "acc-3" }),
    ];
    const r = detect(rows);
    expect(r.suggestions).toHaveLength(3);
    expect(new Set(r.suggestions.map((s) => s.key)).size).toBe(3);
  });

  it("same-day rows are one occurrence; several charges on the same days are not a bill", () => {
    const dates = monthly(14, 6);
    const doubled = dates.flatMap((date) => [row(date, { payee: "google workspace" }, -6), row(date, { payee: "google workspace" }, -6)]);
    expect(detect(doubled).suggestions).toHaveLength(0); // 12 rows on 6 days (> 1.5x)
    const oneDouble = [...rowsFor(dates, 6, { payee: "google workspace" }), row(dates[2] as string, { payee: "google workspace" }, -6)];
    const s = only(detect(oneDouble)); // 7 rows on 6 days
    expect(s.occurrences).toBe(6);
  });
});

describe("exclusions", () => {
  const six = monthly(15, 6);

  it("transfers, payroll, interest, refunds and returns", () => {
    for (const payee of [
      "online xfer transfer to sv ck",
      "betterment sec transfer",
      "zelle payment to someone",
      "nontd atm fee",
      "acme payroll",
      "interest paid",
      "lowe s refund",
      "amazon return",
    ]) {
      expect(detect(rowsFor(six, 100, { payee })).suggestions, payee).toHaveLength(0);
    }
  });

  it("'atm' only as a word: atmos energy is a utility, not an ATM", () => {
    expect(detect(rowsFor(six, 100, { payee: "atmos energy" })).suggestions).toHaveLength(1);
  });

  it("loan / mortgage / investment / insurance account rows are mirrors", () => {
    for (const accountType of ["loan", "mortgage", "investment", "insurance"]) {
      expect(detect(rowsFor(six, 100, { accountType })).suggestions, accountType).toHaveLength(0);
    }
  });

  it("inflows count only on checking / savings; a card 'payment received' is a mirror", () => {
    const deposit = rowsFor(six, -1400, { payee: "acme consulting", accountType: "checking" });
    const r = detect(deposit);
    expect(only(r).kind).toBe("inflow");
    expect(detect(rowsFor(six, -1400, { payee: "acme consulting", accountType: "credit_card" })).suggestions).toHaveLength(0);
  });

  it("amounts under $2, a payee seen once and a null payee", () => {
    expect(detect(rowsFor(six, 0.95, { payee: "invoice cloud webpayment" })).suggestions).toHaveLength(0);
    expect(detect([row("2026-09-02", { payee: "one off shop" })]).suggestions).toHaveLength(0);
    expect(detect(rowsFor(six, 40, { payee: null })).suggestions).toHaveLength(0);
    expect(detect(rowsFor(six, 40, { payee: "  " })).suggestions).toHaveLength(0);
  });

  // Review round 1: unpaired card payments on checking would double count the card account's own spending.
  const CARD_PAYMENT_DESCRIPTORS = [
    "capital one crcardpmt",
    "amex epayment ach pmt",
    "capital one mobile pmt",
    "citi card pmt",
    "barclaycard us payment",
    "amex",
    "american express autopay",
  ];
  for (const payee of CARD_PAYMENT_DESCRIPTORS) {
    it(`card-payment descriptor "${payee}" on checking: no suggestion and no late flag`, () => {
      const rows = rowsFor(monthly(15, 6), 100, { payee, accountType: "checking" });
      expect(detect(rows).suggestions).toHaveLength(0);
      const tagged = rowsFor(monthly(3, 6), 100, { payee, accountType: "checking", tagIds: ["TC"] });
      const card = ref({ label: "Card payment", tagKey: `${E1}|TC`, day: 1, monthly: new Decimal(100), cadence: "monthly" });
      expect(detect(tagged, [card], d("2026-10-20")).flags.filter((f) => f.type === "late")).toHaveLength(0);
    });
  }

  it("narrow card-payment tokens: real bills named 'acct paymt' / 'webpayment' are still detected", () => {
    for (const payee of ["enerbank usa acct paymt", "invoice cloud webpayment"]) {
      const r = detect(rowsFor(monthly(15, 6), 100, { payee }));
      expect(r.suggestions, payee).toHaveLength(1);
    }
  });

  it("punctuation-only payees canonicalize to nothing: no nameless series, no merged series, no blank-led flag", () => {
    const rows = [
      ...rowsFor(monthly(15, 6), 100, { payee: "***" }),
      ...rowsFor(monthly(15, 6), 100, { payee: "###" }),
      ...rowsFor(monthly(3, 6), 100, { payee: "***", tagIds: ["TP"] }),
    ];
    const r = detect(rows);
    expect(r.suggestions).toHaveLength(0);
    expect(r.suppressed).toHaveLength(0);
    expect(r.staleCount).toBe(0);
    const punct = ref({ label: "Mystery", tagKey: `${E1}|TP`, day: 1, monthly: new Decimal(100), cadence: "monthly" });
    const flagged = detect(rows, [punct], d("2026-10-20"));
    expect(flagged.flags).toHaveLength(0);
  });

  it("a grocery-style irregular payee is rejected by the interval fit", () => {
    const dates = ["2026-04-01", "2026-04-04", "2026-04-13", "2026-04-18", "2026-04-30", "2026-05-03", "2026-05-11", "2026-05-22", "2026-05-28", "2026-06-09", "2026-06-12", "2026-06-25", "2026-07-02"];
    const amounts = [88, 41, 120, 66, 93, 52, 140, 71, 99, 58, 133, 80, 61];
    expect(detect(rowsFor(dates, amounts, { payee: "costco" })).suggestions).toHaveLength(0);
  });
});

describe("staleness", () => {
  it("52 days since the last payment is still active; 53 is stale and never suggested", () => {
    // today 2026-10-08: 52 days ago = 2026-08-17
    const active = detect(rowsFor(monthly(17, 6, "2026-08"), 40));
    expect(active.suggestions).toHaveLength(1);
    expect(active.staleCount).toBe(0);
    const stale = detect(rowsFor(monthly(16, 6, "2026-08"), 40));
    expect(stale.suggestions).toHaveLength(0);
    expect(stale.staleCount).toBe(1);
  });
});

describe("day rule and next date", () => {
  it("circularDays wraps the month: 1st..30th is a spread of 1, not 28", () => {
    expect(circularDays([1, 30, 1, 30]).spread).toBe(1);
    expect(circularDays([30, 1, 31, 30, 1]).spread).toBeLessThanOrEqual(2);
    expect(circularDays([10, 20]).spread).toBe(10);
    expect(circularDays([14, 14, 14])).toEqual({ day: 14, spread: 0 });
  });

  it("month-end bills (30th / 31st) read as a steady day", () => {
    const rows = rowsFor(["2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30"], 60);
    const s = only(detect(rows));
    expect(s.typicalDay).toBe(30);
    expect(s.dayRule).toBe("usually around the 30th");
  });

  it("a day-30 bill's next date in February is the 28th (clamped)", () => {
    const rows = rowsFor(["2026-08-30", "2026-09-30", "2026-10-30", "2026-11-30", "2026-12-30", "2027-01-30"], 60);
    const s = only(detect(rows, [], d("2027-02-02")));
    expect(s.nextExpected.toISOString().slice(0, 10)).toBe("2027-02-28");
  });

  it("day rule wording by spread", () => {
    expect(only(detect(rowsFor(monthly(5, 6), 40))).dayRule).toBe("usually around the 5th");
    const loose = ["2026-04-05", "2026-05-08", "2026-06-12", "2026-07-15", "2026-08-18", "2026-09-22"];
    const s = only(detect(rowsFor(loose, 40)));
    expect(s.dayRule).toBe("day not steady");
    expect(s.confidence).toBe("low");
  });

  it("an 8-day spread is 'day varies' and caps nothing but high", () => {
    const days = ["2026-04-10", "2026-05-13", "2026-06-15", "2026-07-17", "2026-08-14", "2026-09-12"];
    const s = only(detect(rowsFor(days, 40)));
    expect(s.dayRule).toBe("around the 13th, day varies");
    expect(s.confidence).toBe("medium");
  });

  it("is UTC-only: 23:30Z rows keep their UTC day across the March and November DST changes", () => {
    const march = ["2025-12-08", "2026-01-08", "2026-02-08", "2026-03-08", "2026-04-08", "2026-05-08"].map((x) => `${x}T23:30:00Z`);
    const s1 = only(detect(rowsFor(march, 30), [], d("2026-06-10")));
    expect(s1.typicalDay).toBe(8);
    expect(s1.lastSeen.toISOString()).toBe("2026-05-08T00:00:00.000Z");
    const nov = ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"].map((x) => `${x}T23:30:00Z`);
    const s2 = only(detect(rowsFor(nov, 30), [], d("2026-11-20")));
    expect(s2.typicalDay).toBe(1);
    expect(s2.nextExpected.toISOString().slice(0, 10)).toBe("2026-12-01");
  });

  it("cycleDates / expandSeriesDates: weekly lists every date, monthly skips the cycle that already posted", () => {
    const weekly = only(detect(rowsFor(every(7, 5, "2026-10-05"), 77.64)));
    const dates = expandSeriesDates(weekly, d("2026-10-08"), d("2026-11-08")).map((x) => x.toISOString().slice(0, 10));
    expect(dates).toEqual(["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
    // A monthly payment seen early (Oct 2, usually the 14th) does not also expect Oct 14.
    const early = cycleDates("monthly", 14, d("2026-10-02"), d("2026-12-31")).map((x) => x.toISOString().slice(0, 10));
    expect(early[0]).toBe("2026-11-14");
  });
});

describe("confidence and why", () => {
  it("high needs a fixed amount, steady day and 6+ monthly occurrences; why lists the facts", () => {
    const s = only(detect(rowsFor(monthly(5, 6), 28.7)));
    expect(s.confidence).toBe("high");
    expect(s.why.join(", ")).toBe("Seen 6 times, 30-31 days apart, always about $28.70, usually around the 5th");
  });

  it("an amount-varies series is capped at medium and says so", () => {
    const s = only(detect(rowsFor(monthly(5, 8), [60, 80, 100, 70, 90, 110, 65, 95])));
    expect(s.amountMode).toBe("varies");
    expect(s.confidence).toBe("medium");
    expect(s.why.join(", ")).toContain("amount varies, about $60.00 to $110.00");
  });

  it("weekly high needs 5 fixed occurrences", () => {
    expect(only(detect(rowsFor(every(7, 5, "2026-10-05"), 77.64))).confidence).toBe("high");
  });
});

describe("suppression of already-recorded items", () => {
  const rows = (over: Partial<TxRow> = {}) => rowsFor(monthly(5, 6), 28.7, { payee: "netflix", ...over });

  it("by tag (>= 50% of rows)", () => {
    const tagged = rows().map((r, i) => (i < 3 ? { ...r, tagIds: ["T1"] } : r));
    const r = detect(tagged, [ref({ label: "Streaming", tagKey: `${E1}|T1` })]);
    expect(r.suggestions).toHaveLength(0);
    expect(r.suppressedCount).toBe(1);
    expect((r.suppressed[0] as Series).suppressedBy?.kind).toBe("tag");
    const fewer = rows().map((x, i) => (i < 2 ? { ...x, tagIds: ["T1"] } : x));
    expect(detect(fewer, [ref({ label: "Streaming", tagKey: `${E1}|T1` })]).suggestions).toHaveLength(1);
  });

  it("by a shared distinctive word", () => {
    const r = detect(rows(), [ref({ label: "Netflix subscription" })]);
    expect(r.suggestions).toHaveLength(0);
    expect((r.suppressed[0] as Series).suppressedBy).toMatchObject({ kind: "name", label: "Netflix subscription" });
  });

  it("by amount + day for a record with no distinctive name (null day counts as compatible)", () => {
    const m = new Decimal("28.70");
    expect(detect(rows(), [ref({ label: "Streaming", monthly: m, day: 5 })]).suggestions).toHaveLength(0);
    expect(detect(rows(), [ref({ label: "Streaming", monthly: m, day: null })]).suggestions).toHaveLength(0);
    expect(detect(rows(), [ref({ label: "Streaming", monthly: m, day: 20 })]).suggestions).toHaveLength(1);
    expect(detect(rows(), [ref({ label: "Streaming", monthly: new Decimal("90") , day: 5 })]).suggestions).toHaveLength(1);
  });

  it("a record in another entity never suppresses", () => {
    expect(detect(rows(), [ref({ label: "Netflix", entityId: E2 })]).suggestions).toHaveLength(1);
    expect(detect(rows(), [ref({ label: "Netflix", accountId: A2 })]).suggestions).toHaveLength(1);
  });

  it("a paycheck record suppresses a regular deposit of the same name", () => {
    const deposit = rowsFor(monthly(1, 6), -2555, { payee: "alpine energy", accountType: "checking" });
    const r = detect(deposit, [ref({ label: "Alpine Energy paycheck", direction: "inflow", source: "income_source" })]);
    expect(r.suggestions).toHaveLength(0);
    expect(r.suppressedCount).toBe(1);
  });
});

describe("late flag", () => {
  const history = [
    ["2026-04-03", 1250],
    ["2026-05-02", 1250],
    ["2026-06-04", 1250],
    ["2026-07-03", 1250],
    ["2026-08-05", 1250],
    ["2026-09-03", 1250],
  ] as const;
  const mortgageRows = (extra: TxRow[] = []) => [
    ...history.map(([date, amt]) => row(date, { payee: "pennymac cash", tagIds: ["TM"] }, -amt)),
    ...extra,
  ];
  const mortgage = ref({ label: "Mortgage", tagKey: `${E1}|TM`, day: 1, monthly: new Decimal(1250), cadence: "monthly" });
  const lateFlags = (r: DetectResult) => r.flags.filter((f) => f.type === "late");

  it("grace is counted from the OBSERVED day: not at grace-1, flagged at grace", () => {
    expect(lateFlags(detect(mortgageRows(), [mortgage], d("2026-10-07")))).toHaveLength(0);
    const flags = lateFlags(detect(mortgageRows(), [mortgage], d("2026-10-08")));
    expect(flags).toHaveLength(1);
    expect(flags[0]?.text).toBe("Mortgage usually posts around the 3rd; none seen yet this month.");
    expect(flags[0]?.modelled?.label).toBe("Mortgage");
  });

  it("not flagged when it posted this cycle, when there are fewer than 3 history rows, or once the next cycle takes over", () => {
    const posted = mortgageRows([row("2026-10-04", { payee: "pennymac cash", tagIds: ["TM"] }, -1250)]);
    expect(lateFlags(detect(posted, [mortgage], d("2026-10-20")))).toHaveLength(0);
    expect(lateFlags(detect(mortgageRows().slice(-2), [mortgage], d("2026-10-20")))).toHaveLength(0);
    expect(lateFlags(detect(mortgageRows(), [mortgage], d("2026-10-27")))).toHaveLength(1);
    expect(lateFlags(detect(mortgageRows(), [mortgage], d("2026-10-28")))).toHaveLength(0);
  });

  it("quarterly and annual records are never flagged late", () => {
    expect(lateFlags(detect(mortgageRows(), [{ ...mortgage, cadence: "quarterly" }], d("2026-10-12")))).toHaveLength(0);
    expect(lateFlags(detect(mortgageRows(), [{ ...mortgage, cadence: "annual" }], d("2026-10-12")))).toHaveLength(0);
    expect(lateFlags(detect(mortgageRows(), [{ ...mortgage, cadence: "semiannual" }], d("2026-10-12")))).toHaveLength(0);
  });

  it("a bill that stopped long ago is not flagged", () => {
    const old = history.map(([date, amt]) => row(date.replace("2026", "2025"), { payee: "pennymac cash", tagIds: ["TM"] }, -amt));
    expect(lateFlags(detect(old, [mortgage], d("2026-10-12")))).toHaveLength(0);
  });

  it("a month-end bill is checked against last month's date early in the next month", () => {
    const rows = ["2026-04-29", "2026-05-29", "2026-06-29", "2026-07-29", "2026-08-29"].map((x) => row(x, { payee: "water co", tagIds: ["TW"] }, -60));
    const r = detect(rows, [ref({ label: "Water", tagKey: `${E1}|TW`, day: 29 })], d("2026-10-07"));
    expect(lateFlags(r)[0]?.text).toBe("Water usually posts around the 29th; none seen yet for last month.");
  });

  it("a high-confidence learned series is flagged too (and a weekly one by its own grace)", () => {
    const rows = rowsFor(monthly(3, 6), 40, { payee: "gym club" });
    const r = detect(rows, [], d("2026-10-08"));
    expect(lateFlags(r)).toHaveLength(1);
    expect(lateFlags(r)[0]?.seriesKey).toBe(r.suggestions[0]?.key);
    const weekly = rowsFor(["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01"], 31, { payee: "pool service" });
    expect(lateFlags(detect(weekly, [], d("2026-10-10")))).toHaveLength(0);
    expect(lateFlags(detect(weekly, [], d("2026-10-11")))).toHaveLength(1);
  });
});

describe("amount-change flag", () => {
  const change = (amounts: number[]) => detect(rowsFor(monthly(10, amounts.length), amounts)).flags.filter((f) => f.type === "amount_change");

  it("reports 'was about X, latest was Y'", () => {
    const flags = change([19.13, 19.13, 19.13, 19.13, 19.13, 19.13, 22.99]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.text).toBe("Netflix: was about $19.13, latest was $22.99.");
    expect(flags[0]?.was?.toFixed(2)).toBe("19.13");
    expect(flags[0]?.now?.toFixed(2)).toBe("22.99");
  });

  it("thresholds: 9.9% no, exactly 10% yes, $1.99 no, $2.00 yes", () => {
    expect(change([100, 100, 100, 100, 100, 109.9])).toHaveLength(0);
    expect(change([100, 100, 100, 100, 100, 110])).toHaveLength(1);
    expect(change([10, 10, 10, 10, 10, 11.99])).toHaveLength(0);
    expect(change([10, 10, 10, 10, 10, 12])).toHaveLength(1);
  });

  it("two in a row says so", () => {
    const flags = change([19.13, 19.13, 19.13, 19.13, 19.13, 19.13, 22.99, 22.99]);
    expect(flags[0]?.text).toBe("Netflix: was about $19.13, now about $22.99 (2 in a row).");
  });

  it("varies series (electric, oil) are never flagged", () => {
    expect(change([60, 80, 100, 70, 90, 110, 65, 200])).toHaveLength(0);
  });

  it("needs 4 prior occurrences", () => {
    expect(change([10, 10, 10, 12])).toHaveLength(0);
    expect(change([10, 10, 10, 10, 12])).toHaveLength(1);
  });
});

describe("history differs from the record", () => {
  const weekly250 = rowsFor(every(7, 12, "2026-10-05"), 250, { payee: "toyota", tagIds: ["TL"] });
  const lexus = ref({ label: "Lexus Financial", tagKey: `${E1}|TL`, monthly: new Decimal(250), expectedAmount: new Decimal(250), cadence: "monthly" });

  it("monthly record vs weekly history (the live Lexus case)", () => {
    const r = detect(weekly250, [lexus]);
    const flags = r.flags.filter((f) => f.type === "history_differs");
    expect(flags).toHaveLength(1);
    expect(flags[0]?.text).toBe("Lexus Financial: your records say $250.00 monthly; history shows about $250.00 every week.");
    expect(r.suggestions).toHaveLength(0); // the weekly series is suppressed by the tag
  });

  it("same cadence, amount more than 25% away", () => {
    const monthlyRows = rowsFor(monthly(10, 6), 150, { payee: "heating co", tagIds: ["TH"] });
    const rec = (m: number) => ref({ label: "Heating", tagKey: `${E1}|TH`, monthly: new Decimal(m), expectedAmount: new Decimal(m) });
    const texts = (m: number) => detect(monthlyRows, [rec(m)]).flags.filter((f) => f.type === "history_differs").map((f) => f.text);
    expect(texts(100)).toEqual(["Heating: your records say about $100.00 a month; history shows about $150.00 a month."]);
    expect(texts(124)).toEqual([]);
  });

  it("a swinging amount is not compared (only the cadence check applies to it)", () => {
    const swing = rowsFor(monthly(10, 6), [41, 160, 80, 300, 55, 120], { payee: "eversource", tagIds: ["TE"] });
    const rec = ref({ label: "Eversource", tagKey: `${E1}|TE`, monthly: new Decimal(83), expectedAmount: new Decimal(83) });
    expect(detect(swing, [rec]).flags.filter((f) => f.type === "history_differs")).toHaveLength(0);
  });

  it("mixed spacing in the history (a weekly record next to monthly-ish rows) raises no cadence claim", () => {
    const mixed = rowsFor(["2026-03-02", "2026-03-31", "2026-04-02", "2026-04-30", "2026-05-02", "2026-05-31", "2026-06-02", "2026-06-30"], 285, { payee: "doggy daycare", tagIds: ["TD"] });
    const rec = ref({ label: "Doggy Daycare", tagKey: `${E1}|TD`, monthly: new Decimal("310.56"), expectedAmount: new Decimal("71.67"), cadence: "weekly" });
    expect(detect(mixed, [rec], d("2026-07-01")).flags.filter((f) => f.type === "history_differs")).toHaveLength(0);
  });

  it("a budget category holding several payees is not one bill", () => {
    const mixed = [
      ...rowsFor(every(7, 6, "2026-10-05"), 30, { payee: "shop a", tagIds: ["TX"] }),
      ...rowsFor(every(9, 6, "2026-10-04"), 40, { payee: "shop b", tagIds: ["TX"] }),
      ...rowsFor(every(11, 6, "2026-10-03"), 50, { payee: "shop c", tagIds: ["TX"] }),
    ];
    expect(detect(mixed, [ref({ label: "Shopping", tagKey: `${E1}|TX`, monthly: new Decimal(100) })]).flags).toHaveLength(0);
  });
});

describe("determinism and purity", () => {
  it("input order does not change the output", () => {
    const rows = [
      ...rowsFor(monthly(5, 6), 28.7, { payee: "netflix", tagIds: ["T1"] }),
      ...rowsFor(monthly(14, 6), 40, { payee: "gym club", accountId: A2 }),
      ...rowsFor(every(7, 6, "2026-10-05"), 31, { payee: "pool service" }),
    ];
    const shape = (r: DetectResult) =>
      JSON.stringify({ s: r.suggestions.map((x) => [x.key, x.confidence, x.nextExpected]), f: r.flags.map((x) => x.text), n: r.suppressedCount });
    const a = detect(rows, [ref({ label: "Streaming", tagKey: `${E1}|T1` })]);
    const b = detect([...rows].reverse(), [ref({ label: "Streaming", tagKey: `${E1}|T1` })]);
    expect(shape(a)).toBe(shape(b));
  });

  it("the detector source imports no DB, no next/*, and reads no clock", () => {
    const src = readFileSync(path.resolve(__dirname, "../recurring-detect.ts"), "utf8");
    expect(src).not.toMatch(/from "@\/lib\/db"/);
    expect(src).not.toMatch(/from "next\//);
    expect(src).not.toMatch(/Date\.now\(/);
    expect(src).not.toMatch(/new Date\(\)/);
    expect(src).not.toMatch(/^\s*["']use server["']/m);
    expect(src).not.toMatch(/\.get(Hours|Date|Day|Month|FullYear)\(/); // local-time getters (getUTC* only)
  });
});

describe("dismissals", () => {
  const key = `${E1}|${A1}|out|netflix`;

  it("parseDismissed fails soft on anything unreadable", () => {
    for (const bad of [null, undefined, "", "not json", "[]", '{"keys":5}', '{"keys":[1,null,{"x":1}]}']) {
      expect(parseDismissed(bad as string | null | undefined)).toEqual([]);
    }
    expect(parseDismissed('{"v":1,"keys":[{"k":"a|b|out|c","at":"2026-10-01T00:00:00.000Z"}]}')).toHaveLength(1);
  });

  it("serialize caps at 200 and keeps the newest", () => {
    const entries = Array.from({ length: 205 }, (_, i) => ({ k: `${E1}|${A1}|out|p${i}`, at: "" }));
    const parsed = parseDismissed(serializeDismissed(entries));
    expect(parsed).toHaveLength(DISMISSED_CAP);
    expect(parsed[parsed.length - 1]?.k).toBe(`${E1}|${A1}|out|p204`);
    expect(addDismissed(entries.slice(0, 200), key, "x")).toHaveLength(200);
  });

  it("a dismissed key matches the same series or a token-prefix of it, never another entity or account", () => {
    expect(keysRelated(key, key)).toBe(true);
    expect(keysRelated(key, `${key} com`)).toBe(true);
    expect(keysRelated(`${key} com`, key)).toBe(true);
    expect(keysRelated(key, `${E1}|${A1}|out|netflixes`)).toBe(false);
    expect(keysRelated(key, `${E2}|${A1}|out|netflix`)).toBe(false);
    expect(keysRelated(key, `${E1}|${A2}|out|netflix`)).toBe(false);
    expect(isDismissed(key, [{ k: `${key} com`, at: "" }])).toBe(true);
  });

  it("add is idempotent and remove restores", () => {
    const once = addDismissed([], key, "t1");
    expect(addDismissed(once, key, "t2")).toEqual(once);
    expect(removeDismissed(once, key)).toEqual([]);
  });

  it("applyDismissals splits suggestions and drops flags about a dismissed series", () => {
    const rows = [...rowsFor(monthly(3, 6), 40, { payee: "gym club" }), ...rowsFor(monthly(14, 6), 28.7, { payee: "netflix" })];
    const result = detect(rows, [], d("2026-10-08"));
    const gym = result.suggestions.find((s) => s.payee === "Gym Club") as Series;
    const bundle = applyDismissals(result, [{ k: gym.key, at: "" }]);
    expect(bundle.suggestions.map((s) => s.payee)).toEqual(["Netflix"]);
    expect(bundle.dismissed.map((s) => s.payee)).toEqual(["Gym Club"]);
    expect(bundle.flags.every((f) => f.seriesKey !== gym.key)).toBe(true);
  });
});
