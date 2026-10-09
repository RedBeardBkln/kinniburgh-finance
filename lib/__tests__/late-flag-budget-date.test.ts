// net-income-budget-dates: the "expected, has not posted" flag, the clearing-lag explanation and the altDay matching.
// Rule: a bill is dated by its Budget row (money must be in the account then); the bank may clear it a few days later.
// A bill due the 14th that clears the 17th is measured from when it posts (not flagged on the 15th/16th/20th); a due
// date moved LATER than the history shows is not "late" before its new date.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { applyClearingNotes, clearingText, detectRecurring, type TxRow, type ClearingLag } from "@/lib/recurring-detect";
import type { ModelledRef, UpcomingItem } from "@/lib/upcoming-ledger";

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function mk(payee: string, dates: string[], amount: number | string): TxRow[] {
  return dates.map((d) => ({
    entityId: "E1",
    accountId: "A1",
    accountType: "checking",
    payee,
    amount: new Decimal(amount).negated(),
    postedAt: D(d),
    tagIds: [],
  }));
}
/** The same day of each month, starting at (y, m0) for n months. */
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
const run = (rows: TxRow[], today: string, modelled: ModelledRef[]) => detectRecurring({ rows, modelled, today: D(today) });
const lateFlags = (r: ReturnType<typeof run>) => r.flags.filter((f) => f.type === "late");

describe("late flag: due on the 14th, clears the 17th (Solar-shaped)", () => {
  // Six payments posted on the 17th, Apr to Sep. Budget says day 14.
  const rows = mk("solar", months(2026, 3, 6, 17), "200");
  const modelled = [ref({ label: "Solar", day: 14, monthly: new Decimal("200") })];

  it("is not flagged on the 15th, 16th or 20th", () => {
    for (const today of ["2026-10-15", "2026-10-16", "2026-10-20"]) expect(lateFlags(run(rows, today, modelled))).toEqual([]);
  });
  it("is flagged once it is well past the day it normally posts (the 23rd)", () => {
    const flags = lateFlags(run(rows, "2026-10-23", modelled));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.text).toBe("Solar usually posts around the 17th; none seen yet this month.");
  });
});

describe("late flag: a due date moved LATER than the history shows (new floor)", () => {
  // History on the 14th, but the owner moved the bill to the 20th.
  const rows = mk("solar", months(2026, 3, 6, 14), "200");
  it("is not flagged before the new due date plus grace", () => {
    const moved = [ref({ label: "Solar", day: 20, monthly: new Decimal("200") })];
    expect(lateFlags(run(rows, "2026-10-19", moved))).toEqual([]);
    expect(lateFlags(run(rows, "2026-10-24", moved))).toEqual([]);
  });
  it("is flagged after the new due date plus grace, worded as a due date", () => {
    const moved = [ref({ label: "Solar", day: 20, monthly: new Decimal("200") })];
    const flags = lateFlags(run(rows, "2026-10-26", moved));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.text).toBe("Solar is due on the 20th; none seen yet this month.");
  });
  it("without the floor (the record still says the 14th) the same history IS flagged on the 19th", () => {
    const stale = [ref({ label: "Solar", day: 14, monthly: new Decimal("200") })];
    expect(lateFlags(run(rows, "2026-10-19", stale))).toHaveLength(1);
  });
  it("a due day more than 7 days after the history is not used as a floor", () => {
    const far = [ref({ label: "Solar", day: 25, monthly: new Decimal("200") })];
    const flags = lateFlags(run(rows, "2026-10-19", far));
    expect(flags[0]?.text).toBe("Solar usually posts around the 14th; none seen yet this month.");
  });
  it("a payment that already posted this month is never late", () => {
    const posted = [...rows, ...mk("solar", ["2026-10-14"], "200")];
    const moved = [ref({ label: "Solar", day: 20, monthly: new Decimal("200") })];
    expect(lateFlags(run(posted, "2026-10-30", moved))).toEqual([]);
  });
  it("a record with no day behaves as before (observed day only)", () => {
    const flags = lateFlags(run(rows, "2026-10-19", [ref({ label: "Solar", day: null, monthly: new Decimal("200") })]));
    expect(flags[0]?.text).toBe("Solar usually posts around the 14th; none seen yet this month.");
  });
  it("weekly records are untouched by the floor", () => {
    const weekly = mk("doggy", ["2026-08-05", "2026-08-12", "2026-08-19", "2026-08-26", "2026-09-02", "2026-09-09"], "50");
    const f = lateFlags(run(weekly, "2026-09-30", [ref({ label: "Doggy", cadence: "weekly", day: 20 })]));
    expect(f[0]?.text).toBe("Doggy usually posts every week; none seen since Sep 9.");
  });
});

