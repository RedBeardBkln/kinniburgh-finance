// TESTER (carry-forward-seasonal-energy, step 1): an independent oracle for the budget carry-forward resolver.
// The oracle shares no code with lib/budget-carry-forward.ts: it indexes rows by "entity|tag|ordinal-month", steps
// BACKWARDS one month at a time to find the latest earlier row, and decides "ended" by looking the line up at the
// entity's maximum ordinal. Nothing here touches a database.
import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import {
  DEFAULT_SEASONAL_TAG_PATHS,
  SEASONAL_LINES_CAP,
  isCarriedId,
  parseSeasonalLinesSetting,
  resolveBudgetRows,
  variableLineKeys,
  type CarryRowBase,
} from "@/lib/budget-carry-forward";

interface Row extends CarryRowBase {
  accountId: string;
  budgeted: Decimal | null;
  payDay: number | null;
  frequency: string;
  payDayOfWeek: number | null;
  biweeklyAnchorDate: Date | null;
  payMonth: number | null;
  annualAmountDue: Decimal | null;
  rolloverEnabled: boolean;
  rolloverAmount: Decimal | null;
  additionalAmountCents: Decimal;
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ord = (p: string) => Number(p.slice(0, 4)) * 12 + (Number(p.slice(5, 7)) - 1);
const per = (o: number) => `${Math.floor(o / 12)}-${String((o % 12) + 1).padStart(2, "0")}`;
const BASE = ord("2025-10");
const SPAN = 30; // 2025-10 .. 2028-03

function mkRow(id: string, entityId: string, tagId: string, period: string, rnd: () => number): Row {
  return {
    id,
    entityId,
    tagId,
    period,
    accountId: `acct-${Math.floor(rnd() * 3)}`,
    budgeted: rnd() < 0.15 ? null : new Decimal((Math.floor(rnd() * 100000) / 100).toFixed(2)),
    payDay: rnd() < 0.3 ? null : 1 + Math.floor(rnd() * 28),
    frequency: ["monthly", "weekly", "biweekly", "annual"][Math.floor(rnd() * 4)]!,
    payDayOfWeek: rnd() < 0.5 ? null : Math.floor(rnd() * 7),
    biweeklyAnchorDate: rnd() < 0.7 ? null : new Date(Date.UTC(2026, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28))),
    payMonth: rnd() < 0.7 ? null : 1 + Math.floor(rnd() * 12),
    annualAmountDue: rnd() < 0.7 ? null : new Decimal((Math.floor(rnd() * 500000) / 100).toFixed(2)),
    rolloverEnabled: rnd() < 0.3,
    rolloverAmount: rnd() < 0.5 ? null : new Decimal((Math.floor(rnd() * 20000) / 100).toFixed(2)),
    additionalAmountCents: new Decimal(rnd() < 0.8 ? "0" : String(Math.floor(rnd() * 90000) / 100)),
  };
}

interface Expected {
  period: string;
  entityId: string;
  tagId: string;
  source: "own" | "carried";
  carriedFrom: string | null;
  from: Row;
  variable: boolean;
}

/** The naive oracle. */
function oracle(rows: Row[], wanted: string[], variable: Set<string>): Expected[] {
  const valid = rows.filter((r) => /^\d{4}-(0[1-9]|1[0-2])$/.test(r.period));
  const table = new Map<string, Row>();
  for (const r of valid) table.set(`${r.entityId}|${r.tagId}|${ord(r.period)}`, r);
  const maxOrd = new Map<string, number>();
  const minOrd = new Map<string, number>();
  for (const r of valid) {
    maxOrd.set(r.entityId, Math.max(maxOrd.get(r.entityId) ?? -Infinity, ord(r.period)));
    const k = `${r.entityId}|${r.tagId}`;
    minOrd.set(k, Math.min(minOrd.get(k) ?? Infinity, ord(r.period)));
  }
  const lines = [...new Set(valid.map((r) => `${r.entityId}|${r.tagId}`))];
  const periods = [...new Set(wanted.filter((p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p)))];
  const out: Expected[] = [];
  for (const p of periods) {
    for (const line of lines) {
      const [e, t] = line.split("|") as [string, string];
      const own = table.get(`${e}|${t}|${ord(p)}`);
      const isVar = variable.has(line);
      if (own) {
        out.push({ period: p, entityId: e, tagId: t, source: "own", carriedFrom: null, from: own, variable: isVar });
        continue;
      }
      let found: Row | undefined;
      for (let o = ord(p) - 1; o >= minOrd.get(line)!; o--) {
        const hit = table.get(`${e}|${t}|${o}`);
        if (hit) {
          found = hit;
          break;
        }
      }
      if (!found) continue;
      if (isVar) continue;
      if (!table.has(`${e}|${t}|${maxOrd.get(e)}`)) continue; // not in the entity's latest month: ended
      out.push({ period: p, entityId: e, tagId: t, source: "carried", carriedFrom: found.period, from: found, variable: false });
    }
  }
  return out;
}

