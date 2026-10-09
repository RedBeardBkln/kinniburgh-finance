// carry-forward-seasonal-energy, step 1: the pure Budget carry-forward resolver (lib/budget-carry-forward.ts).
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  carriedNote,
  DEFAULT_SEASONAL_TAG_PATHS,
  isCarriedId,
  parseSeasonalLinesSetting,
  resolveBudgetRows,
  SEASONAL_LINES_CAP,
  variableLineKeys,
  type CarryRowBase,
} from "@/lib/budget-carry-forward";

interface Row extends CarryRowBase {
  budgeted: Decimal | null;
  payDay: number | null;
  frequency: string;
  accountId: string;
  rolloverEnabled: boolean;
  tag?: { name: string };
}

let seq = 0;
function row(entityId: string, tagId: string, period: string, over: Partial<Row> = {}): Row {
  seq += 1;
  return {
    id: `id${seq}`,
    entityId,
    tagId,
    period,
    budgeted: new Decimal("100"),
    additionalAmountCents: new Decimal("0"),
    rolloverAmount: null,
    payDay: 5,
    frequency: "monthly",
    accountId: "acct",
    rolloverEnabled: false,
    ...over,
  };
}

const P = "ent-personal";
const SV = "ent-sv";

describe("resolveBudgetRows: the rule", () => {
  it("an own row wins and is returned untouched", () => {
    const r = row(P, "toyota", "2026-12", { budgeted: new Decimal("250"), payDay: 12 });
    const out = resolveBudgetRows([row(P, "toyota", "2026-10"), r], ["2026-12"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: r.id, source: "own", carriedFrom: null, period: "2026-12", payDay: 12 });
    expect(out[0]!.budgeted!.toString()).toBe("250");
  });

  it("a month with no row carries the latest EARLIER row (amount and every schedule field)", () => {
    const old = row(P, "toyota", "2026-10", { budgeted: new Decimal("111"), payDay: 1 });
    const latest = row(P, "toyota", "2026-12", {
      budgeted: new Decimal("222"),
      payDay: 17,
      frequency: "biweekly",
      payDayOfWeek: 3,
      biweeklyAnchorDate: new Date("2026-12-02T00:00:00Z"),
      payMonth: null,
      annualAmountDue: null,
    } as Partial<Row>);
    const out = resolveBudgetRows([old, latest], ["2027-01", "2027-02"]);
    expect(out.map((r) => [r.period, r.source, r.carriedFrom])).toEqual([
      ["2027-01", "carried", "2026-12"],
      ["2027-02", "carried", "2026-12"],
    ]);
    expect(out[0]).toMatchObject({ payDay: 17, frequency: "biweekly", payDayOfWeek: 3, accountId: "acct" });
    expect(out[0]!.budgeted!.toString()).toBe("222");
    expect((out[0] as unknown as { biweeklyAnchorDate: Date }).biweeklyAnchorDate.toISOString()).toBe("2026-12-02T00:00:00.000Z");
  });

  it("carries across a year boundary (2026-12 -> 2027-01) and across many years (2026-12 -> 2028-02)", () => {
    const rows = [row(P, "mort", "2026-12")];
    const out = resolveBudgetRows(rows, ["2027-01", "2028-02", "2031-07"]);
    expect(out.map((r) => [r.period, r.carriedFrom])).toEqual([
      ["2027-01", "2026-12"],
      ["2028-02", "2026-12"],
      ["2031-07", "2026-12"],
    ]);
  });

  it("never carries from a LATER row and never backwards before the first row", () => {
    const rows = [row(P, "mort", "2026-06"), row(P, "mort", "2026-12")];
    const out = resolveBudgetRows(rows, ["2026-03", "2026-09"]);
    expect(out.map((r) => r.period)).toEqual(["2026-09"]); // 2026-03 is before the first row: nothing
    expect(out[0]).toMatchObject({ source: "carried", carriedFrom: "2026-06" }); // from the earlier row, not 2026-12
  });

  it("carries the latest earlier row, not an older one, when a line was edited mid-year", () => {
    const rows = [row(P, "x", "2026-01", { budgeted: new Decimal("10") }), row(P, "x", "2026-06", { budgeted: new Decimal("60") }), row(P, "x", "2026-12", { budgeted: new Decimal("120") })];
    const out = resolveBudgetRows(rows, ["2026-08", "2027-03"]);
    expect(out.map((r) => [r.period, r.budgeted!.toString(), r.carriedFrom])).toEqual([
      ["2026-08", "60", "2026-06"],
      ["2027-03", "120", "2026-12"],
    ]);
  });

  it("an auto-sum parent (budgeted null) stays null", () => {
    const out = resolveBudgetRows([row(P, "parent", "2026-12", { budgeted: null })], ["2027-01"]);
    expect(out[0]!.budgeted).toBeNull();
    expect(out[0]!.source).toBe("carried");
  });

  it("does not carry the rollover amount or the one-off additional amount; keeps the rollover flag", () => {
    const src = row(P, "x", "2026-12", {
      rolloverEnabled: true,
      rolloverAmount: new Decimal("37.5"),
      additionalAmountCents: new Decimal("20000"),
    });
    const [c] = resolveBudgetRows([src], ["2027-01"]);
    expect(c!.rolloverAmount).toBeNull();
    expect(c!.additionalAmountCents!.toString()).toBe("0");
    expect(c!.rolloverEnabled).toBe(true);
    // the source row is not mutated
    expect(src.rolloverAmount!.toString()).toBe("37.5");
    expect(src.additionalAmountCents!.toString()).toBe("20000");
  });

  it("a plain-number additionalAmountCents resets to the number 0", () => {
    const src = { ...row(P, "x", "2026-12"), additionalAmountCents: 500 };
    const [c] = resolveBudgetRows([src], ["2027-01"]);
    expect(c!.additionalAmountCents).toBe(0);
  });

  it("a carried row has a synthetic id that names its source and period; own rows keep their real id", () => {
    const src = row(P, "x", "2026-12");
    const [c] = resolveBudgetRows([src], ["2027-01"]);
    expect(c!.id).toBe(`carried:${src.id}:2027-01`);
    expect(isCarriedId(c!.id)).toBe(true);
    const [o] = resolveBudgetRows([src], ["2026-12"]);
    expect(o!.id).toBe(src.id);
    expect(isCarriedId(o!.id)).toBe(false);
  });

  it("output is deterministic: ordered by period, then entity, then tag", () => {
    const rows = [row(SV, "b", "2026-12"), row(P, "z", "2026-12"), row(P, "a", "2026-12")];
    const out = resolveBudgetRows(rows, ["2027-02", "2027-01"]);
    expect(out.map((r) => `${r.period} ${r.entityId} ${r.tagId}`)).toEqual([
      "2027-01 ent-personal a",
      "2027-01 ent-personal z",
      "2027-01 ent-sv b",
      "2027-02 ent-personal a",
      "2027-02 ent-personal z",
      "2027-02 ent-sv b",
    ]);
  });

  it("ignores invalid requested periods and rows with an invalid period", () => {
    const rows = [row(P, "x", "2026-12"), row(P, "x", "garbage"), row(P, "x", "2026-13")];
    expect(resolveBudgetRows(rows, ["nope", "2026-00"])).toEqual([]);
    const out = resolveBudgetRows(rows, ["2027-01"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.carriedFrom).toBe("2026-12");
  });

  it("nothing in, nothing out", () => {
    expect(resolveBudgetRows([], ["2027-01"])).toEqual([]);
    expect(resolveBudgetRows([row(P, "x", "2026-12")], [])).toEqual([]);
  });
});

describe("resolveBudgetRows: the ended-line guard (owner answer 1)", () => {
  it("a line missing from the entity's latest budgeted month has ended and does not carry", () => {
    const rows = [
      row(P, "mort", "2026-11"),
      row(P, "mort", "2026-12"),
      row(P, "oldcar", "2026-11"), // dropped from 2026-12: ended
    ];
    const out = resolveBudgetRows(rows, ["2027-01"]);
    expect(out.map((r) => r.tagId)).toEqual(["mort"]);
  });

  it("an ended line still returns its own rows for the months it has", () => {
    const rows = [row(P, "oldcar", "2026-10"), row(P, "oldcar", "2026-11"), row(P, "mort", "2026-12")];
    const out = resolveBudgetRows(rows, ["2026-10", "2026-11"]);
    expect(out.filter((r) => r.tagId === "oldcar").map((r) => [r.period, r.source])).toEqual([
      ["2026-10", "own"],
      ["2026-11", "own"],
    ]);
  });

  it("the frontier is per entity: another entity's later month does not end this entity's lines", () => {
    const rows = [row(P, "mort", "2026-12"), row(SV, "ins", "2026-09"), row(SV, "ins", "2027-03")];
    const out = resolveBudgetRows(rows, ["2027-06"]);
    expect(out.map((r) => [r.entityId, r.tagId, r.carriedFrom])).toEqual([
      [P, "mort", "2026-12"],
      [SV, "ins", "2027-03"],
    ]);
  });

  it("an entity with a single curated month (EK Consulting) carries every line of it", () => {
    const rows = [row("ent-ekc", "a", "2026-09"), row("ent-ekc", "b", "2026-09")];
    const out = resolveBudgetRows(rows, ["2026-12", "2027-02"]);
    expect(out).toHaveLength(4);
    expect(out.every((r) => r.carriedFrom === "2026-09")).toBe(true);
  });

  it("the frontier is the entity's LATEST period even when it is later than the requested one (gap months)", () => {
    // line present 2026-09 and 2026-12, absent 10 and 11: the month between is filled from 09 because the line is in the frontier
    const rows = [row(P, "x", "2026-09"), row(P, "x", "2026-12"), row(P, "y", "2026-09")];
    const out = resolveBudgetRows(rows, ["2026-11"]);
    expect(out.map((r) => [r.tagId, r.carriedFrom])).toEqual([["x", "2026-09"]]); // y ended (not in 2026-12)
  });

  it("per-entity separation: the same tag in two entities is two lines", () => {
    const rows = [row(P, "elec", "2026-12", { budgeted: new Decimal("172") }), row(SV, "elec", "2026-12", { budgeted: new Decimal("83") })];
    const out = resolveBudgetRows(rows, ["2027-01"]);
    expect(out.map((r) => [r.entityId, r.budgeted!.toString()])).toEqual([
      [P, "172"],
      [SV, "83"],
    ]);
    // a line that exists only in SV is never produced for Personal
    const only = resolveBudgetRows([row(SV, "ins", "2026-12"), row(P, "mort", "2026-12")], ["2027-01"]);
    expect(only.filter((r) => r.entityId === P).map((r) => r.tagId)).toEqual(["mort"]);
  });
});

describe("resolveBudgetRows: variable (seasonal) lines are excluded from flat carry-forward", () => {
  it("a variable line returns its own rows but never carries", () => {
    const rows = [row(P, "elec", "2026-12"), row(P, "mort", "2026-12")];
    const variableKeys = new Set([`${P}|elec`]);
    const own = resolveBudgetRows(rows, ["2026-12"], { variableKeys });
    expect(own.find((r) => r.tagId === "elec")).toMatchObject({ source: "own", variable: true });
    expect(own.find((r) => r.tagId === "mort")).toMatchObject({ source: "own", variable: false });
    const later = resolveBudgetRows(rows, ["2027-01"], { variableKeys });
    expect(later.map((r) => r.tagId)).toEqual(["mort"]);
  });

  it("variable keys are per entity", () => {
    const rows = [row(P, "elec", "2026-12"), row(SV, "elec", "2026-12")];
    const out = resolveBudgetRows(rows, ["2027-01"], { variableKeys: new Set([`${P}|elec`]) });
    expect(out.map((r) => r.entityId)).toEqual([SV]);
  });
});

describe("variable line setting", () => {
  it("default: rows whose tag path is Electric (Eversource), Oil, Firewood (Personal) or SV's Electricity / Oil", () => {
    const rows = [
      row(P, "t1", "2026-12", { tag: { name: "Utilities / Electric (Eversource)" } }),
      row(P, "t2", "2026-12", { tag: { name: "Utilities / Oil" } }),
      row(P, "t3", "2026-12", { tag: { name: "Utilities / Firewood" } }),
      row(SV, "t4", "2026-12", { tag: { name: "Arbor Retreat / Electricity" } }),
      row(SV, "t5", "2026-12", { tag: { name: "Arbor Retreat / Oil" } }),
      row(P, "t6", "2026-12", { tag: { name: "Utilities / Water" } }),
      row(P, "t7", "2026-12", { tag: { name: "Auto / Oil Change" } }),
      row(P, "t8", "2026-12"), // no tag info at all
    ];
    const keys = variableLineKeys(rows, null);
    expect([...keys].sort()).toEqual([`${P}|t1`, `${P}|t2`, `${P}|t3`, `${SV}|t4`, `${SV}|t5`]);
    expect(DEFAULT_SEASONAL_TAG_PATHS).toHaveLength(5);
  });

  it("an owner setting replaces the default entirely (including an empty list)", () => {
    const rows = [row(P, "t1", "2026-12", { tag: { name: "Utilities / Oil" } })];
    expect([...variableLineKeys(rows, [{ entityId: P, tagId: "other" }])]).toEqual([`${P}|other`]);
    expect([...variableLineKeys(rows, [])]).toEqual([]);
  });

  it("parse: valid JSON, junk entries dropped, duplicates collapsed, capped", () => {
    expect(parseSeasonalLinesSetting(JSON.stringify([{ entityId: "e", tagId: "t" }, { entityId: "e", tagId: "t" }, { entityId: "", tagId: "t" }, { entityId: 1, tagId: "t" }, null, "x"]))).toEqual([
      { entityId: "e", tagId: "t" },
    ]);
    const many = Array.from({ length: 50 }, (_, i) => ({ entityId: "e", tagId: `t${i}` }));
    expect(parseSeasonalLinesSetting(JSON.stringify(many))).toHaveLength(SEASONAL_LINES_CAP);
    expect(parseSeasonalLinesSetting("[]")).toEqual([]);
  });

  it("parse: absent, garbage JSON and non-arrays are null (default applies), never a throw", () => {
    expect(parseSeasonalLinesSetting(null)).toBeNull();
    expect(parseSeasonalLinesSetting(undefined)).toBeNull();
    expect(parseSeasonalLinesSetting("{not json")).toBeNull();
    expect(parseSeasonalLinesSetting('{"entityId":"e"}')).toBeNull();
    expect(parseSeasonalLinesSetting("42")).toBeNull();
  });
});

describe("carriedNote", () => {
  it("is a quiet observational note naming the source period", () => {
    expect(carriedNote("2026-12")).toBe("Budget figure carried forward from 2026-12");
  });
});

// ── Fuzz against an independent oracle ──────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function monthsFrom(start: string, n: number): string[] {
  let [y, m] = start.split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Naive oracle: scans the full row list for every question, no grouping or sorting shared with the implementation. */
function oracle(rows: Row[], period: string, entityId: string, tagId: string, variable: boolean): { source: "own" | "carried"; from: string } | null {
  const same = rows.filter((r) => r.entityId === entityId && r.tagId === tagId);
  const own = same.find((r) => r.period === period);
  if (own) return { source: "own", from: own.period };
  if (variable) return null;
  const earlier = same.filter((r) => r.period < period);
  if (earlier.length === 0) return null;
  let src = earlier[0]!;
  for (const r of earlier) if (r.period > src.period) src = r;
  let frontier = "";
  for (const r of rows) if (r.entityId === entityId && r.period > frontier) frontier = r.period;
  if (!same.some((r) => r.period === frontier)) return null;
  return { source: "carried", from: src.period };
}

describe("resolveBudgetRows: fuzz against an independent oracle", () => {
  it("agrees on 300 random worlds (multiple entities, tags, gaps, ended lines, variable lines, year boundaries)", () => {
    const rnd = mulberry32(20261009);
    const months = monthsFrom("2025-10", 40); // 2025-10 .. 2029-01
    for (let world = 0; world < 300; world++) {
      const entities = ["e1", "e2", "e3"].slice(0, 1 + Math.floor(rnd() * 3));
      const tags = ["t1", "t2", "t3", "t4", "t5"].slice(0, 1 + Math.floor(rnd() * 5));
      const rows: Row[] = [];
      for (const e of entities) {
        const spanStart = Math.floor(rnd() * 12);
        const spanLen = 1 + Math.floor(rnd() * 16);
        for (const t of tags) {
          if (rnd() < 0.2) continue;
          for (let i = spanStart; i < Math.min(months.length, spanStart + spanLen); i++) {
            if (rnd() < 0.8) rows.push(row(e, t, months[i]!, { budgeted: new Decimal(String(Math.floor(rnd() * 1000))) }));
          }
        }
      }
      const variableKeys = new Set<string>();
      for (const e of entities) for (const t of tags) if (rnd() < 0.2) variableKeys.add(`${e}|${t}`);
      const requested = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 8), }, () => months[Math.floor(rnd() * months.length)]!))];

      const out = resolveBudgetRows(rows, requested, { variableKeys });
      const got = new Map(out.map((r) => [`${r.period}|${r.entityId}|${r.tagId}`, r]));
      expect(got.size).toBe(out.length); // no duplicates

      const lines = new Set(rows.map((r) => `${r.entityId}|${r.tagId}`));
      for (const p of requested) {
        for (const line of lines) {
          const [e, t] = line.split("|") as [string, string];
          const want = oracle(rows, p, e, t, variableKeys.has(line));
          const have = got.get(`${p}|${e}|${t}`);
          if (want === null) {
            expect(have, `${p} ${line} should be absent`).toBeUndefined();
          } else {
            expect(have, `${p} ${line} should exist`).toBeDefined();
            expect(have!.source).toBe(want.source);
            expect(have!.carriedFrom ?? have!.period).toBe(want.from);
            if (want.source === "carried") {
              const src = rows.find((r) => r.entityId === e && r.tagId === t && r.period === want.from)!;
              expect(have!.budgeted === null ? null : have!.budgeted.toString()).toBe(src.budgeted === null ? null : src.budgeted.toString());
              expect(have!.id).toBe(`carried:${src.id}:${p}`);
            }
          }
        }
      }
      // and nothing is produced for a line the world does not have
      for (const r of out) expect(lines.has(`${r.entityId}|${r.tagId}`)).toBe(true);
    }
  });
});
