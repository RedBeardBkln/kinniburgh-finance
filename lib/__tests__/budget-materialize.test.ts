import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  MAX_EDIT_MONTHS_AHEAD,
  addChangesEarlierMonth,
  carriedMonthNotice,
  effectiveLineAt,
  formatPeriodLabel,
  isPeriod,
  isTooFarAhead,
  periodRange,
  planEndLine,
  planMaterialization,
  shiftPeriod,
  tagHoldersAt,
  type MaterializableRow,
} from "@/lib/budget-materialize";
import { resolveEffectiveRows } from "@/lib/budget-carry-forward";

const P = "ent-personal";
const S = "ent-sv";
let n = 0;
function row(over: Partial<MaterializableRow> & Pick<MaterializableRow, "entityId" | "tagId" | "period">): MaterializableRow {
  n += 1;
  return {
    id: `r${n}`,
    accountId: "acct-1",
    budgeted: new Decimal("100"),
    payDay: null,
    frequency: "monthly",
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    payMonth: null,
    annualAmountDue: null,
    rolloverEnabled: false,
    rolloverAmount: null,
    additionalAmountCents: new Decimal(0),
    ...over,
  };
}
const periodsOf = (plan: { creates: Array<{ period: string }> }) => [...new Set(plan.creates.map((c) => c.period))];
const tagsAt = (plan: { creates: Array<{ period: string; tagId: string }> }, period: string) =>
  plan.creates.filter((c) => c.period === period).map((c) => c.tagId).sort();

describe("period helpers", () => {
  it("shifts across year boundaries in both directions", () => {
    expect(shiftPeriod("2026-12", 1)).toBe("2027-01");
    expect(shiftPeriod("2027-01", -1)).toBe("2026-12");
    expect(shiftPeriod("2026-10", 24)).toBe("2028-10");
    expect(shiftPeriod("2026-10", -12)).toBe("2025-10");
    expect(shiftPeriod("2026-01", -13)).toBe("2024-12");
  });
  it("lists a range inclusively and returns nothing for a backwards range", () => {
    expect(periodRange("2026-11", "2027-02")).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(periodRange("2026-11", "2026-11")).toEqual(["2026-11"]);
    expect(periodRange("2027-01", "2026-12")).toEqual([]);
  });
  it("validates periods", () => {
    for (const ok of ["2026-01", "2027-12"]) expect(isPeriod(ok)).toBe(true);
    for (const bad of ["2026-13", "2026-00", "26-01", "2026-1", "", null, 202601]) expect(isPeriod(bad)).toBe(false);
    expect(() => shiftPeriod("nope", 1)).toThrow();
  });
  it("refuses edits more than 24 months after the current month", () => {
    expect(MAX_EDIT_MONTHS_AHEAD).toBe(24);
    expect(isTooFarAhead("2028-10", "2026-10")).toBe(false);
    expect(isTooFarAhead("2028-11", "2026-10")).toBe(true);
    expect(isTooFarAhead("2026-01", "2026-10")).toBe(false); // the past is editable, as before
  });
  it("labels a month in UTC calendar terms", () => {
    expect(formatPeriodLabel("2026-12")).toBe("December 2026");
    expect(formatPeriodLabel("2027-01")).toBe("January 2027");
    expect(formatPeriodLabel("junk")).toBe("junk");
  });
});