describe("altDay: a bill dated by its Budget row still matches history that lands on the record's day", () => {
  it("suppression (amount + day) accepts either the budget day or the record day", () => {
    const rows = mk("xfinity", months(2026, 3, 6, 17), "65.95");
    const m = (o: Partial<ModelledRef>) => [ref({ label: "Comcast", monthly: new Decimal("65.95"), day: 10, ...o })];
    expect(run(rows, "2026-10-08", m({})).suggestions).toHaveLength(1); // day 10 vs 17: too far apart
    expect(run(rows, "2026-10-08", m({ altDay: 17 })).suppressed).toHaveLength(1);
    expect(run(rows, "2026-10-08", m({ altDay: 25 })).suggestions).toHaveLength(1);
  });
  it("history matching by amount + day also accepts the record's day", () => {
    const rows = mk("zzyzx widgets", months(2026, 3, 6, 17), "40");
    const base = { label: "Mystery", day: 10, expectedAmount: new Decimal("40"), monthly: new Decimal("40") };
    // (only flags about the RECORDED item: the history itself also forms a learned series with its own flag)
    const recorded = (r: ReturnType<typeof run>) => lateFlags(r).filter((f) => f.modelled !== null);
    expect(recorded(run(rows, "2026-10-25", [ref(base)]))).toEqual([]);
    const flags = recorded(run(rows, "2026-10-25", [ref({ ...base, altDay: 17 })]));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.text).toBe("Mystery usually posts around the 17th; none seen yet this month.");
  });
});

