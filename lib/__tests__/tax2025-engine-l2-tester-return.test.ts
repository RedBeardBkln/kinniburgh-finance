// Tester whole-return checks for engine ty2025-1b.6: the changed lines are recomputed from the engine's own input lines with
// independent integer arithmetic (Form 8995 lines 16 / 17, Form 6251 line 4), across a seeded scenario matrix.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 120000 });
import { describe, expect, it } from "vitest";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { downstreamOf } from "@/lib/tax2025/line-flow";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { LineKey, Ty2025Return } from "@/lib/tax2025/types";
import { dividend, fullFacts1b, gl, owner } from "./tax2025-fixtures";

const num = (r: Ty2025Return, k: LineKey): number | null => r.lines[k]?.amount ?? null;
const st = (r: Ty2025Return, k: LineKey): string | undefined => r.lines[k]?.status;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const ri = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

function scenario(r: () => number): Ty2025Facts {
  const f = fullFacts1b();
  const wages = ri(r, 0, 400_000) * 100;
  f.income.w2s[0]!.wagesCents = wages;
  f.income.w2s[0]!.medicareWagesCents = wages;
  f.income.w2s[0]!.socialSecurityWagesCents = Math.min(wages, 17_610_000);
  f.income.w2s[1]!.wagesCents = ri(r, 0, 60_000) * 100;
  const rev = ri(r, 0, 150_000) * 100;
  const exp1 = ri(r, 0, 120_000) * 100;
  const exp2 = ri(r, 0, 60_000) * 100;
  f.income.scheduleC.glLines = [
    gl("4000", "Services", "revenue", rev),
    gl("5010", "Office expenses:Software & apps", "expense", exp1),
    gl("5020", "Insurance:Business insurance", "expense", exp2),
  ];
  const m = f.deductions.mortgages[0]!;
  m.interestCents = r() < 0.4 ? ri(r, 1_000_000, 6_000_000) : m.interestCents;
  const nSeniors = ri(r, 0, 2);
  f.returnAnswers.people.forEach((p, i) => {
    p.bornBefore1961 = owner(i < nSeniors);
    p.validSsn = owner(true);
  });
  f.returnAnswers.magiExclusionsNone = owner(true);
  if (r() < 0.15) f.adjustments.sch1a = owner(r() < 0.5 ? 0 : 400_000);
  return f;
}

describe("tester: whole-return Form 8995 lines 16 / 17 and Form 6251 line 4 against own arithmetic", () => {
  it("300 seeded scenarios", () => {
    const r = lcg(1006);
    let loss = 0;
    let amtComputed = 0;

    let withSenior = 0;
    let itemized = 0;
    for (let n = 0; n < 300; n++) {
      const f = scenario(r);
      const ret = computeTy2025Return(f);
      const ctx = `scenario ${n}`;
      // Form 8995
      if (st(ret, "f8995.2") === "computed") {
        const l2 = num(ret, "f8995.2") ?? NaN;
        const l3 = num(ret, "f8995.3") ?? 0;
        const l16 = Math.min(0, l2 + l3);
        if (st(ret, "f8995.16") === "computed") {
          expect(num(ret, "f8995.16"), ctx).toBe(l16);
          expect(num(ret, "f8995.17"), ctx).toBe(0);
          if (l16 < 0) {
            loss++;
            expect(ret.formsRequired.f8995?.required, ctx).toBe(true);
            expect(ret.openItems.some((o) => o.id === "qbi-carryforward-out"), ctx).toBe(true);
            expect(num(ret, "f8995.4"), ctx).toBe(0);
          } else {
            expect(ret.openItems.some((o) => o.id === "qbi-carryforward-out"), ctx).toBe(false);
          }
        }
      }
      // Form 6251
      const amtiSt = st(ret, "f6251.amti");
      if (amtiSt === "computed" || amtiSt === "needs_cpa_rule_unverified") {
        amtComputed++;
        const l11b = num(ret, "f1040.11b") ?? NaN;
        const l14 = num(ret, "f1040.14") ?? NaN;
        const s37 = num(ret, "sch1a.37") ?? 0;
        const itemizing = (num(ret, "scha.17") ?? -1) > (num(ret, "std.total") ?? Infinity);
        const l2a = itemizing ? (num(ret, "scha.7") ?? NaN) : (num(ret, "f1040.12e") ?? NaN);
        if (itemizing) itemized++;
        if (s37 > 0) withSenior++;
        const l1a = l14 - s37;
        const l1b = l11b - l1a;
        expect(num(ret, "f6251.amti"), ctx).toBe(l1b + l2a);
      }
    }
    expect(loss).toBeGreaterThan(10);
    expect(amtComputed).toBeGreaterThan(100);
    expect(withSenior).toBeGreaterThan(30);
    expect(itemized).toBeGreaterThan(20);
  });
});

