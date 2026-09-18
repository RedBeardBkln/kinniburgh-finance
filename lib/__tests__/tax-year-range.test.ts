import { describe, it, expect } from "vitest";
import { isValidPriorYear, MIN_TAX_YEAR } from "../tax-year-range";

describe("isValidPriorYear", () => {
  const currentYear = 2026;

  it("rejects a year below MIN_TAX_YEAR", () => {
    expect(isValidPriorYear(MIN_TAX_YEAR - 1, currentYear)).toBe(false);
  });

  it("accepts a year exactly at MIN_TAX_YEAR", () => {
    expect(isValidPriorYear(MIN_TAX_YEAR, currentYear)).toBe(true);
  });

  it("accepts a year equal to currentYear (edge case)", () => {
    expect(isValidPriorYear(currentYear, currentYear)).toBe(true);
  });

  it("accepts a year one above currentYear (opening a workspace in advance)", () => {
    expect(isValidPriorYear(currentYear + 1, currentYear)).toBe(true);
  });

  it("rejects a year two above currentYear", () => {
    expect(isValidPriorYear(currentYear + 2, currentYear)).toBe(false);
  });

  it("accepts an ordinary prior year within bounds", () => {
    expect(isValidPriorYear(2019, currentYear)).toBe(true);
  });

  it("rejects a non-integer year", () => {
    expect(isValidPriorYear(2019.5, currentYear)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isValidPriorYear(NaN, currentYear)).toBe(false);
  });
});