describe("clearing lag (explanatory text only)", () => {
  const solar = (extra: Partial<ModelledRef> = {}) => [ref({ label: "Solar", day: 14, monthly: new Decimal("200"), ...extra })];
  const clearing = (rows: TxRow[], m: ModelledRef[], today = "2026-10-09") => run(rows, today, m).clearing ?? [];

  it("reports the usual posting day and the lag when 3+ payments of the last 6 months post steadily 1 to 7 days later", () => {
    const rows = mk("solar", months(2026, 3, 6, 17), "200");
    expect(clearing(rows, solar())).toEqual([{ source: "scheduled_bill", sourceId: "ref-Solar", typicalDay: 17, lagDays: 3, samples: 6 }]);
  });
  it("tolerates a spread of 2 days (17th and 18th)", () => {
    const rows = [...mk("solar", ["2026-06-17", "2026-08-17"], "200"), ...mk("solar", ["2026-07-18", "2026-09-18"], "200")];
    const c = clearing(rows, solar());
    expect(c).toHaveLength(1);
    expect(c[0]!.lagDays).toBeGreaterThanOrEqual(3);
  });
  it("needs 3 payments in the last 6 months", () => {
    expect(clearing(mk("solar", ["2026-08-17", "2026-09-17"], "200"), solar())).toEqual([]);
    const old = mk("solar", ["2026-01-17", "2026-02-17", "2026-03-17", "2026-08-17", "2026-09-17"], "200");
    expect(clearing(old, solar())).toEqual([]); // only 2 inside the last six months
  });
  it("is not reported when the day is not steady (spread over 2)", () => {
    const rows = mk("solar", ["2026-07-15", "2026-08-21", "2026-09-17", "2026-06-19"], "200");
    expect(clearing(rows, solar())).toEqual([]);
  });
  it("is not reported for a lag of 0 or more than 7 days, a missing day or a non-monthly record", () => {
    expect(clearing(mk("solar", months(2026, 3, 6, 14), "200"), solar())).toEqual([]);
    expect(clearing(mk("solar", months(2026, 3, 6, 23), "200"), solar())).toEqual([]); // 9 days
    expect(clearing(mk("solar", months(2026, 3, 6, 17), "200"), solar({ day: null }))).toEqual([]);
    expect(clearing(mk("solar", months(2026, 3, 6, 17), "200"), solar({ cadence: "weekly" }))).toEqual([]);
  });
  it("a tagged record paid from ANOTHER account than it is recorded on still gets its clearing lag (Solar: envelope vs checking), but no late flag", () => {
    const rows = mk("enerbank usa acct paymt", months(2026, 3, 6, 17), "505.70").map((r) => ({ ...r, tagIds: ["T1"] }));
    const m = solar({ accountId: "A-envelope", tagKey: "E1|T1" });
    const r = run(rows, "2026-10-09", m);
    expect(r.clearing).toEqual([{ source: "scheduled_bill", sourceId: "ref-Solar", typicalDay: 17, lagDays: 3, samples: 6 }]);
    // the late flag keeps the stricter account match (nothing is raised for this record even a long time after the 17th)
    expect(lateFlags(run(rows, "2026-10-30", m)).filter((f) => f.modelled !== null)).toEqual([]);
  });
  it("an untagged record on another account gets no clearing lag", () => {
    const rows = mk("solar", months(2026, 3, 6, 17), "200");
    expect(clearing(rows, solar({ accountId: "A-envelope" }))).toEqual([]);
  });
  it("does not change which flags are raised", () => {
    const rows = mk("solar", months(2026, 3, 6, 17), "200");
    const a = run(rows, "2026-10-20", solar());
    expect(a.flags).toEqual([]);
    expect(a.clearing).toHaveLength(1);
  });

  describe("applyClearingNotes", () => {
    const item = (over: Partial<UpcomingItem> = {}): UpcomingItem => ({
      id: "scheduled_bill:b1:2026-10-14",
      date: D("2026-10-14"),
      amount: new Decimal("-200"),
      amountStatus: "known",
      label: "Solar",
      source: "scheduled_bill",
      kind: "bill",
      tier: "scheduled",
      entityId: "E1",
      sourceId: "b1",
      link: { page: "forecast" },
      alsoRecordedAs: [],
      discrepancies: [],
      notes: [],
      ...over,
    });
    const lag: ClearingLag = { source: "scheduled_bill", sourceId: "b1", typicalDay: 17, lagDays: 3, samples: 6 };

    it("appends 'Usually clears about the 17th.' to the date note and never moves the item", () => {
      const withNote = item({ dateNote: "Dated by the budget (day 14) because the money has to be in the account then. The bill record says day 17. The bank may take a few days to clear it." });
      const plain = item({ id: "x", sourceId: "b1" });
      const date = withNote.date;
      applyClearingNotes([withNote, plain], [lag]);
      expect(withNote.dateNote).toMatch(/to clear it\. Usually clears about the 17th\.$/);
      expect(plain.dateNote).toBe("Usually clears about the 17th.");
      expect(withNote.date).toBe(date);
      expect(withNote.amount?.toFixed(2)).toBe("-200.00");
    });
    it("ignores items of other sources, undated items and non-bills; no clearing data is a no-op", () => {
      const other = item({ sourceId: "other" });
      const undated = item({ date: null });
      const card = item({ kind: "card" });
      applyClearingNotes([other, undated, card], [lag]);
      expect([other.dateNote, undated.dateNote, card.dateNote]).toEqual([undefined, undefined, undefined]);
      const untouched = item();
      applyClearingNotes([untouched], undefined);
      applyClearingNotes([untouched], []);
      expect(untouched.dateNote).toBeUndefined();
    });
    it("clearingText is observational", () => {
      expect(clearingText({ typicalDay: 3 })).toBe("Usually clears about the 3rd.");
      expect(clearingText({ typicalDay: 22 })).toBe("Usually clears about the 22nd.");
    });
  });
});
