// "Also add to later saved months": the pure planner, the create rows, the earlier-month guard with later rows, the
// wording, and the read-only preview loader (which must equal the planner the write uses).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  addChangesEarlierMonth,
  planAddToLaterMonths,
  toLaterCreateRows,
  type MaterializableRow,
} from "@/lib/budget-materialize";
import { addLaterMonthsLabel, addLaterMonthsPreview } from "@/lib/budget-first-edit-note";
import { D, budgetRow, createFakeBudgetDb, type FakeBudgetRow } from "./budget-fake-db";

const m = vi.hoisted(() => ({ current: { db: null as unknown } }));
vi.mock("@/lib/db", () => ({
  get db() {
    return m.current.db;
  },
}));

import { loadLaterAddContext, loadLaterAddContextSafe } from "@/lib/budget-carry-forward-build";

const P = "ent-p";
const S = "ent-s";

function row(entityId: string, tagId: string, period: string, over: Partial<FakeBudgetRow> = {}): MaterializableRow {
  return budgetRow({ entityId, tagId, period, ...over }) as MaterializableRow;
}
const loc = (tagId: string, period: string, entityId = P) => ({ entityId, tagId, period });

describe("planAddToLaterMonths", () => {
  const world = [row(P, "rent", "2026-08"), row(P, "rent", "2026-12")];

  it("M before the latest month: every month after M up to the latest gets the line (empty in-between months included)", () => {
    const plan = planAddToLaterMonths(world, loc("new", "2026-09"));
    expect(plan.through).toBe("2026-12");
    // 2026-10 and 2026-11 are empty today; the first-edit save fills them, so they count
    expect(plan.months).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(plan.skipped).toEqual([]);
  });

  it("M equal to or after the latest month, or an entity with no rows: nothing", () => {
    for (const p of ["2026-12", "2027-03"]) {
      expect(planAddToLaterMonths(world, loc("new", p))).toEqual({ through: null, months: [], skipped: [] });
    }
    expect(planAddToLaterMonths(world, loc("new", "2026-09", S))).toEqual({ through: null, months: [], skipped: [] });
    expect(planAddToLaterMonths([], loc("new", "2026-09"))).toEqual({ through: null, months: [], skipped: [] });
  });

  it("a later month that already has the line (own row) is skipped as already_has, the others are added", () => {
    const rows = [...world, row(P, "new", "2026-11")];
    const plan = planAddToLaterMonths(rows, loc("new", "2026-09"));
    expect(plan.months).toEqual(["2026-10", "2026-12"]);
    expect(plan.skipped).toEqual([{ period: "2026-11", reason: "already_has" }]);
  });

  it("re-adding after End line: the ended line has no rows from its end month on, so it gets the later months it lacks", () => {
    const rows = [row(P, "rent", "2026-08"), row(P, "rent", "2026-12"), row(P, "ended", "2026-08"), row(P, "ended", "2026-09")];
    const plan = planAddToLaterMonths(rows, loc("ended", "2026-10"));
    expect(plan.months).toEqual(["2026-11", "2026-12"]);
  });

  it("another entity holding the tag (own row or carried into the month) is skipped as other_entity; its rows never enter the plan", () => {
    const rows = [
      ...world,
      row(S, "shared", "2026-11"), // Sudden Valley: own row in 2026-11, carried after (its latest month)
      row(S, "other", "2026-08"),
      row(S, "other", "2026-12"), // S's latest month does not have "shared": it has ended, nothing is carried
    ];
    const plan = planAddToLaterMonths(rows, loc("shared", "2026-09"));
    // S holds "shared" only in its own 2026-11 row (2026-10 is before its first row: never carried backwards)
    expect(plan.skipped).toEqual([{ period: "2026-11", reason: "other_entity" }]);
    expect(plan.months).toEqual(["2026-10", "2026-12"]);
    // carried case: S's latest month is 2026-08 and holds the tag, so S carries it into every later month
    const carried = [...world, row(S, "shared", "2026-08")];
    const plan2 = planAddToLaterMonths(carried, loc("shared", "2026-09"));
    expect(plan2.months).toEqual([]);
    expect(plan2.skipped.map((s) => s.reason)).toEqual(["other_entity", "other_entity", "other_entity"]);
  });

  it("the line is not put on the latest month when another entity holds the tag in a month the line would then be carried into", () => {
    // Sudden Valley has the tag only from 2027-02 on (its latest month); Personal's latest month is 2026-12.
    const rows = [...world, row(S, "x", "2026-12"), row(S, "shared", "2027-02")];
    const plan = planAddToLaterMonths(rows, loc("shared", "2026-09"));
    expect(plan.months).toEqual(["2026-10", "2026-11"]);
    expect(plan.skipped).toEqual([{ period: "2026-12", reason: "other_entity" }]);
    // without the other entity every later month is added
    expect(planAddToLaterMonths(world, loc("shared", "2026-09")).months).toEqual(["2026-10", "2026-11", "2026-12"]);
  });

  it("a month with no rows even after the save (M before the entity's first row) is no_rows and never created", () => {
    const rows = [row(P, "rent", "2026-10"), row(P, "rent", "2026-12")];
    const plan = planAddToLaterMonths(rows, loc("new", "2026-07"));
    // M is before the entity's first row, so nothing is saved first: the empty months stay empty and are never created
    expect(plan.months).toEqual(["2026-10", "2026-12"]);
    expect(plan.skipped).toEqual([
      { period: "2026-08", reason: "no_rows" },
      { period: "2026-09", reason: "no_rows" },
      { period: "2026-11", reason: "no_rows" },
    ]);
  });

  it("reads only the entity's own rows for months and frontier (another entity's later months do not extend it)", () => {
    const rows = [...world, row(S, "x", "2027-06")];
    expect(planAddToLaterMonths(rows, loc("new", "2026-09")).through).toBe("2026-12");
  });
});