describe("planMaterialization: what is copied", () => {
  const anchor = new Date("2026-01-02T00:00:00.000Z");
  const source = row({
    entityId: P,
    tagId: "rent",
    period: "2026-12",
    accountId: "acct-9",
    budgeted: new Decimal("1500.5"),
    payDay: 3,
    frequency: "biweekly",
    payDayOfWeek: 5,
    biweeklyAnchorDate: anchor,
    payMonth: 4,
    annualAmountDue: new Decimal("900"),
    rolloverEnabled: true,
    rolloverAmount: new Decimal("77"),
    additionalAmountCents: new Decimal("5000"),
  });

  it("copies amount and schedule fields and the rollover FLAG, but never the rollover amount or the one-off additional amount", () => {
    const plan = planMaterialization([source], P, "2027-01");
    expect(plan.creates).toHaveLength(1);
    const c = plan.creates[0]!;
    expect(c).toEqual({
      entityId: P,
      tagId: "rent",
      period: "2027-01",
      accountId: "acct-9",
      budgeted: new Decimal("1500.5"),
      additionalAmountCents: 0,
      payDay: 3,
      frequency: "biweekly",
      payDayOfWeek: 5,
      biweeklyAnchorDate: anchor,
      payMonth: 4,
      annualAmountDue: new Decimal("900"),
      rolloverEnabled: true,
      rolloverAmount: null,
    });
    // no id and no other column leaks into the create
    expect(Object.keys(c).sort()).toEqual(
      ["accountId", "additionalAmountCents", "annualAmountDue", "biweeklyAnchorDate", "budgeted", "entityId", "frequency", "payDay", "payDayOfWeek", "payMonth", "period", "rolloverAmount", "rolloverEnabled", "tagId"]
    );
  });

  it("a blank (auto-sum) line stays blank", () => {
    const plan = planMaterialization([row({ entityId: P, tagId: "parent", period: "2026-12", budgeted: null })], P, "2027-01");
    expect(plan.creates[0]!.budgeted).toBeNull();
  });

  it("is exactly what the resolver already shows for that month (one source of truth)", () => {
    const rows = [source, row({ entityId: P, tagId: "food", period: "2026-12" }), row({ entityId: P, tagId: "food", period: "2026-11", budgeted: new Decimal("5") })];
    const plan = planMaterialization(rows, P, "2027-03");
    const shown = resolveEffectiveRows(rows, ["2027-03"]).filter((r) => r.source === "carried");
    const fromPlan = plan.creates.filter((c) => c.period === "2027-03").map((c) => [c.tagId, c.budgeted?.toString(), c.accountId, c.payDay, c.frequency]);
    expect(fromPlan).toEqual(shown.map((r) => [r.tagId, r.budgeted?.toString(), r.accountId, r.payDay, r.frequency]));
  });
});