const keyOf = (x: { period: string; entityId: string; tagId: string }) => `${x.period}|${x.entityId}|${x.tagId}`;

describe("TESTER: resolver vs independent month-stepping oracle", () => {
  it("agrees with the oracle on 4000 random worlds, shuffled input, with every branch exercised", () => {
    const counts = { own: 0, carried: 0, endedSkipped: 0, variableSkipped: 0, gapCarried: 0, backwardSkipped: 0, yearBoundary: 0, outlier: 0 };
    for (let seed = 1; seed <= 4000; seed++) {
      const rnd = mulberry32(seed);
      const nEnt = 1 + Math.floor(rnd() * 3);
      const nTag = 1 + Math.floor(rnd() * 6);
      const rows: Row[] = [];
      let n = 0;
      for (let e = 0; e < nEnt; e++) {
        const entityId = `e${e}`;
        const entityStart = Math.floor(rnd() * 14);
        const entityEnd = entityStart + Math.floor(rnd() * 14);
        for (let t = 0; t < nTag; t++) {
          if (rnd() < 0.2) continue;
          const start = entityStart + Math.floor(rnd() * 4);
          const end = rnd() < 0.5 ? entityEnd : start + Math.floor(rnd() * 8);
          for (let o = start; o <= end; o++) {
            if (rnd() < 0.15) continue; // gap month
            rows.push(mkRow(`r${n++}`, entityId, `t${t}`, per(BASE + Math.min(o, SPAN - 1)), rnd));
          }
        }
        if (rnd() < 0.1) {
          // a single far-future outlier row for one line moves the entity frontier
          rows.push(mkRow(`r${n++}`, entityId, `t${Math.floor(rnd() * nTag)}`, per(BASE + SPAN - 1 - Math.floor(rnd() * 2)), rnd));
          counts.outlier++;
        }
      }
      // noise: invalid periods must be ignored everywhere (including for the frontier)
      if (rnd() < 0.2) rows.push(mkRow(`bad${n++}`, "e0", "t0", rnd() < 0.5 ? "2026-13" : "bogus", rnd));
      // de-duplicate (entity, tag, period): the DB has a unique index on it
      const seen = new Set<string>();
      const uniq = rows.filter((r) => {
        const k = `${r.entityId}|${r.tagId}|${r.period}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      // shuffle
      for (let i = uniq.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [uniq[i], uniq[j]] = [uniq[j]!, uniq[i]!];
      }
      const variable = new Set<string>();
      for (let e = 0; e < nEnt; e++) for (let t = 0; t < nTag; t++) if (rnd() < 0.15) variable.add(`e${e}|t${t}`);
      const wanted: string[] = [];
      const nW = 1 + Math.floor(rnd() * 6);
      for (let i = 0; i < nW; i++) wanted.push(per(BASE - 3 + Math.floor(rnd() * (SPAN + 8))));
      if (rnd() < 0.1) wanted.push("2026-00", "x");

      const got = resolveBudgetRows(uniq, wanted, { variableKeys: variable });
      const exp = oracle(uniq, wanted, variable);
      const gotMap = new Map(got.map((g) => [keyOf(g), g]));
      expect(got.length, `seed ${seed}`).toBe(exp.length);
      expect(gotMap.size, `seed ${seed} duplicates`).toBe(got.length);
      for (const x of exp) {
        const g = gotMap.get(keyOf(x));
        expect(g, `seed ${seed} missing ${keyOf(x)}`).toBeDefined();
        if (!g) continue;
        expect(g.source).toBe(x.source);
        expect(g.carriedFrom).toBe(x.carriedFrom);
        expect(g.variable).toBe(x.variable);
        expect(g.period).toBe(x.period);
        // every carried field is the SOURCE row's
        for (const f of ["accountId", "budgeted", "payDay", "frequency", "payDayOfWeek", "biweeklyAnchorDate", "payMonth", "annualAmountDue", "rolloverEnabled", "entityId", "tagId"] as const) {
          expect(g[f], `seed ${seed} ${keyOf(x)} ${f}`).toEqual(x.from[f]);
        }
        if (x.source === "own") {
          expect(g.id).toBe(x.from.id);
          expect(g.rolloverAmount).toEqual(x.from.rolloverAmount);
          expect(g.additionalAmountCents).toEqual(x.from.additionalAmountCents);
          counts.own++;
        } else {
          expect(g.id).toBe(`carried:${x.from.id}:${x.period}`);
          expect(isCarriedId(g.id)).toBe(true);
          expect(g.rolloverAmount).toBeNull();
          expect(g.additionalAmountCents.toString()).toBe("0");
          expect(ord(x.carriedFrom!)).toBeLessThan(ord(x.period));
          counts.carried++;
          if (x.carriedFrom!.slice(0, 4) !== x.period.slice(0, 4)) counts.yearBoundary++;
          // a gap month: the entity has later rows than the requested period yet the line carried
          const ent = x.entityId;
          const maxEnt = Math.max(...uniq.filter((r) => r.entityId === ent && /^\d{4}-(0[1-9]|1[0-2])$/.test(r.period)).map((r) => ord(r.period)));
          if (maxEnt > ord(x.period)) counts.gapCarried++;
        }
      }
      // ordering: period, then `entity|tag`
      const orderKeys = got.map((g) => `${g.period}\u0000${g.entityId}|${g.tagId}`);
      expect([...orderKeys].sort(), `seed ${seed} order`).toEqual(orderKeys);
      // branch counters for things that must be ABSENT
      const present = new Set(got.map((g) => `${g.period}|${g.entityId}|${g.tagId}`));
      for (const p of new Set(wanted.filter((w) => /^\d{4}-(0[1-9]|1[0-2])$/.test(w)))) {
        for (const line of new Set(uniq.map((r) => `${r.entityId}|${r.tagId}`))) {
          if (present.has(`${p}|${line.split("|")[0]}|${line.split("|")[1]}`)) continue;
          const lineRows = uniq.filter((r) => `${r.entityId}|${r.tagId}` === line && /^\d{4}-(0[1-9]|1[0-2])$/.test(r.period));
          const earlier = lineRows.some((r) => ord(r.period) < ord(p));
          if (!earlier) counts.backwardSkipped++;
          else if (variable.has(line)) counts.variableSkipped++;
          else counts.endedSkipped++;
        }
      }
    }
    // the fuzz is only meaningful if every branch was exercised many times
    for (const [k, v] of Object.entries(counts)) expect(v, `branch ${k} never exercised`).toBeGreaterThan(50);
  }, 120000);

  it("the answer for a period does not depend on which other periods are requested (the frontier is the entity's, not the window's)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = mulberry32(seed * 7919);
      const rows: Row[] = [];
      for (let t = 0; t < 5; t++) {
        const start = Math.floor(rnd() * 8);
        const end = start + Math.floor(rnd() * 12);
        for (let o = start; o <= end; o++) if (rnd() > 0.15) rows.push(mkRow(`r${t}-${o}`, "e0", `t${t}`, per(BASE + o), rnd));
      }
      const all = Array.from({ length: 24 }, (_, i) => per(BASE + i));
      const whole = resolveBudgetRows(rows, all);
      const pieces = all.flatMap((p) => resolveBudgetRows(rows, [p]));
      expect(pieces.map(keyOf).sort()).toEqual(whole.map(keyOf).sort());
      const byKey = new Map(whole.map((w) => [keyOf(w), w]));
      for (const p of pieces) expect(p).toEqual(byKey.get(keyOf(p)));
    }
  });

  it("does not mutate its input rows", () => {
    const rnd = mulberry32(42);
    const rows = [mkRow("a", "e", "t", "2026-01", rnd), mkRow("b", "e", "t", "2026-02", rnd)];
    const snap = JSON.stringify(rows);
    resolveBudgetRows(rows, ["2026-03", "2026-02", "2027-01"]);
    expect(JSON.stringify(rows)).toBe(snap);
  });
});

describe("TESTER: the frontier hazard is real and documented", () => {
  const rnd = mulberry32(5);
  const mk = (id: string, tag: string, period: string) => mkRow(id, "P", tag, period, rnd);
  const base = [mk("a12", "A", "2026-12"), mk("b12", "B", "2026-12"), mk("a11", "A", "2026-11")];

  it("before the outlier: A and B carry into 2027-01..2027-06", () => {
    const got = resolveBudgetRows(base, ["2027-01", "2027-06"]);
    expect(got.map(keyOf).sort()).toEqual(["2027-01|P|A", "2027-01|P|B", "2027-06|P|A", "2027-06|P|B"]);
  });

  it("ONE row for a far-future month stops EVERY other line carrying into any month after its own last row (even 2027-01)", () => {
    const withOutlier = [...base, mk("c", "C", "2027-06")];
    const got = resolveBudgetRows(withOutlier, ["2027-01", "2027-03", "2027-06", "2027-09"]);
    // A and B vanish from 2027-01 onward: the frontier moved to 2027-06 and they are not in it. Only C remains.
    expect(got.map(keyOf).sort()).toEqual(["2027-06|P|C", "2027-09|P|C"].sort());
  });

  it("the first real row of a new year (2027-01 for one line) ends all other lines from 2027-01 on", () => {
    const got = resolveBudgetRows([...base, mk("c1", "C", "2027-01")], ["2027-01", "2027-02"]);
    expect(got.map(keyOf).sort()).toEqual(["2027-01|P|C", "2027-02|P|C"]);
  });

  it("the hazard is per entity: another entity's outlier changes nothing", () => {
    const other = mkRow("z", "Q", "Z", "2028-01", rnd);
    const got = resolveBudgetRows([...base, other], ["2027-02"]);
    expect(got.filter((g) => g.entityId === "P").map(keyOf).sort()).toEqual(["2027-02|P|A", "2027-02|P|B"]);
  });
});

describe("TESTER: gap months and year boundaries", () => {
  const rnd = mulberry32(9);
  const mk = (id: string, tag: string, period: string) => mkRow(id, "P", tag, period, rnd);
  it("a line present in the latest month but missing in a gap month carries into the gap, from the row before the gap", () => {
    const rows = [mk("x1", "X", "2026-03"), mk("x5", "X", "2026-05"), mk("y5", "Y", "2026-05")];
    const got = resolveBudgetRows(rows, ["2026-04"]);
    // frontier is 2026-05; X is in it, Y started later and is never carried backwards
    expect(got.map((g) => `${g.tagId}:${g.carriedFrom}`)).toEqual(["X:2026-03"]);
  });
  it("a line absent from the latest month is NOT carried even into a gap month before its last row", () => {
    const rows = [mk("x1", "X", "2026-03"), mk("x5", "X", "2026-05"), mk("y1", "Y", "2026-03"), mk("y7", "Y", "2026-07"), mk("w7", "W", "2026-07")];
    // frontier 2026-07; X's last row is 2026-05 -> ended, so 2026-04 and 2026-06 get nothing for X
    const got = resolveBudgetRows(rows, ["2026-04", "2026-06"]);
    expect(got.map((g) => `${g.period}:${g.tagId}`).sort()).toEqual(["2026-04:Y", "2026-06:Y"]);
  });
  it("2026-12 -> 2027-01 and 2026-12 -> 2028-02 carry; February of a leap year is just a period", () => {
    const rows = [mk("a", "A", "2026-12")];
    expect(resolveBudgetRows(rows, ["2027-01", "2028-02", "2028-12", "2030-01"]).map((g) => `${g.period}<-${g.carriedFrom}`)).toEqual([
      "2027-01<-2026-12",
      "2028-02<-2026-12",
      "2028-12<-2026-12",
      "2030-01<-2026-12",
    ]);
  });
  it("a requested period before every row of the entity yields nothing (never backwards)", () => {
    expect(resolveBudgetRows([mk("a", "A", "2026-06")], ["2026-05", "2025-12"])).toEqual([]);
  });
});

describe("TESTER: variable-line setting edge cases", () => {
  it("default set is by full tag path and applies per row's own entity", () => {
    const rows = [
      { entityId: "P", tagId: "t1", tag: { name: "Utilities / Electric (Eversource)" } },
      { entityId: "SV", tagId: "t1", tag: { name: "Utilities / Electric (Eversource)" } },
      { entityId: "SV", tagId: "t2", tag: { name: "Arbor Retreat / Oil" } },
      { entityId: "P", tagId: "t3", tag: { name: "Utilities / Oil / Extra" } }, // not an exact path
      { entityId: "P", tagId: "t4", tag: { name: "utilities / oil" } }, // case differs: not matched (exact path)
      { entityId: "P", tagId: "t5", tag: null },
      { entityId: "P", tagId: "t6" },
    ];
    expect([...variableLineKeys(rows, null)].sort()).toEqual(["P|t1", "SV|t1", "SV|t2"]);
    expect(DEFAULT_SEASONAL_TAG_PATHS).toHaveLength(5);
  });

  it("garbage / absent / odd JSON parse to null (default), [] is a valid 'no variable lines'", () => {
    for (const raw of [undefined, null, "", "{", "null", "5", '"x"', "{}", '{"entityId":"a","tagId":"b"}', "true", "[1,2", "undefined"]) {
      expect(parseSeasonalLinesSetting(raw as string | null | undefined), String(raw)).toBeNull();
    }
    expect(parseSeasonalLinesSetting("[]")).toEqual([]);
  });

  it("entries: non-objects, null, arrays, numbers, empty strings and non-string ids are dropped; duplicates collapse; cap 20", () => {
    const raw = JSON.stringify([
      null,
      5,
      "x",
      [],
      { entityId: "a" },
      { tagId: "b" },
      { entityId: "", tagId: "b" },
      { entityId: 1, tagId: "b" },
      { entityId: "a", tagId: "b" },
      { entityId: "a", tagId: "b", extra: "ignored" },
    ]);
    expect(parseSeasonalLinesSetting(raw)).toEqual([{ entityId: "a", tagId: "b" }]);
    const many = JSON.stringify(Array.from({ length: 45 }, (_, i) => ({ entityId: "e", tagId: `t${i}` })));
    const parsed = parseSeasonalLinesSetting(many)!;
    expect(parsed).toHaveLength(SEASONAL_LINES_CAP);
    expect(parsed[0]).toEqual({ entityId: "e", tagId: "t0" });
    expect(parsed[19]).toEqual({ entityId: "e", tagId: "t19" });
    // the cap counts VALID entries, not raw ones: 30 junk entries first do not eat the budget
    const junkFirst = JSON.stringify([...Array.from({ length: 30 }, () => null), ...Array.from({ length: 25 }, (_, i) => ({ entityId: "e", tagId: `t${i}` }))]);
    expect(parseSeasonalLinesSetting(junkFirst)).toHaveLength(20);
  });

  it("a setting naming a tag in the WRONG entity does not make the right entity's line variable", () => {
    const rnd = mulberry32(3);
    const rows = [mkRow("p", "P", "T", "2026-12", rnd), mkRow("s", "SV", "T", "2026-12", rnd)];
    const variable = variableLineKeys([], [{ entityId: "SV", tagId: "T" }]);
    const got = resolveBudgetRows(rows, ["2027-01"], { variableKeys: variable });
    expect(got.map((g) => `${g.entityId}:${g.source}`)).toEqual(["P:carried"]);
  });

  it("an own row of a variable line is returned flagged, never replaced", () => {
    const rnd = mulberry32(4);
    const rows = [mkRow("o", "P", "Oil", "2027-01", rnd), mkRow("o0", "P", "Oil", "2026-12", rnd), mkRow("x", "P", "X", "2026-12", rnd), mkRow("x1", "P", "X", "2027-01", rnd)];
    const got = resolveBudgetRows(rows, ["2027-01", "2027-02"], { variableKeys: new Set(["P|Oil"]) });
    expect(got.map((g) => `${g.period}:${g.tagId}:${g.source}:${g.variable}`)).toEqual(["2027-01:Oil:own:true", "2027-01:X:own:false", "2027-02:X:carried:false"].sort());
  });
});