describe("toLaterCreateRows", () => {
  it("copies the line's fields to each month; rollover and the additional amount are reset", () => {
    const anchor = new Date("2026-03-04T00:00:00Z");
    const out = toLaterCreateRows(loc("t", "2026-09"), ["2026-10", "2026-11"], {
      accountId: "acc",
      budgeted: new Decimal("12.34"),
      payDay: 5,
      frequency: "biweekly",
      payDayOfWeek: 2,
      biweeklyAnchorDate: anchor,
      payMonth: null,
      annualAmountDue: null,
    });
    expect(out.map((r) => r.period)).toEqual(["2026-10", "2026-11"]);
    for (const r of out) {
      expect(r).toMatchObject({
        entityId: P,
        tagId: "t",
        accountId: "acc",
        payDay: 5,
        frequency: "biweekly",
        payDayOfWeek: 2,
        biweeklyAnchorDate: anchor,
        payMonth: null,
        annualAmountDue: null,
        additionalAmountCents: 0,
        rolloverEnabled: false,
        rolloverAmount: null,
      });
      expect(r.budgeted?.toString()).toBe("12.34");
    }
  });

  it("a blank amount (auto-sum parent) stays null; an annual line keeps month and amount due", () => {
    const [a] = toLaterCreateRows(loc("t", "2026-09"), ["2026-10"], {
      accountId: "acc",
      budgeted: null,
      payDay: 15,
      frequency: "annual",
      payDayOfWeek: null,
      biweeklyAnchorDate: null,
      payMonth: 6,
      annualAmountDue: new Decimal("1200"),
    });
    expect(a!.budgeted).toBeNull();
    expect(a!.payMonth).toBe(6);
    expect(a!.annualAmountDue?.toString()).toBe("1200");
  });

  it("no months, no rows", () => {
    expect(toLaterCreateRows(loc("t", "2026-09"), [], { accountId: "a", budgeted: null, payDay: null, frequency: "monthly", payDayOfWeek: null, biweeklyAnchorDate: null, payMonth: null, annualAmountDue: null })).toEqual([]);
  });
});

describe("addChangesEarlierMonth with later months", () => {
  // An ended line "old" (January only) and two lines that start in May; 2026-02..04 have no rows.
  const rows = [
    row(P, "old", "2026-01"),
    row(P, "a", "2026-05"),
    row(P, "b", "2026-05"),
    row(P, "a", "2026-08"),
    row(P, "b", "2026-08"),
  ];

  it("the default argument behaves as before", () => {
    expect(addChangesEarlierMonth(rows, loc("old", "2026-06"))).toBe(addChangesEarlierMonth(rows, loc("old", "2026-06"), []));
    expect(addChangesEarlierMonth(rows, loc("old", "2026-06"))).toBeNull();
  });

  it("re-adding the ended line before the latest month: the add alone is fine, but landing on the latest month would revive it in the empty months before", () => {
    const plan = planAddToLaterMonths(rows, loc("old", "2026-06"));
    expect(plan.months).toEqual(["2026-07", "2026-08"]);
    expect(addChangesEarlierMonth(rows, loc("old", "2026-06"), plan.months)).toBe("2026-02");
    // a brand-new line has no older rows to carry back, so ticking is fine
    const fresh = planAddToLaterMonths(rows, loc("new", "2026-06"));
    expect(addChangesEarlierMonth(rows, loc("new", "2026-06"), fresh.months)).toBeNull();
  });

  it("a world with no gap months stays unchanged by the later rows", () => {
    const rows = [row(P, "rent", "2026-08"), row(P, "rent", "2026-12")];
    const plan = planAddToLaterMonths(rows, loc("new", "2026-09"));
    expect(addChangesEarlierMonth(rows, loc("new", "2026-09"), plan.months)).toBeNull();
  });
});