describe("planMaterialization: which months and lines", () => {
  const dec = [row({ entityId: P, tagId: "a", period: "2026-12" }), row({ entityId: P, tagId: "b", period: "2026-12" })];

  it("an empty month after the frontier gets every carried line", () => {
    const plan = planMaterialization(dec, P, "2027-01");
    expect(periodsOf(plan)).toEqual(["2027-01"]);
    expect(tagsAt(plan, "2027-01")).toEqual(["a", "b"]);
    expect(plan.months).toEqual(["2027-01"]);
  });

  it("a complete month plans nothing and an own row is never recreated", () => {
    expect(planMaterialization(dec, P, "2026-12").creates).toEqual([]);
  });

  it("a month that has rows is authoritative: a line missing from it is NOT filled in (owner decision 2026-10-10)", () => {
    const rows = [
      row({ entityId: P, tagId: "a", period: "2026-11" }),
      row({ entityId: P, tagId: "b", period: "2026-11" }),
      row({ entityId: P, tagId: "a", period: "2026-12" }),
      row({ entityId: P, tagId: "b", period: "2026-12" }),
      row({ entityId: P, tagId: "c", period: "2026-12" }),
      // 2027-01 has only line "a" of its own, so b and c are the carried ones
      row({ entityId: P, tagId: "a", period: "2027-01" }),
    ];
    // 2027-01 is now the frontier and only "a" is in it: b and c have ended and do NOT carry
    expect(planMaterialization(rows, P, "2027-01").creates).toEqual([]);
    // and a month in the middle that has rows but lacks a line which is still in the frontier stays as it is
    const mid = [
      row({ entityId: P, tagId: "a", period: "2026-10" }),
      row({ entityId: P, tagId: "b", period: "2026-10" }),
      row({ entityId: P, tagId: "a", period: "2026-11" }),
      row({ entityId: P, tagId: "a", period: "2026-12" }),
      row({ entityId: P, tagId: "b", period: "2026-12" }),
    ];
    const plan = planMaterialization(mid, P, "2026-11");
    expect(plan.creates).toEqual([]);
  });

  it("an ended line (not in the entity's latest month) is not saved", () => {
    const rows = [
      row({ entityId: P, tagId: "old", period: "2026-11" }),
      row({ entityId: P, tagId: "keep", period: "2026-11" }),
      row({ entityId: P, tagId: "keep", period: "2026-12" }),
    ];
    const plan = planMaterialization(rows, P, "2027-02");
    expect(plan.creates.map((c) => c.tagId)).toEqual(["keep", "keep"]); // 2027-01 (gap) and 2027-02 (target), never "old"
    expect(periodsOf(plan)).toEqual(["2027-01", "2027-02"]);
  });

  it("variable (seasonal) lines are saved with their flat figure like any other line", () => {
    const rows = [row({ entityId: P, tagId: "electric", period: "2026-12", budgeted: new Decimal("172") }), row({ entityId: P, tagId: "oil", period: "2026-12", budgeted: new Decimal("308") })];
    const plan = planMaterialization(rows, P, "2027-01");
    expect(plan.creates.map((c) => [c.tagId, c.budgeted?.toString()])).toEqual([["electric", "172"], ["oil", "308"]]);
  });

  it("fills every empty month from the frontier up to the target (gap fill), each with the full carried set", () => {
    const plan = planMaterialization(dec, P, "2027-03");
    expect(periodsOf(plan)).toEqual(["2027-01", "2027-02", "2027-03"]);
    for (const p of periodsOf(plan)) expect(tagsAt(plan, p)).toEqual(["a", "b"]);
    expect(plan.creates).toHaveLength(6);
  });

  it("also fills a month with no row at all inside the entity's range", () => {
    const rows = [
      row({ entityId: P, tagId: "a", period: "2026-01" }),
      row({ entityId: P, tagId: "a", period: "2026-04" }), // 2026-02 and 03 have no row for any line
    ];
    const plan = planMaterialization(rows, P, "2026-04");
    expect(plan.creates.map((c) => [c.period, c.tagId])).toEqual([["2026-02", "a"], ["2026-03", "a"]]);
  });

  it("a month before the entity's first row gets nothing (a line is never carried backwards)", () => {
    expect(planMaterialization(dec, P, "2025-12").creates).toEqual([]);
  });

  it("an entity with no rows plans nothing (Mezzo), and an invalid period plans nothing", () => {
    expect(planMaterialization(dec, "ent-mezzo", "2027-01").creates).toEqual([]);
    expect(planMaterialization(dec, P, "2027-13").creates).toEqual([]);
  });

  it("entity separation: another entity's rows and frontier never matter", () => {
    const rows = [
      ...dec,
      row({ entityId: S, tagId: "sv-oil", period: "2026-09" }),
      row({ entityId: S, tagId: "sv-tax", period: "2027-06" }), // a far-future SV row
    ];
    const plan = planMaterialization(rows, P, "2027-01");
    expect(plan.creates.every((c) => c.entityId === P)).toBe(true);
    expect(tagsAt(plan, "2027-01")).toEqual(["a", "b"]);
    const sv = planMaterialization(rows, S, "2027-07");
    expect(sv.creates.every((c) => c.entityId === S)).toBe(true);
    expect(sv.creates.map((c) => c.tagId)).toEqual(["sv-tax"]); // sv-oil ended in SV's own frontier
  });

  it("the output order is deterministic (month, then tag)", () => {
    const shuffled = [dec[1]!, dec[0]!];
    expect(planMaterialization(shuffled, P, "2027-02").creates.map((c) => c.period + c.tagId)).toEqual(planMaterialization(dec, P, "2027-02").creates.map((c) => c.period + c.tagId));
  });
});

