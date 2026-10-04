import { describe, expect, it } from "vitest";
import { D } from "@/lib/tax2025/money";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { qdcgWorksheet, taxOnAmount } from "@/lib/tax2025/rules/tax-calc";
import { hasAmount, type LineKey, type Ty2025Return } from "@/lib/tax2025/types";
import { ERIC_ID, EVA_ID, fullFacts, owner, w2 } from "@/lib/__tests__/tax2025-fixtures";
import type { Ty2025Facts } from "@/lib/tax2025/facts";

// Property-style invariants (plan 9.3 item 4), on deterministic grids (no random generator):
//   tax never decreases as taxable income rises; the QDCG worksheet never exceeds the regular tax;
//   adding a deduction never raises tax; every total equals the sum of its printed parts.

function v(r: Ty2025Return, key: LineKey): number | null {
  const l = r.lines[key];
  return l && hasAmount(l.status) ? l.amount : null;
}

describe("tax function invariants", () => {
  it("regular tax is non-decreasing in taxable income across 0 to 800,000 (including every Tax Table row and the worksheet boundary)", () => {
    let prev = -1;
    for (let ti = 0; ti <= 800_000; ti += ti < 120_000 ? 7 : 997) {
      const t = taxOnAmount(D(ti)).tax.toNumber();
      expect(t, `ti ${ti}`).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it("the Qualified Dividends and Capital Gain worksheet never gives more than the regular tax, and more preferential income never raises tax", () => {
    for (const ti of [20_000, 55_000, 96_700, 100_000, 150_000, 400_000, 650_000]) {
      let prevTax = Number.POSITIVE_INFINITY;
      for (const qd of [0, 1_000, 5_000, 15_000, 19_999]) {
        const ws = qdcgWorksheet(D(ti), D(qd), D(0));
        expect(ws.tax.lessThanOrEqualTo(ws.line[24]!), `ti ${ti} qd ${qd}`).toBe(true);
        expect(ws.tax.toNumber()).toBeLessThanOrEqual(prevTax);
        prevTax = ws.tax.toNumber();
      }
    }
  });
});

describe("return invariants", () => {
  function scenario(evaWages: number, ericWages: number): Ty2025Facts {
    const f = fullFacts();
    f.income.w2s = [
      w2({
        docId: "w2-eric",
        personUserId: ERIC_ID,
        wagesCents: ericWages * 100,
        fedWithheldCents: Math.round(ericWages * 0.12) * 100,
        socialSecurityWagesCents: Math.min(ericWages, 176_100) * 100,
        socialSecurityWithheldCents: Math.round(Math.min(ericWages, 176_100) * 0.062 * 100),
        medicareWagesCents: ericWages * 100,
        medicareWithheldCents: Math.round(ericWages * 0.0145 * 100),
        ctWithheldCents: Math.round(ericWages * 0.03) * 100,
      }),
      w2({
        docId: "w2-eva",
        personUserId: EVA_ID,
        wagesCents: evaWages * 100,
        fedWithheldCents: Math.round(evaWages * 0.1) * 100,
        socialSecurityWagesCents: Math.min(evaWages, 176_100) * 100,
        socialSecurityWithheldCents: Math.round(Math.min(evaWages, 176_100) * 0.062 * 100),
        medicareWagesCents: evaWages * 100,
        medicareWithheldCents: Math.round(evaWages * 0.0145 * 100),
        ctWithheldCents: Math.round(evaWages * 0.03) * 100,
      }),
    ];
    return f;
  }

  const wageGrid: [number, number][] = [
    [20_000, 30_000],
    [40_000, 90_000],
    [60_000, 150_000],
    [100_000, 200_000],
    [150_000, 300_000],
  ];

  it("every printed total equals the sum of its printed parts (computed lines only), across income levels", () => {
    for (const [eva, eric] of wageGrid) {
      const r = computeTy2025Return(scenario(eva, eric));
      const check = (total: LineKey, parts: LineKey[], op: (a: number, b: number) => number = (a, b) => a + b) => {
        const t = v(r, total);
        const ps = parts.map((p) => v(r, p));
        if (t === null || ps.some((p) => p === null)) return;
        const nums = ps as number[];
        expect(t, `${total} at wages ${eva}/${eric}`).toBe(nums.slice(1).reduce((a, b) => op(a, b), nums[0]!));
      };
      check("f1040.1z", ["f1040.1a", "f1040.1b", "f1040.1c", "f1040.1d", "f1040.1e", "f1040.1f", "f1040.1g", "f1040.1h"]);
      check("f1040.9", ["f1040.1z", "f1040.2b", "f1040.3b", "f1040.4b", "f1040.5b", "f1040.6b", "f1040.7a", "f1040.8"]);
      check("f1040.11a", ["f1040.9", "f1040.10"], (a, b) => a - b);
      check("f1040.14", ["f1040.12e", "f1040.13a", "f1040.13b"]);
      check("f1040.24", ["f1040.22", "f1040.23"]);
      check("f1040.25d", ["f1040.25a", "f1040.25b", "f1040.25c"]);
      check("f1040.33", ["f1040.25d", "f1040.26", "f1040.32"]);
      check("sch2.21", ["sch2.4", "sch2.7", "sch2.8", "sch2.9", "sch2.11", "sch2.12", "sch2.13", "sch2.14", "sch2.15", "sch2.16", "sch2.18", "sch2.19"]);
      check("se.12", ["se.10", "se.11"]);
      check("sch1.10", ["sch1.1", "sch1.2a", "sch1.3", "sch1.4", "sch1.5", "sch1.6", "sch1.7", "sch1.9"]);
      // taxable income and the balance
      const agi = v(r, "f1040.11b");
      const ded = v(r, "f1040.14");
      const ti = v(r, "f1040.15");
      if (agi !== null && ded !== null && ti !== null) expect(ti).toBe(Math.max(0, agi - ded));
      const owe = v(r, "f1040.37");
      const over = v(r, "f1040.34");
      const tax = v(r, "f1040.24");
      const paid = v(r, "f1040.33");
      if (owe !== null && over !== null && tax !== null && paid !== null) {
        expect(owe - over).toBe(tax - paid);
        expect(owe === 0 || over === 0).toBe(true);
      }
      // headline matches the lines
      expect(r.headline.federal.totalTax.amount).toBe(v(r, "f1040.24"));
    }
  });

  it("every emitted amount is a whole-dollar integer at every income level, including the 8959 / AMT / NIIT / QBI-limit regimes", () => {
    for (const [eva, eric] of wageGrid) {
      const r = computeTy2025Return(scenario(eva, eric));
      for (const l of Object.values(r.lines)) {
        if (l && hasAmount(l.status)) expect(Number.isInteger(l.amount), `${l.key} ${eva}/${eric}`).toBe(true);
      }
    }
  });

  it("higher wages never lower income-tax-bearing totals: AGI and taxable income are non-decreasing", () => {
    let prevAgi = -1;
    let prevTi = -1;
    for (const [eva, eric] of wageGrid) {
      const r = computeTy2025Return(scenario(eva, eric));
      const agi = v(r, "f1040.11a");
      const ti = v(r, "f1040.15");
      if (agi !== null) {
        expect(agi).toBeGreaterThanOrEqual(prevAgi);
        prevAgi = agi;
      }
      if (ti !== null) {
        expect(ti).toBeGreaterThanOrEqual(prevTi);
        prevTi = ti;
      }
    }
  });

  it("adding a deduction never raises tax: more charitable gifts (within 20% of AGI, itemizing) never increase total tax", () => {
    const base = fullFacts();
    // large mortgage interest so itemizing wins and gifts matter
    base.deductions.mortgages[0]!.interestCents = 3_500_000;
    let prev = Number.POSITIVE_INFINITY;
    let sawItemize = false;
    for (const gift of [0, 500_000, 1_000_000, 2_000_000, 3_000_000]) {
      const f = structuredClone(base);
      f.deductions.donations = gift === 0 ? [] : [{ id: "d", dateIso: "2025-06-01", recipient: "Library", kind: "cash", amountCents: gift, substantiation: "written_acknowledgment", receiptDocumentId: "r1" }];
      f.deductions.noDonationsConfirmed = gift === 0 ? owner(true) : { value: null, basis: null, refs: [] };
      const r = computeTy2025Return(f);
      const tax = v(r, "f1040.24");
      expect(tax, `gift ${gift}`).not.toBeNull();
      expect(tax!).toBeLessThanOrEqual(prev);
      prev = tax!;
      if ((v(r, "scha.17") ?? 0) > 31_500) sawItemize = true;
    }
    expect(sawItemize).toBe(true);
  });
});
