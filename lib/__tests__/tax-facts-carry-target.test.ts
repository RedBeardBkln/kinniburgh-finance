import { describe, it, expect } from "vitest";
import {
  FIRST_CARRY_TARGET_YEAR,
  carryTargetContext,
  carryTargetYears,
  checkCarryTarget,
  currentCalendarYear,
  defaultCarryTarget,
  firstCarryTarget,
} from "@/lib/tax-facts/carry-target";

const OCT_2026 = new Date("2026-10-07T15:00:00Z");

describe("checkCarryTarget", () => {
  const ctx = (latestClosedYear: number | null, now: Date = OCT_2026) => ({ latestClosedYear, now });

  it("refuses a non-integer year", () => {
    for (const y of [Number.NaN, 2026.5, Infinity]) {
      const r = checkCarryTarget(y, ctx(null));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("not_a_year");
    }
  });

  it("refuses 1999, 2024 and 2025 (the TY2025 return is a fingerprint-bound artifact)", () => {
    for (const y of [1999, 2024, 2025]) {
      const r = checkCarryTarget(y, ctx(null));
      expect(r.ok, String(y)).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("too_early");
        expect(r.message).toContain("TY2025 and earlier");
      }
    }
  });

  it("allows 2026 and 2027 in October 2026 and refuses 2028", () => {
    expect(checkCarryTarget(2026, ctx(null)).ok).toBe(true);
    expect(checkCarryTarget(2027, ctx(null)).ok).toBe(true);
    const far = checkCarryTarget(2028, ctx(null));
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.code).toBe("too_far");
  });

  it("a year marked filed, and any earlier year, is refused; the next year is allowed", () => {
    const r = checkCarryTarget(2026, ctx(2026));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("closed");
      expect(r.message).toContain("Tax Forms page");
      expect(r.message).not.toContain("the Forms page");
    }
    expect(checkCarryTarget(2027, ctx(2026)).ok).toBe(true);
  });

  it("latestClosedYear null behaves as 2025 (only the 2025 floor)", () => {
    expect(checkCarryTarget(2025, ctx(null)).ok).toBe(false);
    expect(checkCarryTarget(2026, ctx(null)).ok).toBe(true);
  });

  it("the calendar year follows America/New_York, so New Year's Eve evening does not roll over early", () => {
    expect(currentCalendarYear(new Date("2026-12-31T23:30:00-05:00"))).toBe(2026);
    expect(currentCalendarYear(new Date("2027-01-01T00:30:00-05:00"))).toBe(2027);
    // 02:00 UTC on Jan 1 is still Dec 31 in New York
    expect(currentCalendarYear(new Date("2027-01-01T02:00:00Z"))).toBe(2026);
    expect(checkCarryTarget(2028, ctx(null, new Date("2026-12-31T23:30:00-05:00"))).ok).toBe(false);
    expect(checkCarryTarget(2028, ctx(null, new Date("2027-01-01T00:30:00-05:00"))).ok).toBe(true);
  });
});

describe("carryTargetYears / defaultCarryTarget", () => {
  it("offers 2026 and 2027 in 2026 and defaults to 2026", () => {
    const c = { latestClosedYear: null, now: OCT_2026 };
    expect(FIRST_CARRY_TARGET_YEAR).toBe(2026);
    expect(carryTargetYears(c)).toEqual([2026, 2027]);
    expect(defaultCarryTarget(c)).toBe(2026);
  });

  it("with 2026 marked filed it offers 2027 only", () => {
    const c = { latestClosedYear: 2026, now: OCT_2026 };
    expect(carryTargetYears(c)).toEqual([2027]);
    expect(defaultCarryTarget(c)).toBe(2027);
  });

  it("with nothing closed and now in 2027 it offers 2026 through 2028", () => {
    expect(carryTargetYears({ latestClosedYear: null, now: new Date("2027-03-01T12:00:00Z") })).toEqual([2026, 2027, 2028]);
  });

  it("year rollover: the last offered year moves on New Year's Day (New York)", () => {
    expect(carryTargetYears({ latestClosedYear: null, now: new Date("2026-12-31T23:30:00-05:00") })).toEqual([2026, 2027]);
    expect(carryTargetYears({ latestClosedYear: null, now: new Date("2027-01-01T00:30:00-05:00") })).toEqual([2026, 2027, 2028]);
  });

  it("offers nothing when a filed year is already beyond next year, and never offers a refused year", () => {
    const c = { latestClosedYear: 2027, now: OCT_2026 };
    expect(carryTargetYears(c)).toEqual([]);
    for (const y of carryTargetYears({ latestClosedYear: 2026, now: OCT_2026 })) {
      expect(checkCarryTarget(y, { latestClosedYear: 2026, now: OCT_2026 }).ok).toBe(true);
    }
  });

  it("firstCarryTarget is 2026 or the year after the latest filed year", () => {
    expect(firstCarryTarget(null)).toBe(2026);
    expect(firstCarryTarget(2025)).toBe(2026);
    expect(firstCarryTarget(2026)).toBe(2027);
  });

  it("carryTargetContext defaults the clock but takes an injected one", () => {
    expect(carryTargetContext(null, OCT_2026)).toEqual({ latestClosedYear: null, now: OCT_2026 });
    expect(carryTargetContext(2026).now).toBeInstanceOf(Date);
  });
});
