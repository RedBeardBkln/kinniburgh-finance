// The business-use percentage decision (X6) in the review layers: L2 applies the decision independently of the engine.
// (L1 and L3 / AI-payload coverage of the same decision is in the sections below.)

import { vi } from "vitest";
vi.setConfig({ testTimeout: 240000 });
import { describe, expect, it } from "vitest";
import { applyOverrides } from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { LineKey, Ty2025Return } from "@/lib/tax2025/types";
import { oracleLedger, runL2, type L2Input } from "@/lib/tax-review/l2";
import { decisionsOf } from "@/lib/tax-review/l2/engine-view";
import { tenthsOfPercent } from "@/lib/tax-review/l2/money";
import { fullFacts1b, gl } from "./tax2025-fixtures";

const WHO = { by: "Eric", at: "2026-10-06T12:00:00.000Z" };

function facts(cents = 261_017, extra: ReturnType<typeof gl>[] = [], revenue = 6_000_000): Ty2025Facts {
  const f = fullFacts1b();
  const sc = f.income.scheduleC;
  sc.glLines = [gl("4000", "Services", "revenue", revenue), ...sc.glLines.filter((g) => g.code !== "4000"), gl("6100", "Utilities:Internet & Phone", "expense", cents), ...extra];
  return f;
}

function inputOf(f: Ty2025Facts, tenths: number | null): L2Input {
  const ret = computeTy2025Return(f, tenths === null ? {} : { businessUse: { internet_phone: { percentTenths: tenths, ...WHO } } });
  return { ret, effective: applyOverrides(ret, []), facts: f };
}

describe("L2 reads the percentage text itself", () => {
  it("tenthsOfPercent: '70%' / '70.5%' / '100%' / '0%'; anything else is null (never a guess)", () => {
    expect(tenthsOfPercent("70%")).toBe(700);
    expect(tenthsOfPercent("70.5%")).toBe(705);
    expect(tenthsOfPercent("100%")).toBe(1000);
    expect(tenthsOfPercent("0%")).toBe(0);
    for (const bad of ["70", "101%", "70.55%", "-1%", "%", "abc", "", "simplified", "70 %%"]) expect(tenthsOfPercent(bad), bad).toBeNull();
  });
  it("decisionsOf collects only percent-valued decisions (registry decisions have word choices)", () => {
    const ret = computeTy2025Return(facts(), { businessUse: { internet_phone: { percentTenths: 705, ...WHO } } });
    expect(decisionsOf(ret, null).businessUse).toEqual({ X6: 705 });
    expect(decisionsOf(computeTy2025Return(facts(), {}), null).businessUse).toEqual({ X6: 1000 });
    expect(decisionsOf(computeTy2025Return(facts(0), {}), null).businessUse).toEqual({});
  });
});