describe("effectiveLineAt and tagHoldersAt", () => {
  const rows = [row({ entityId: P, tagId: "a", period: "2026-12" }), row({ entityId: S, tagId: "b", period: "2026-12" })];
  it("finds an own row, a carried row, and nothing for an unknown or ended line", () => {
    expect(effectiveLineAt(rows, { entityId: P, tagId: "a", period: "2026-12" })?.source).toBe("own");
    expect(effectiveLineAt(rows, { entityId: P, tagId: "a", period: "2027-05" })?.source).toBe("carried");
    expect(effectiveLineAt(rows, { entityId: P, tagId: "zzz", period: "2027-05" })).toBeNull();
    expect(effectiveLineAt(rows, { entityId: P, tagId: "b", period: "2027-05" })).toBeNull(); // b belongs to SV
    expect(effectiveLineAt(rows, { entityId: P, tagId: "a", period: "2025-01" })).toBeNull(); // before the first row
  });
  it("a tag is held household-wide, own or carried", () => {
    expect(tagHoldersAt(rows, "a", "2027-03")).toEqual([P]);
    expect(tagHoldersAt(rows, "b", "2027-03")).toEqual([S]);
    expect(tagHoldersAt(rows, "nope", "2027-03")).toEqual([]);
  });
});

describe("planEndLine (Delete ends the line from this month on)", () => {
  const rows = [
    row({ entityId: P, tagId: "a", period: "2026-10" }),
    row({ entityId: P, tagId: "b", period: "2026-10" }),
    row({ entityId: P, tagId: "a", period: "2026-11" }),
    row({ entityId: P, tagId: "b", period: "2026-11" }),
    row({ entityId: P, tagId: "a", period: "2026-12" }),
    row({ entityId: P, tagId: "b", period: "2026-12" }),
  ];

  it("a month inside the range deletes the line's rows from that month on and nothing earlier", () => {
    const plan = planEndLine(rows, { entityId: P, tagId: "b", period: "2026-11" });
    expect(plan).toMatchObject({ ok: true, deleteCount: 2, hadOwnRowAtTarget: true });
    expect(plan.ok && plan.creates).toEqual([]);
  });

  it("an empty month after the frontier saves the other lines for that month and the gap, with the line still in the gap", () => {
    const plan = planEndLine(rows, { entityId: P, tagId: "b", period: "2027-03" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.deleteCount).toBe(0);
    expect(plan.hadOwnRowAtTarget).toBe(false);
    expect(tagsAt(plan, "2027-01")).toEqual(["a", "b"]);
    expect(tagsAt(plan, "2027-02")).toEqual(["a", "b"]);
    expect(tagsAt(plan, "2027-03")).toEqual(["a"]); // the line has ended in the target month
  });

  it("ending a line saves nothing for a month that has rows but lacks the line: such a month is authoritative", () => {
    const gap = [
      row({ entityId: P, tagId: "a", period: "2026-01" }),
      row({ entityId: P, tagId: "b", period: "2026-01" }),
      row({ entityId: P, tagId: "a", period: "2026-02" }), // b has no row in 2026-02, and that month has rows, so b is absent from it
      row({ entityId: P, tagId: "a", period: "2026-03" }),
      row({ entityId: P, tagId: "b", period: "2026-03" }),
    ];
    expect(effectiveLineAt(gap, { entityId: P, tagId: "b", period: "2026-02" })).toBeNull(); // 2026-02 has rows (a): b is absent there
    const plan = planEndLine(gap, { entityId: P, tagId: "b", period: "2026-03" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.creates).toEqual([]);
  });

  it("refuses to end a line from a month when that would leave a MIDDLE month (one that holds only this line) empty", () => {
    const rows = [
      row({ entityId: P, tagId: "a", period: "2026-01" }),
      row({ entityId: P, tagId: "b", period: "2026-01" }),
      row({ entityId: P, tagId: "b", period: "2026-02" }), // only b: ending b here would make the month empty and start showing a
      row({ entityId: P, tagId: "a", period: "2026-03" }),
      row({ entityId: P, tagId: "b", period: "2026-03" }),
    ];
    expect(planEndLine(rows, { entityId: P, tagId: "b", period: "2026-01" })).toEqual({ ok: false, reason: "only_line_left", frontier: "2026-02" });
    expect(planEndLine(rows, { entityId: P, tagId: "b", period: "2026-02" })).toEqual({ ok: false, reason: "only_line_left", frontier: "2026-02" });
    expect(planEndLine(rows, { entityId: P, tagId: "b", period: "2026-03" }).ok).toBe(true); // 2026-02 is before the chosen month
  });

  it("refuses when the line is the only one in the entity's latest month, naming that month", () => {
    const only = [
      row({ entityId: P, tagId: "a", period: "2026-11" }),
      row({ entityId: P, tagId: "b", period: "2026-11" }),
      row({ entityId: P, tagId: "b", period: "2026-12" }),
    ];
    expect(planEndLine(only, { entityId: P, tagId: "b", period: "2026-12" })).toEqual({ ok: false, reason: "only_line_left", frontier: "2026-12" });
    // from an earlier month the same line would also empty the frontier month
    expect(planEndLine(only, { entityId: P, tagId: "b", period: "2026-11" })).toEqual({ ok: false, reason: "only_line_left", frontier: "2026-12" });
    // a future month where the carried set is just that line
    expect(planEndLine(only, { entityId: P, tagId: "b", period: "2027-02" })).toEqual({ ok: false, reason: "only_line_left", frontier: "2027-02" });
  });

  it("a line that is not on the month's budget (ended, unknown, other entity) is not in view", () => {
    const withEnded = [...rows, row({ entityId: P, tagId: "old", period: "2026-09" })];
    expect(planEndLine(withEnded, { entityId: P, tagId: "old", period: "2027-01" })).toEqual({ ok: false, reason: "not_in_view" });
    expect(planEndLine(rows, { entityId: P, tagId: "zzz", period: "2027-01" })).toEqual({ ok: false, reason: "not_in_view" });
    expect(planEndLine(rows, { entityId: S, tagId: "a", period: "2027-01" })).toEqual({ ok: false, reason: "not_in_view" });
  });

  it("a second delete of the same carried month finds the line no longer in view (idempotent end state)", () => {
    const first = planEndLine(rows, { entityId: P, tagId: "b", period: "2027-01" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const after = [
      ...rows,
      ...first.creates.map((c, i) => row({ ...c, id: `n${i}`, additionalAmountCents: new Decimal(0) })),
    ];
    expect(planEndLine(after, { entityId: P, tagId: "b", period: "2027-01" })).toEqual({ ok: false, reason: "not_in_view" });
  });
});

describe("addChangesEarlierMonth (adding or re-adding a line must change nothing before its month)", () => {
  const tests = [
    row({ entityId: P, tagId: "old", period: "2026-10" }),
    row({ entityId: P, tagId: "a", period: "2026-10" }),
    row({ entityId: P, tagId: "a", period: "2026-11" }),
    row({ entityId: P, tagId: "b", period: "2026-11" }),
    row({ entityId: P, tagId: "a", period: "2026-12" }),
    row({ entityId: P, tagId: "b", period: "2026-12" }),
  ];
  it("re-adding an ended line after the latest month changes no earlier month (they have rows, so they are authoritative)", () => {
    expect(addChangesEarlierMonth(tests, { entityId: P, tagId: "old", period: "2027-01" })).toBeNull();
    expect(addChangesEarlierMonth(tests, { entityId: P, tagId: "old", period: "2027-05" })).toBeNull(); // the in-between months are saved first
    expect(addChangesEarlierMonth(tests, { entityId: P, tagId: "new", period: "2027-01" })).toBeNull();
  });
  it("the one case left: an empty month in which nothing is carried today but the re-added line would be", () => {
    const rows = [
      row({ entityId: P, tagId: "old", period: "2026-01" }),
      row({ entityId: P, tagId: "a", period: "2026-05" }),
      row({ entityId: P, tagId: "b", period: "2026-05" }),
    ];
    // 2026-02..04 have no rows and nothing carries into them (a and b start in May); old would, from January
    expect(addChangesEarlierMonth(rows, { entityId: P, tagId: "old", period: "2026-06" })).toBe("2026-02");
    // adding it to the first empty month is fine, and a brand-new line (no older rows) never reaches back
    expect(addChangesEarlierMonth(rows, { entityId: P, tagId: "new", period: "2026-06" })).toBeNull();
  });
  it("a month before the entity's first row, or an entity with no rows, has no earlier month to change", () => {
    expect(addChangesEarlierMonth(tests, { entityId: P, tagId: "x", period: "2026-01" })).toBeNull();
    expect(addChangesEarlierMonth(tests, { entityId: "ent-mezzo", tagId: "x", period: "2027-01" })).toBeNull();
  });
});

describe("carriedMonthNotice", () => {
  it("says nothing for a month of its own rows", () => {
    expect(carriedMonthNotice([{ source: "own", carriedFrom: null }])).toBeNull();
    expect(carriedMonthNotice([])).toBeNull();
  });
  it("explains the all-carried month without any button wording", () => {
    const t = carriedMonthNotice([{ source: "carried", carriedFrom: "2026-12" }, { source: "carried", carriedFrom: "2026-12" }])!;
    expect(t).toContain("This month has no saved budget of its own yet.");
    expect(t).toContain("copied from December 2026");
    expect(t).toContain("what the forecast uses");
    expect(t).toContain("the whole list is saved for this month");
    expect(t.toLowerCase()).not.toMatch(/copy last month|button|click/);
  });
  it("tells the owner how many months the first change saves, and that the in-between months stop following earlier edits", () => {
    const rows = [{ source: "carried" as const, carriedFrom: "2026-12", entityId: "e1", entityName: "Personal" }];
    const one = carriedMonthNotice(rows, { e1: ["2027-01"] })!;
    expect(one).toContain("the whole list is saved for this month.");
    const many = carriedMonthNotice(rows, { e1: ["2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06"] })!;
    expect(many).toContain("saved for 6 months (January 2027 to June 2027)");
    expect(many).toContain("this month and every empty month before it");
    expect(many).toContain("no longer follow later changes made to earlier months");
    // the count could not be read: the notice still warns that earlier empty months may be saved too
    expect(carriedMonthNotice(rows, null)).toContain("earlier months after the last saved one are also empty, they are saved too");
    // several entities in one view: one clause each
    const multi = carriedMonthNotice(
      [
        { source: "carried" as const, carriedFrom: "2026-12", entityId: "e1", entityName: "Personal" },
        { source: "carried" as const, carriedFrom: "2026-09", entityId: "e2", entityName: "EK Consulting" },
      ],
      { e1: ["2027-01"], e2: ["2026-10", "2026-11", "2026-12", "2027-01"] }
    )!;
    expect(multi).toContain("Personal: 1 month, EK Consulting: 4 months");
    expect(multi).toContain("no longer follow later changes");
  });

  it("counts the carried lines of a partly filled month and lists every source month", () => {
    const t = carriedMonthNotice([
      { source: "own", carriedFrom: null },
      { source: "carried", carriedFrom: "2026-11" },
      { source: "carried", carriedFrom: "2026-12" },
    ])!;
    expect(t).toContain("2 of the lines below have no saved row for this month yet");
    expect(t).toContain("November 2026, December 2026");
  });
});
