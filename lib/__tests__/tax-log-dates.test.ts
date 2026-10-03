import { describe, it, expect } from "vitest";
import {
  parseIsoDateNoonUtc,
  taxYearBoundsUtc,
  taxYearOfDate,
  toIsoDateInput,
  formatDateEt,
} from "@/lib/tax-log-dates";

describe("parseIsoDateNoonUtc", () => {
  it("returns noon UTC for a valid date", () => {
    const d = parseIsoDateNoonUtc("2025-03-05");
    expect(d?.toISOString()).toBe("2025-03-05T12:00:00.000Z");
  });

  it("accepts leap day only in a leap year", () => {
    expect(parseIsoDateNoonUtc("2024-02-29")).not.toBeNull();
    expect(parseIsoDateNoonUtc("2025-02-29")).toBeNull();
  });

  it("rejects impossible, malformed and out-of-range dates", () => {
    for (const bad of ["2025-02-30", "2025-13-01", "2025-00-10", "2025-04-31", "25-1-1", "2025-1-1", "", "2025/01/01", "1999-12-31", "2101-01-01", "abcd-ef-gh"]) {
      expect(parseIsoDateNoonUtc(bad), `"${bad}" should be rejected`).toBeNull();
    }
  });

  it("accepts the 2000 and 2100 year bounds", () => {
    expect(parseIsoDateNoonUtc("2000-01-01")).not.toBeNull();
    expect(parseIsoDateNoonUtc("2100-12-31")).not.toBeNull();
  });
});

describe("taxYearBoundsUtc", () => {
  it("is half-open [Jan 1, next Jan 1)", () => {
    const { start, endExclusive } = taxYearBoundsUtc(2025);
    expect(start.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(endExclusive.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    const lastNoon = parseIsoDateNoonUtc("2025-12-31")!;
    const nextNoon = parseIsoDateNoonUtc("2026-01-01")!;
    expect(lastNoon >= start && lastNoon < endExclusive).toBe(true);
    expect(nextNoon < endExclusive).toBe(false);
  });
});

describe("taxYearOfDate / toIsoDateInput / formatDateEt", () => {
  it("derives the UTC year and ISO input value", () => {
    const d = parseIsoDateNoonUtc("2025-12-31")!;
    expect(taxYearOfDate(d)).toBe(2025);
    expect(toIsoDateInput(d)).toBe("2025-12-31");
  });

  it("shows the same calendar day in America/New_York for noon-UTC dates", () => {
    expect(formatDateEt(parseIsoDateNoonUtc("2025-01-01")!)).toBe("Jan 1, 2025");
    expect(formatDateEt(parseIsoDateNoonUtc("2025-07-04")!)).toBe("Jul 4, 2025");
    expect(formatDateEt(parseIsoDateNoonUtc("2025-12-31")!)).toBe("Dec 31, 2025");
  });
});
