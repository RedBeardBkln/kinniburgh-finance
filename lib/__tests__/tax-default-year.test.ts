import { describe, it, expect } from "vitest";
import { defaultFilingTaxYear } from "@/lib/tax-default-year";

describe("defaultFilingTaxYear", () => {
  it("is the previous calendar year (the return being filed)", () => {
    expect(defaultFilingTaxYear(new Date("2026-10-04T12:00:00Z"))).toBe(2025);
    expect(defaultFilingTaxYear(new Date("2027-01-02T12:00:00Z"))).toBe(2026);
    expect(defaultFilingTaxYear(new Date("2026-12-31T23:59:59Z"))).toBe(2025);
  });
});