describe("L2 matches the engine with the decision (zero mismatches)", () => {
  const cases: [string, number | null][] = [
    ["undecided", null],
    ["100%", 1000],
    ["70%", 700],
    ["70.5%", 705],
    ["33.3%", 333],
    ["0%", 0],
  ];
  for (const [name, tenths] of cases) {
    it(`${name}: the oracle's line 25 equals the engine's and runL2 finds nothing`, () => {
      const input = inputOf(facts(), tenths);
      const r = runL2(input);
      expect(r.status, r.reason ?? "").toBe("ran");
      expect(r.summary.mismatchCount).toBe(0);
      expect(r.findings.filter((f) => f.check !== "L2.coverage")).toEqual([]);
      const ledger = oracleLedger(input);
      expect(ledger.get("schc.25")).toBe(input.ret.lines["schc.25"]?.amount);
      expect(ledger.lines.get("schc.25")?.source).toBe("oracle");
      expect(ledger.get("schc.31")).toBe(input.ret.lines["schc.31"]?.amount);
    });
  }
  it("a sweep of booked amounts and percentages (cent edges, other accounts on the line) agrees with the engine", () => {
    const amounts = [100_100, 100_030, 261_017, 99, 1, 123_456, 7_000_000];
    const tenthsList = [0, 1, 5, 333, 500, 705, 999, 1000];
    for (const cents of amounts) {
      for (const tenths of tenthsList) {
        const f = facts(cents, [gl("6200", "Utilities:Phone service", "expense", 10_040)]);
        const input = inputOf(f, tenths);
        const r = runL2(input);
        const where = `${cents} cents at ${tenths} tenths`;
        expect(r.status, where).toBe("ran");
        expect(r.summary.mismatchCount, where).toBe(0);
        expect(oracleLedger(input).get("schc.25"), where).toBe(input.ret.lines["schc.25"]?.amount);
      }
    }
  });
  it("rounds ONCE: 1,000.30 at 50% + 100.40 at 100% = 600.55 -> 601 in the oracle too", () => {
    const input = inputOf(facts(100_030, [gl("6200", "Utilities:Electricity", "expense", 10_040)]), 500);
    expect(oracleLedger(input).get("schc.25")).toBe(601);
    expect(input.ret.lines["schc.25"]?.amount).toBe(601);
  });
});

describe("L2 catches an engine that ignores the decision", () => {
  /** The engine printed line 25 (and its dependents) at 100% while its own decision says 70%: the oracle must disagree. */
  function ignoringEngine(): L2Input {
    const f = facts();
    const at70 = computeTy2025Return(f, { businessUse: { internet_phone: { percentTenths: 700, ...WHO } } });
    const at100 = computeTy2025Return(f, {});
    // the decision (and the detail) claim 70%, every printed line is the 100% engine's
    const ret: Ty2025Return = { ...at100, decisions: at70.decisions };
    return { ret, effective: applyOverrides(ret, []), facts: f };
  }
  it("a mismatch on schc.25 and on its dependents (28, 29, 31 ...)", () => {
    const r = runL2(ignoringEngine());
    expect(r.status).toBe("ran");
    expect(r.summary.mismatchCount).toBeGreaterThan(3);
    const text = JSON.stringify(r.findings);
    for (const key of ["schc.25", "schc.28", "schc.29", "schc.31"] as LineKey[]) expect(text, key).toContain(key);
    expect(oracleLedger(ignoringEngine()).get("schc.25")).toBe(1827);
  });
  it("an engine that applied the percentage while the decision says 100% is caught the same way", () => {
    const f = facts();
    const at70 = computeTy2025Return(f, { businessUse: { internet_phone: { percentTenths: 700, ...WHO } } });
    const at100 = computeTy2025Return(f, {});
    const ret: Ty2025Return = { ...at70, decisions: at100.decisions };
    const r = runL2({ ret, effective: applyOverrides(ret, []), facts: f });
    expect(r.summary.mismatchCount).toBeGreaterThan(0);
    expect(JSON.stringify(r.findings)).toContain("schc.25");
  });
  it("an unreadable recorded percentage makes the oracle abstain (null), never guess", () => {
    const f = facts();
    const base = computeTy2025Return(f, { businessUse: { internet_phone: { percentTenths: 700, ...WHO } } });
    const decisions = base.decisions.map((d) => (d.id === "X6" ? { ...d, chosen: "seventy percent" } : d));
    const input: L2Input = { ret: { ...base, decisions }, effective: null, facts: f };
    // the decision text carries no percent sign, so it is not treated as a percentage and the account is read at the default
    expect(oracleLedger(input).get("schc.25")).toBe(2610);
    const odd = base.decisions.map((d) => (d.id === "X6" ? { ...d, chosen: "101%" } : d));
    const L = oracleLedger({ ret: { ...base, decisions: odd }, effective: null, facts: f });
    expect(L.get("schc.25")).toBeNull();
    expect(L.abstentions.some((a) => a.area === "Schedule C line 25" && /could not be read/.test(a.reason))).toBe(true);
  });
});
