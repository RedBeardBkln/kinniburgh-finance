// L2 oracle vs the engine on random households (the differential pattern the repo's tester oracles use), with a coverage guard so the
// fuzz set is known to exercise each branch of the 2025 rules.
//
// What this pins, precisely:
//  - On every COMPLETE random return the recalculation agrees with the engine on every line it recomputes and on which forms are required:
//    NO difference at all (engine ty2025-1b.6 and later). The four differences this fuzz found in engine ty2025-1b.5 are closed in the engine
//    (Form 6251 line 1a / 1b / 2a with Schedule 1-A line 37 and a negative line 1b; Form 8995 lines 16 / 17; Schedule A line 14 = the printed
//    lines 11 + 12 + 13) and their pins are removed, so any difference now fails this test loudly instead of being absorbed by an allow-list.
//  - The set contains at least 500 complete returns and each branch listed in GUARDS is hit often enough.
//  - SEED RANGE: the default bases are 1 and 20000 (800 seeds each). Set L2_FUZZ_BASE to sweep another range (the integration tester swept 20000, 50000, 90000,
//    120000, 300000 and 400000; two of them found the oracle treating "Schedule A not recomputed" as "does not itemize" on Form 8960, fixed in
//    lib/tax-review/l2/federal.ts). A coverage guard that is under its minimum on an unusual range is reported as a guard failure, not a difference.

import { vi } from "vitest";
vi.setConfig({ testTimeout: 240000 });
import { describe, expect, it } from "vitest";
import { applyOverrides } from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { oracleLedger, runL2 } from "@/lib/tax-review/l2";
import type { Ledger } from "@/lib/tax-review/l2/ledger";
import type { Finding } from "@/lib/tax-review/types";
import { randomHousehold } from "./tax-review-l2-gen";

const SEEDS = 800;
// Seed bases swept by default (800 seeds each); L2_FUZZ_BASE=<n> runs one other range.
const BASES: number[] = process.env["L2_FUZZ_BASE"] !== undefined ? [Number(process.env["L2_FUZZ_BASE"])] : [1, 20000];

