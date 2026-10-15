import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyFromHistory,
  parseOverrides,
  resolveKind,
  serializeOverrides,
  withOverride,
} from "@/lib/expense-kind";
import { buildOverview, elapsedFractionNY } from "@/lib/dashboard-overview";
import type { DrillData, DrillLine } from "@/lib/dashboard-drill";

const D = (dollars: number) => Math.round(dollars * 100);

describe("classifyFromHistory", () => {
  it("calls a steady monthly cost fixed", () => {
    const r = classifyFromHistory([D(4700), D(4700), D(4700), D(4700), D(4700), D(4700)]);
    expect(r.kind).toBe("fixed");
    expect(r.source).toBe("history");
    expect(r.basis).toContain("$4,700");
  });

  it("allows small drift and one empty month", () => {
    expect(classifyFromHistory([D(760), 0, D(760), D(762), D(760), D(760)]).kind).toBe("fixed");
  });

  it("calls a moving cost variable and says the range", () => {
    const r = classifyFromHistory([D(900), D(1300), D(1100), D(1500), D(1000), D(1250)]);
    expect(r.kind).toBe("variable");
    expect(r.basis).toContain("$900");
    expect(r.basis).toContain("$1,500");
  });

  it("does not guess with too little history", () => {
    const r = classifyFromHistory([0, 0, D(100), D(100), D(100), 0]);
    expect(r.kind).toBe("variable");
    expect(r.source).toBe("default");
    expect(r.basis).toContain("Not enough history");
  });

  it("handles no earlier months at all", () => {
    expect(classifyFromHistory([]).kind).toBe("variable");
  });
});

describe("overrides", () => {
  it("an override beats history, and 'auto' (null) returns to history", () => {
    const steady = [D(100), D(100), D(100), D(100), D(100), D(100)];
    expect(resolveKind("t1", steady, { t1: "variable" })).toMatchObject({ kind: "variable", source: "you" });
    expect(resolveKind("t1", steady, {})).toMatchObject({ kind: "fixed", source: "history" });
    const set = withOverride({}, "t1", "fixed")!;
    expect(withOverride(set, "t1", null)).toEqual({});
  });

  it("unreadable history counts as variable and says so", () => {
    expect(resolveKind("t1", null, {})).toMatchObject({ kind: "variable", source: "default" });
  });

  it("round-trips and ignores garbage", () => {
    expect(parseOverrides(serializeOverrides({ a: "fixed", b: "variable" }))).toEqual({ a: "fixed", b: "variable" });
    expect(parseOverrides("not json")).toEqual({});
    expect(parseOverrides(JSON.stringify({ v: 1, kinds: { a: "weird", b: "fixed" } }))).toEqual({ b: "fixed" });
    expect(parseOverrides(null)).toEqual({});
  });

  it("caps the saved choices", () => {
    let o = {};
    for (let i = 0; i < 400; i++) o = withOverride(o, `t${i}`, "fixed")!;
    expect(withOverride(o, "extra", "fixed")).toBeNull();
    expect(withOverride(o, "t0", "variable")).not.toBeNull();
  });
});

function line(over: Partial<DrillLine> & { id: string }): DrillLine {
  return {
    entityId: "e",
    carriedFrom: null,
    tagId: `tag-${over.id}`,
    label: over.id,
    shortName: over.id,
    accountId: "a",
    accountName: "Acct",
    parentId: null,
    ancestorIds: [],
    depth: 0,
    hasChildren: false,
    childIds: [],
    budgetCents: 0,
    rolloverCents: 0,
    effectiveCents: 0,
    rawCents: null,
    recurringLinked: false,
    ownCents: 0,
    rolledCents: 0,
    remainingCents: 0,
    percentUsed: 0,
    overspent: false,
    countsAsOverspent: false,
    overByCents: 0,
    txIds: [],
    ...over,
  };
}

function data(lines: DrillLine[], extra: Partial<DrillData> = {}): DrillData {
  return { lines, notInLine: [], untagged: { cents: 0, txIds: [] }, ...extra } as unknown as DrillData;
}

const STEADY = [D(1500), D(1500), D(1500), D(1500), D(1500), D(1500)];
const GROCERY_HISTORY = [D(900), D(1100), D(1000), D(1300), D(950), D(1200)];