describe("wording", () => {
  it("label", () => {
    expect(addLaterMonthsLabel("2026-12")).toBe("Also add to later saved months (through December 2026)");
  });

  it("preview: one month, several months, skipped suffix, nothing", () => {
    expect(addLaterMonthsPreview(["2026-11"], "2026-11", 0)).toBe(
      "This line will also be added to 1 later month: November 2026. It will then carry forward after November 2026 like your other lines."
    );
    expect(addLaterMonthsPreview(["2026-11", "2026-12", "2027-01"], "2027-01", 0)).toBe(
      "This line will also be added to 3 later months: November 2026 to January 2027. It will then carry forward after January 2027 like your other lines."
    );
    const skipped = addLaterMonthsPreview(["2026-11", "2026-12"], "2027-01", 2);
    expect(skipped).toContain("2 later months already have it or use this category under another entity and are left alone.");
    expect(addLaterMonthsPreview(["2026-11"], "2027-01", 1)).toContain("1 later month already has it or uses this category under another entity and is left alone.");
    expect(addLaterMonthsPreview([], "2026-12", 3)).toBeNull();
  });
});

describe("loadLaterAddContext (the preview) equals the planner the write uses", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = createFakeBudgetDb({
      rows: [
        budgetRow({ entityId: P, tagId: "rent", period: "2026-08", budgeted: D("10") }),
        budgetRow({ entityId: P, tagId: "rent", period: "2026-12", budgeted: D("10") }),
        budgetRow({ entityId: P, tagId: "has", period: "2026-12", budgeted: D("10") }), // already in the latest month
        budgetRow({ entityId: S, tagId: "sv", period: "2026-09", budgeted: D("5") }), // S carries it after 2026-09
      ],
    });
    m.current.db = fake.db;
  });

  it("candidates are the months with rows after the save; per tag the skipped ones; both match planAddToLaterMonths", async () => {
    const ctx = await loadLaterAddContext({ period: "2026-09", entityId: P });
    expect(ctx).not.toBeNull();
    expect(ctx!.through).toBe("2026-12");
    expect(ctx!.candidates).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(ctx!.skippedByTag["has"]).toEqual(["2026-12"]);
    expect(ctx!.skippedByTag["sv"]).toEqual(["2026-10", "2026-11", "2026-12"]); // another entity holds it from 2026-10 on (carried)
    expect(ctx!.skippedByTag["sv"]).not.toContain("2026-09");

    const all = (m.current.db as ReturnType<typeof createFakeBudgetDb>["db"]);
    const rows = (await all.budget.findMany({ take: 5000 })) as unknown as MaterializableRow[];
    for (const tagId of ["rent", "has", "sv", "brand-new"]) {
      const plan = planAddToLaterMonths(rows, loc(tagId, "2026-09"));
      const preview = ctx!.candidates.filter((c) => !(ctx!.skippedByTag[tagId] ?? []).includes(c));
      expect(preview, tagId).toEqual(plan.months);
    }
  });

  it("null when there is nothing to offer: no entity, bad period, month not before the latest, or an entity without rows", async () => {
    expect(await loadLaterAddContext({ period: "2026-09", entityId: null })).toBeNull();
    expect(await loadLaterAddContext({ period: "2026-13", entityId: P })).toBeNull();
    expect(await loadLaterAddContext({ period: "2026-12", entityId: P })).toBeNull();
    expect(await loadLaterAddContext({ period: "2027-02", entityId: P })).toBeNull();
    expect(await loadLaterAddContext({ period: "2026-09", entityId: "nobody" })).toBeNull();
  });

  it("is read-only with an explicit select", async () => {
    const fake = createFakeBudgetDb({ rows: [] });
    const spy = vi.spyOn(fake.db.budget, "findMany");
    m.current.db = fake.db;
    await loadLaterAddContext({ period: "2026-09", entityId: P });
    const arg = spy.mock.calls[0]![0] as { select: Record<string, unknown>; include?: unknown };
    expect(arg.include).toBeUndefined();
    expect(Object.values(arg.select).every((v) => v === true)).toBe(true);
  });

  it("the Safe variant never rejects: a read failure gives null and logs only the error name", async () => {
    m.current.db = {
      budget: {
        findMany: async () => {
          throw new TypeError("secret detail");
        },
      },
    };
    expect(await loadLaterAddContextSafe({ period: "2026-09", entityId: P })).toBeNull();
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain("secret detail");
  });
});