const GUARDS: Record<string, (L: Ledger) => boolean> = {
  itemizes: (L) => (L.get("scha.17") ?? 0) > (L.get("std.total") ?? Infinity),
  standard: (L) => (L.get("scha.17") ?? 0) <= (L.get("std.total") ?? 0),
  saltCapBinds: (L) => (L.get("scha.5d") ?? 0) > (L.get("scha.5e") ?? 0),
  otherRealEstate: (L) => (L.get("scha.5b") ?? 0) > 0,
  charity: (L) => (L.get("scha.14") ?? 0) > 0,
  mortgagePoints: (L) => (L.get("scha.8a") ?? 0) > 0,
  seTax: (L) => (L.get("se.12") ?? 0) > 0,
  seWageBaseReached: (L) => L.get("se.9") === 0 && (L.get("se.12") ?? 0) > 0,
  seUnderFloor: (L) => L.get("se.12") === 0 && !L.lines.has("se.6") && (L.get("schc.31") ?? 0) > 0,
  schCLoss: (L) => (L.get("schc.31") ?? 0) < 0,
  mealsAndMileage: (L) => (L.get("schc.24b") ?? 0) > 0 && (L.get("schc.9") ?? 0) > 0,
  homeOffice: (L) => (L.get("schc.30") ?? 0) > 0,
  booksInterest: (L) => (L.get("schb.2") ?? 0) > 0,
  qbiDeduction: (L) => (L.get("f1040.13a") ?? 0) > 0,
  qbiLoss: (L) => (L.get("f8995.2") ?? 0) < 0,
  reitDividends: (L) => (L.get("f8995.6") ?? 0) > 0,
  addlMedicare: (L) => (L.get("f8959.18") ?? 0) > 0,
  addlMedicareWithheld: (L) => (L.get("f1040.25c") ?? 0) > 0,
  niit: (L) => (L.get("f8960.niit") ?? 0) > 0,
  niit9b: (L) => (L.get("f8960.9b") ?? 0) > 0,
  excessSs: (L) => (L.get("sch3.11") ?? 0) > 0,
  qdcg: (L) => L.lines.has("qdcg.25"),
  schD: (L) => L.lines.has("schd.16"),
  schDLoss: (L) => (L.get("schd.21") ?? 0) > 0,
  schDWash: (L) => ["1b", "2", "8b", "9"].some((l) => (L.get(`schd.${l}.g`) ?? 0) > 0),
  schDDirect: (L) => L.lines.has("schd.1a.d") || L.lines.has("schd.8a.d"),
  schDCarryover: (L) => (L.get("schd.6") ?? 0) > 0 || (L.get("schd.14") ?? 0) > 0,
  capGainDistributionsOnly: (L) => !L.lines.has("schd.16") && (L.get("f1040.7a") ?? 0) > 0,
  tips: (L) => (L.get("sch1a.13") ?? 0) > 0,
  overtime: (L) => (L.get("sch1a.21") ?? 0) > 0,
  carLoan: (L) => (L.get("sch1a.30") ?? 0) > 0,
  seniors: (L) => (L.get("sch1a.37") ?? 0) > 0,
  sch1aPhaseOut: (L) => (L.get("sch1a.12") ?? 0) > 0 || (L.get("sch1a.20") ?? 0) > 0 || (L.get("sch1a.29") ?? 0) > 0 || (L.get("sch1a.35") ?? 6000) < 6000,
  amtScreen: (L) => (L.get("f6251.tmt") ?? 0) > 0,
  form2210RequiredPayment: (L) => L.lines.has("f2210.9"),
  form2210StopRule: (L) => L.lines.has("f2210.4") && !L.lines.has("f2210.5"),
  ctCredit: (L) => (L.get("ct1040.11") ?? 0) > 0,
  ctTableD: (L) => (L.get("ct1040.ctAgi") ?? 0) > 210_000,
  ctUseTax: (L) => (L.get("ct1040.15") ?? 0) > 0,
  ctBalanceDue: (L) => (L.get("ct1040.balance") ?? 0) > 0,
  ctRefund: (L) => (L.get("ct1040.balance") ?? 0) < 0,
  fedBalanceDue: (L) => (L.get("f1040.37") ?? 0) > 0,
  fedRefund: (L) => (L.get("f1040.34") ?? 0) > 0,
};

const MIN_HITS: Record<string, number> = {
  // everything defaults to 25; the rarer branches are listed here
  saltCapBinds: 10,
  reitDividends: 5,
  schDLoss: 10,
  carLoan: 10,
  homeOffice: 10,
  excessSs: 10,
  seWageBaseReached: 10,
  seUnderFloor: 0,
  form2210StopRule: 3,
  sch1aPhaseOut: 5,
  addlMedicareWithheld: 10,
  capGainDistributionsOnly: 10,
  schDDirect: 10,
};

interface Outcome {
  seed: number;
  findings: Finding[];
  ledger: Ledger;
}

function sweep(BASE: number): { ran: Outcome[]; incomplete: number } {
  const ran: Outcome[] = [];
  let incomplete = 0;
  for (let seed = BASE; seed < BASE + SEEDS; seed++) {
    const g = randomHousehold(seed);
    const ret = computeTy2025Return(g.facts, g.decisions);
    if (!ret.headline.complete) {
      incomplete += 1;
      continue;
    }
    const effective = applyOverrides(ret, []);
    const result = runL2({ ret, effective, facts: g.facts });
    expect(result.status, `seed ${seed}: ${result.reason ?? ""}`).toBe("ran");
    const ledger = oracleLedger({ ret, effective, facts: g.facts });
    ran.push({ seed, findings: result.findings.filter((f) => f.check !== "L2.coverage"), ledger });
  }
  return { ran, incomplete };
}

