// The business-use list and its helpers (engine ty2025-1b.9, decision X6): parse / format / lookups and the structural pins that keep a
// mixed-use account a plain Schedule C `line` target (so it can never also be meals, home-office-actual or vehicle-actual).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUSINESS_USE_ACCOUNTS,
  BUSINESS_USE_DEFAULT_TENTHS,
  businessUseDefByDecisionId,
  businessUseKeyOf,
  businessUseTargetKey,
  canonicalPercentText,
  formatBusinessUsePercent,
  parseBusinessUsePercent,
  roundMilliCentsToDollars,
  tenthsOfPercentText,
} from "@/lib/tax2025/business-use";
import { GL_SCHEDULE_C_MAP } from "@/lib/tax2025/gl-schedule-c-map";
import { findRedactionIssues } from "@/lib/tax-review/redact";

describe("parseBusinessUsePercent", () => {
  it("accepts 0 to 100 with at most one decimal, a trailing %, and surrounding spaces", () => {
    const cases: [string, number, string][] = [
      ["0", 0, "0"],
      ["70", 700, "70"],
      ["70.5", 705, "70.5"],
      ["100", 1000, "100"],
      ["70%", 700, "70"],
      [" 70 ", 700, "70"],
      ["70.0", 700, "70"],
      ["070", 700, "70"],
      ["100.0", 1000, "100"],
      ["0.5", 5, "0.5"],
      ["33.3 %", 333, "33.3"],
    ];
    for (const [text, tenths, canonical] of cases) {
      const p = parseBusinessUsePercent(text);
      expect(p, text).toEqual({ ok: true, tenths, canonical });
    }
  });
  it("refuses blank, text, negatives, over 100, two decimals, exponents, a bare decimal point and a comma", () => {
    for (const text of ["", "   ", "abc", "-1", "-0", "100.1", "101", "999", "70.55", "1e2", ".5", "70,5", "007x", "7 0", "70.", "NaN", "Infinity", "1000"]) {
      const p = parseBusinessUsePercent(text);
      expect(p.ok, JSON.stringify(text)).toBe(false);
      if (!p.ok) expect(p.error).toBe("Enter a percentage from 0 to 100, with at most one decimal.");
    }
  });
  it("formats tenths back to text", () => {
    expect(formatBusinessUsePercent(1000)).toBe("100%");
    expect(formatBusinessUsePercent(700)).toBe("70%");
    expect(formatBusinessUsePercent(705)).toBe("70.5%");
    expect(formatBusinessUsePercent(5)).toBe("0.5%");
    expect(formatBusinessUsePercent(0)).toBe("0%");
    expect(canonicalPercentText(333)).toBe("33.3");
    expect(BUSINESS_USE_DEFAULT_TENTHS).toBe(1000);
  });
  it("round-trips a formatted percent", () => {
    for (let t = 0; t <= 1000; t += 1) expect(tenthsOfPercentText(formatBusinessUsePercent(t)), String(t)).toBe(t);
    expect(tenthsOfPercentText("nonsense")).toBeNull();
    expect(tenthsOfPercentText("101%")).toBeNull();
  });
});

describe("lookups", () => {
  it("businessUseKeyOf resolves the list entry and nothing else", () => {
    expect(businessUseKeyOf("businessUse.internet_phone")?.decisionId).toBe("X6");
    for (const bad of ["businessUse.", "businessUse.constructor", "businessUse.__proto__", "businessUse.toString", "businessUse.internet_phone2", "businessUse.internet", "internet_phone", "", "homeOfficeMethod", "BusinessUse.internet_phone"]) {
      expect(businessUseKeyOf(bad), bad).toBeNull();
    }
    expect(businessUseDefByDecisionId("X6")?.key).toBe("internet_phone");
    expect(businessUseDefByDecisionId("X1")).toBeNull();
    expect(businessUseTargetKey(BUSINESS_USE_ACCOUNTS[0])).toBe("businessUse.internet_phone");
  });
});

describe("integer rounding helper (cents x tenths of a percent -> dollars, once)", () => {
  it("matches the hand table of the plan", () => {
    expect(roundMilliCentsToDollars(261_017 * 1000)).toBe(2610);
    expect(roundMilliCentsToDollars(261_017 * 700)).toBe(1827);
    expect(roundMilliCentsToDollars(261_017 * 705)).toBe(1840);
    expect(roundMilliCentsToDollars(261_017 * 333)).toBe(869);
    expect(roundMilliCentsToDollars(0)).toBe(0);
    expect(roundMilliCentsToDollars(100_100 * 500)).toBe(501);
    expect(roundMilliCentsToDollars(100_030 * 500)).toBe(500);
    // internet 1,000.30 at 50% + electricity 100.40 at 100% on one line: rounded ONCE = 601 (per-account rounding would print 600)
    expect(roundMilliCentsToDollars(100_030 * 500 + 10_040 * 1000)).toBe(601);
    expect(roundMilliCentsToDollars(-100_100 * 500)).toBe(-501);
  });
});

describe("structure of the list", () => {
  it("every entry's map account exists and is a plain `line` target: never meals, home-office actual, vehicle or cogs", () => {
    for (const a of BUSINESS_USE_ACCOUNTS) {
      const entry = GL_SCHEDULE_C_MAP.find((e) => e.account === a.mapAccount);
      expect(entry, a.key).toBeDefined();
      expect(entry?.target.kind, a.key).toBe("line");
      if (entry?.target.kind === "line") expect(entry.target.meals ?? false, a.key).toBe(false);
    }
  });
  it("decision ids and keys are unique, well-formed, and do not collide with the registry decisions", () => {
    const ids = BUSINESS_USE_ACCOUNTS.map((a) => a.decisionId as string);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z][A-Za-z0-9]{0,15}$/);
      expect(["X1", "X2", "X3", "X5"]).not.toContain(id);
    }
    const keys = BUSINESS_USE_ACCOUNTS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
  });
  it("labels and keys carry no person, property or business name and pass the redaction scrub (they travel to the AI payload)", () => {
    for (const a of BUSINESS_USE_ACCOUNTS) {
      const text = `${a.key} ${a.label} ${a.what}`.replace(/EK Consulting/g, "the business");
      expect(text, a.key).not.toMatch(/\b(eric|eva|laura|arbor|sudden valley|mezzo|barn|kinniburgh|ramirez)\b/i);
      expect(findRedactionIssues(a.label), a.key).toEqual([]);
      expect(a.label, a.key).not.toMatch(/\b(eric|eva|laura|arbor|sudden valley|mezzo|barn)\b/i);
    }
  });
  it("the helper file has no float or Math rounding (integer arithmetic only) and imports nothing by value", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "..", "tax2025", "business-use.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
    expect(code).not.toMatch(/Math\.(round|floor|ceil|trunc)/);
    expect(code).not.toMatch(/parseFloat|Number\(["'`]|toFixed|new Decimal/);
    expect(code).not.toMatch(/^import\s/m);
  });
});