// LINE_FLOW completeness for the lines this engine round changed: when one of them changes between a base return and a mutated
// return, some OTHER changed line must reach it through downstreamOf (otherwise the review sheet / overrides under-flag it).
describe("tester: LINE_FLOW reaches the changed Form 8995 / Form 6251 / Schedule A lines for 9 input mutations", () => {
  const muts: [string, (f: Ty2025Facts) => void][] = [
    ["wages", (f) => { f.income.w2s[0]!.wagesCents = (f.income.w2s[0]!.wagesCents ?? 0) + 3_000_000; f.income.w2s[0]!.medicareWagesCents = (f.income.w2s[0]!.medicareWagesCents ?? 0) + 3_000_000; }],
    ["Schedule C loss", (f) => { f.income.scheduleC.glLines = [gl("4000", "Services", "revenue", 2_100_000), gl("5010", "Office expenses:Software & apps", "expense", 1_500_000), gl("5020", "Insurance:Business insurance", "expense", 1_501_000)]; }],
    ["Schedule C expense", (f) => { f.income.scheduleC.glLines = [gl("4000", "Services", "revenue", 6_000_000), gl("5010", "Office expenses:Software & apps", "expense", 700_000), gl("5020", "Insurance:Business insurance", "expense", 400_000)]; }],
    ["mortgage interest (itemize)", (f) => { f.deductions.mortgages[0]!.interestCents = 8_000_000; }],
    ["property tax", (f) => { f.deductions.propertyTaxBills[0]!.paidInYearCents = 1_500_000; }],
    ["both seniors", (f) => { f.returnAnswers.magiExclusionsNone = owner(true); f.returnAnswers.people.forEach((p) => { p.bornBefore1961 = owner(true); p.validSsn = owner(true); }); }],
    ["qualified dividends", (f) => { f.income.dividends = [dividend({ docId: "div-1", box1aCents: 1_500_000, box1bCents: 1_300_000 })]; }],
    ["stated Schedule 1-A total", (f) => { f.adjustments.sch1a = owner(400_000); }],
    ["a cash donation with cents", (f) => { f.deductions.noDonationsConfirmed = owner(false); f.deductions.donations = [{ id: "d1", kind: "cash", amountCents: 1_004_000, substantiation: "written_acknowledgment", receiptDocumentId: "r1", donee: "x", date: "2025-03-01" } as never]; }],
  ];
  const watched = new Set<string>(["f8995.2", "f8995.4", "f8995.8", "f8995.10", "f8995.15", "f8995.16", "f8995.17", "f6251.amti", "f6251.tmt", "f6251.amt", "scha.7", "scha.14", "scha.17"]);
  it.each(muts)("%s", (_name, mutate) => {
    const base = computeTy2025Return(fullFacts1b());
    const f = fullFacts1b();
    mutate(f);
    const next = computeTy2025Return(f);
    const changed = (Object.keys(next.lines) as LineKey[]).filter((k) => JSON.stringify([base.lines[k]?.status, base.lines[k]?.amount]) !== JSON.stringify([next.lines[k]?.status, next.lines[k]?.amount]));
    for (const t of changed.filter((k) => watched.has(k))) {
      const reached = changed.some((x) => x !== t && (downstreamOf(x) as string[]).includes(t));
      expect(reached, `${t} changed but no other changed line reaches it`).toBe(true);
    }
  });
});