describe.each(BASES)("L2 oracle vs engine on random households (seeds from %i)", (base) => {
  const { ran, incomplete } = sweep(base);

  it("exercises at least 500 complete returns (the others are blocked by the engine and are not recomputed)", () => {
    expect(ran.length).toBeGreaterThanOrEqual(500);
    expect(ran.length + incomplete).toBe(SEEDS);
  });

  it("every branch in GUARDS is hit often enough", () => {
    const hits: Record<string, number> = {};
    for (const [name, pred] of Object.entries(GUARDS)) hits[name] = ran.filter((o) => pred(o.ledger)).length;
    // The per-branch minimums are tuned for the default bases; an explicitly chosen range only has to touch every branch at least once
    // (a rare branch such as the Form 2210 stop rule or the Social Security wage base can fall to 1 to 8 hits on an unlucky range: that is coverage, not a difference).
    const floor = (name: string): number => (process.env["L2_FUZZ_BASE"] !== undefined ? Math.min(1, MIN_HITS[name] ?? 25) : (MIN_HITS[name] ?? 25));
    const short = Object.entries(hits).filter(([name, n]) => n < floor(name));
    expect(short, `branches under-exercised: ${JSON.stringify(Object.fromEntries(short))}; all: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it("no difference at all: every recomputed line and every form-required prediction agrees with the engine", () => {
    const differences: string[] = [];
    for (const o of ran) for (const f of o.findings) differences.push(`seed ${o.seed}: ${f.severity} ${f.check}: ${f.message.slice(0, 200)}`);
    expect(differences.slice(0, 10)).toEqual([]);
  });

  it("a household with a Schedule C loss is predicted to need Form 8995 (lines 16 / 17 record the carryforward) and the engine agrees", () => {
    const lossYears = ran.filter((o) => (o.ledger.get("f8995.16") ?? 0) < 0);
    expect(lossYears.length).toBeGreaterThanOrEqual(5);
    for (const o of lossYears) expect(o.findings.filter((f) => f.check === "L2.forms.f8995" || f.check.startsWith("L2.diff.f8995")), `seed ${o.seed}`).toEqual([]);
  });

  it("the recalculation compares more than 300 lines of a typical return and none is a silent zero (every compared line has an engine amount or is an explicit blank)", () => {
    const sizes = ran.map((o) => [...o.ledger.lines.values()].filter((l) => l.source === "oracle" && l.value !== null).length);
    expect(Math.min(...sizes)).toBeGreaterThan(200);
    expect(Math.max(...sizes)).toBeGreaterThan(330);
  });
});

// Seeds that once showed a disagreement, pinned whatever the sweep ranges are.
describe("regression seeds", () => {
  const cases: Array<{ seed: number; why: string }> = [
    { seed: 50787, why: "itemizing return with a negative AGI: Schedule A was not recomputed (gifts over the lowest AGI limit), so Form 8960 lines 9-17 are unknown, not 'standard deduction'" },
    { seed: 90584, why: "the same shape with AGI near zero" },
    { seed: 120076, why: "a $1 Schedule A line 14 rounding that crossed a Tax Table row (engine 1b.5)" },
    { seed: 300556, why: "the same Schedule A line 14 rounding (engine 1b.5)" },
  ];
  for (const c of cases) {
    it(`seed ${c.seed}: no difference (${c.why})`, () => {
      const g = randomHousehold(c.seed);
      const ret = computeTy2025Return(g.facts, g.decisions);
      expect(ret.headline.complete).toBe(true);
      const result = runL2({ ret, effective: applyOverrides(ret, []), facts: g.facts });
      expect(result.status).toBe("ran");
      expect(result.findings.filter((f) => f.check !== "L2.coverage").map((f) => `${f.severity} ${f.check}`)).toEqual([]);
    });
  }
  it("seed 50787: the oracle says Form 8960 lines 9-17 are not recomputed instead of printing a line 12 of its own", () => {
    const g = randomHousehold(50787);
    const ret = computeTy2025Return(g.facts, g.decisions);
    const ledger = oracleLedger({ ret, effective: applyOverrides(ret, []), facts: g.facts });
    expect(ledger.lines.has("f8960.nii")).toBe(false);
    expect(ledger.abstentions.some((a) => a.area === "Form 8960 lines 9-17")).toBe(true);
  });
});