describe("buildOverview", () => {
  const lines = [
    line({ id: "car", effectiveCents: D(1500), rolledCents: D(1500), ownCents: D(1500) }),
    line({ id: "groceries", effectiveCents: D(1200), rolledCents: D(1500), ownCents: D(1500) }),
    line({ id: "clothes", effectiveCents: D(100), rolledCents: D(20), ownCents: D(20) }),
  ];
  const history = { car: STEADY, groceries: GROCERY_HISTORY, clothes: [D(40), D(150), 0, D(80), D(30), D(60)] };

  it("splits fixed and variable and the parts add up to the month's spend", () => {
    const o = buildOverview({
      data: data(lines, { notInLine: [{ key: "tag:x", label: "Other", cents: D(30), txIds: [] }], untagged: { cents: D(10), txIds: [] } }),
      history,
      overrides: {},
      elapsed: null,
    });
    expect(o.fixed.actualCents).toBe(D(1500));
    expect(o.variable.actualCents).toBe(D(1500) + D(20) + D(30) + D(10));
    expect(o.fixed.actualCents + o.variable.actualCents).toBe(D(1500) + D(1500) + D(20) + D(30) + D(10));
    expect(o.items.find((i) => i.key === "car")?.kind).toBe("fixed");
  });

  it("honours the owner's choice", () => {
    const o = buildOverview({ data: data(lines), history, overrides: { "tag-groceries": "fixed" }, elapsed: null });
    expect(o.items.find((i) => i.key === "groceries")).toMatchObject({ kind: "fixed", source: "you" });
  });

  it("a parent's nested lines are separate items and nothing is counted twice", () => {
    const parent = line({
      id: "pet",
      hasChildren: true,
      childIds: ["food"],
      rawCents: D(500),
      effectiveCents: D(500),
      ownCents: D(15),
      rolledCents: D(215),
    });
    const food = line({ id: "food", parentId: "pet", depth: 1, effectiveCents: D(400), rolledCents: D(200), ownCents: D(200) });
    const o = buildOverview({ data: data([parent, food]), history: {}, overrides: {}, elapsed: null });
    expect(o.items.map((i) => i.key).sort()).toEqual(["food", "pet"]);
    expect(o.items.find((i) => i.key === "pet")).toMatchObject({ name: "pet (other)", budgetCents: D(100), actualCents: D(15) });
    expect(o.fixed.actualCents + o.variable.actualCents).toBe(D(215));
  });

  it("flags a variable line already over budget and one on pace to pass it, never a fixed line", () => {
    const pace = line({ id: "restaurants", effectiveCents: D(400), rolledCents: D(250), ownCents: D(250) });
    const o = buildOverview({ data: data([...lines, pace]), history: { ...history, restaurants: [] }, overrides: {}, elapsed: 0.5 });
    const names = o.watch.map((w) => w.name);
    expect(names).toContain("groceries");
    expect(names).toContain("restaurants");
    expect(names).not.toContain("car");
    expect(o.watch.find((w) => w.name === "groceries")?.text).toContain("$300 over the $1,200 budget");
    expect(o.watch.find((w) => w.name === "restaurants")?.text).toContain("On pace for $500");
  });

  it("makes no pace claim early in the month", () => {
    const pace = line({ id: "restaurants", effectiveCents: D(400), rolledCents: D(150), ownCents: D(150) });
    const o = buildOverview({ data: data([pace]), history: { restaurants: [] }, overrides: {}, elapsed: 0.1 });
    expect(o.watch).toEqual([]);
  });

  it("with unreadable history every unsorted line is variable and the overview says so", () => {
    const o = buildOverview({ data: data(lines), history: null, overrides: {}, elapsed: null });
    expect(o.historyAvailable).toBe(false);
    expect(o.fixed.count).toBe(0);
  });

  it("lists at most five lines, biggest overshoot first", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      line({ id: `l${i}`, effectiveCents: D(100), rolledCents: D(200 + i * 10), ownCents: D(200 + i * 10) })
    );
    const o = buildOverview({ data: data(many), history: {}, overrides: {}, elapsed: null });
    expect(o.watch).toHaveLength(5);
    expect(o.watch[0]!.name).toBe("l7");
  });
});

describe("elapsedFractionNY", () => {
  it("is the New York day over the days in the month", () => {
    expect(elapsedFractionNY(new Date("2026-10-15T16:00:00Z"))).toBeCloseTo(15 / 31, 5);
  });
  it("uses the New York date just after 8 PM on the last evening", () => {
    expect(elapsedFractionNY(new Date("2026-11-01T01:00:00Z"))).toBeCloseTo(31 / 31, 5);
  });
});

describe("dashboard overview wiring (source guards)", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

  it("the pure libs have no database, Prisma or Next imports", () => {
    for (const f of ["lib/expense-kind.ts", "lib/dashboard-overview.ts"]) {
      expect(read(f), f).not.toMatch(/from "@\/lib\/db"|from "@prisma|from "next\/|server-only|"use server"/);
    }
  });

  it("the action starts with requireAuth and the loader never writes", () => {
    const action = read("actions/expense-kind.ts");
    expect(action).toMatch(/export async function setExpenseKind\([\s\S]*?\): Promise<Result> \{\n  await requireAuth\(\);/);
    expect(read("lib/dashboard-overview-build.ts")).not.toMatch(/\.(create|update|upsert|delete)\w*\(|setAppSetting/);
  });

  it("the dashboard no longer mounts the full budget-lines table", () => {
    expect(read("app/page.tsx")).not.toMatch(/<BudgetLinesTable/);
  });
});
