import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import { D, centsToDollars, dollarsToCents, fmt, roundLine, sumThenRound } from "@/lib/tax2025/money";
import {
  LINE_KEYS,
  aggregateStatus,
  hasAmount,
  missingLeaf,
  scheduleCLineKey,
  sourced,
  type RuleLine,
} from "@/lib/tax2025/types";
import { parseTy2025Facts, ty2025FactsSchema } from "@/lib/tax2025/facts";
import { emptyFacts } from "@/lib/__tests__/tax2025-fixtures";

// Plan step 2: roundLine tests (1.39 -> 1, 2.50 -> 3; sum-then-round).
// Source of the rule: 1040 instructions, "Rounding Off to Whole Dollars":
// "drop amounts under 50 cents and increase amounts from 50 to 99 cents to the next
// dollar"; "include cents when adding the amounts and round off only the total".

describe("roundLine (IRS whole-dollar rounding)", () => {
  it("1.39 -> 1 and 2.50 -> 3", () => {
    expect(roundLine(D("1.39")).toString()).toBe("1");
    expect(roundLine(D("2.50")).toString()).toBe("3");
  });
  it("0.49 -> 0, 0.50 -> 1, 0.99 -> 1, whole dollars unchanged", () => {
    expect(roundLine(D("0.49")).toString()).toBe("0");
    expect(roundLine(D("0.50")).toString()).toBe("1");
    expect(roundLine(D("0.99")).toString()).toBe("1");
    expect(roundLine(D("12")).toString()).toBe("12");
  });
  it("negative amounts round on magnitude (a $2.50 loss is -$3, -$2.49 is -$2)", () => {
    expect(roundLine(D("-2.50")).toString()).toBe("-3");
    expect(roundLine(D("-2.49")).toString()).toBe("-2");
  });
  it("sum-then-round: 0.40 + 0.40 + 0.40 = 1.20 -> 1 (not 0 + 0 + 0)", () => {
    expect(sumThenRound([D("0.40"), D("0.40"), D("0.40")]).toString()).toBe("1");
    // and the opposite trap: 0.60 + 0.60 = 1.20 -> 1, not 1 + 1 = 2
    expect(sumThenRound([D("0.60"), D("0.60")]).toString()).toBe("1");
  });
  it("always returns an integer", () => {
    for (const v of ["1234.5678", "99999.5", "0.5", "-0.5", "10.01"]) {
      expect(Number.isInteger(roundLine(D(v)).toNumber())).toBe(true);
    }
  });
});

describe("cents helpers", () => {
  it("round-trips whole cents without floats", () => {
    expect(centsToDollars(12345).toString()).toBe("123.45");
    expect(dollarsToCents(D("123.45"))).toBe(12345);
    expect(dollarsToCents(D("0.1").plus(D("0.2")))).toBe(30);
  });
  it("fmt prints dollars with separators", () => {
    expect(fmt(D("176100"))).toBe("$176,100");
    expect(fmt(D("10918.2"))).toBe("$10,918.20");
    expect(fmt(D("-5"))).toBe("-$5");
  });
});

describe("types helpers", () => {
  it("LINE_KEYS has no duplicates and includes the Schedule C line keys", () => {
    expect(new Set(LINE_KEYS).size).toBe(LINE_KEYS.length);
    expect(LINE_KEYS).toContain("f1040.11a");
    expect(LINE_KEYS).toContain(scheduleCLineKey("24b"));
  });
  it("hasAmount is true only for computed / not_applicable", () => {
    expect(hasAmount("computed")).toBe(true);
    expect(hasAmount("not_applicable")).toBe(true);
    expect(hasAmount("missing_input")).toBe(false);
    expect(hasAmount("not_yet_computed")).toBe(false);
    expect(hasAmount("needs_cpa_rule_unverified")).toBe(false);
    expect(hasAmount("needs_cpa_judgment")).toBe(false);
  });
  it("aggregateStatus: any blocked line wins, else computed, else not_applicable", () => {
    const l = (status: RuleLine["status"]): RuleLine => ({
      key: "f1040.1a",
      label: "x",
      formLine: "1a",
      amount: status === "computed" || status === "not_applicable" ? new Decimal(0) : null,
      status,
    });
    expect(aggregateStatus([l("computed"), l("missing_input")])).toBe("missing_input");
    expect(aggregateStatus([l("computed"), l("needs_cpa_rule_unverified")])).toBe("needs_cpa_rule_unverified");
    expect(aggregateStatus([l("computed"), l("not_applicable")])).toBe("computed");
    expect(aggregateStatus([l("not_applicable")])).toBe("not_applicable");
    expect(aggregateStatus([])).toBe("computed");
  });
  it("sourced / missingLeaf", () => {
    expect(sourced(5, "books", [], "n")).toEqual({ value: 5, basis: "books", refs: [], note: "n" });
    expect(missingLeaf()).toEqual({ value: null, basis: null, refs: [] });
  });
});

describe("Ty2025Facts schema", () => {
  it("accepts the all-missing facts object", () => {
    const facts = emptyFacts();
    expect(() => parseTy2025Facts(facts)).not.toThrow();
  });
  it("rejects a non-integer cents value and a wrong tax year", () => {
    const facts = emptyFacts();
    facts.payments.federal1099WithheldCents = 1.5;
    expect(ty2025FactsSchema.safeParse(facts).success).toBe(false);
    const wrongYear = { ...emptyFacts(), taxYear: 2024 };
    expect(ty2025FactsSchema.safeParse(wrongYear).success).toBe(false);
  });
});
