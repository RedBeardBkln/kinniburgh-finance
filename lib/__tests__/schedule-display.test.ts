import { describe, it, expect } from "vitest";
import { formatSchedule, scheduleSortKey, type ScheduleLike } from "@/lib/schedule-display";

function sched(overrides: Partial<ScheduleLike> = {}): ScheduleLike {
  return {
    frequency: "monthly",
    payDay: null,
    payDayOfWeek: null,
    biweeklyAnchorDate: null,
    ...overrides,
  };
}

describe("formatSchedule", () => {
  it("monthly: formats as ordinal day", () => {
    expect(formatSchedule(sched({ frequency: "monthly", payDay: 15 }))).toBe("15th");
    expect(formatSchedule(sched({ frequency: "monthly", payDay: 1 }))).toBe("1st");
    expect(formatSchedule(sched({ frequency: "monthly", payDay: 2 }))).toBe("2nd");
    expect(formatSchedule(sched({ frequency: "monthly", payDay: 3 }))).toBe("3rd");
    expect(formatSchedule(sched({ frequency: "monthly", payDay: 21 }))).toBe("21st");
  });

  it("monthly with no payDay: em dash", () => {
    expect(formatSchedule(sched({ frequency: "monthly", payDay: null }))).toBe("—");
  });

  it("weekly: 'Weekly · <Day>'", () => {
    expect(formatSchedule(sched({ frequency: "weekly", payDayOfWeek: 1 }))).toBe("Weekly · Mon");
    expect(formatSchedule(sched({ frequency: "weekly", payDayOfWeek: 0 }))).toBe("Weekly · Sun");
    expect(formatSchedule(sched({ frequency: "weekly", payDayOfWeek: 6 }))).toBe("Weekly · Sat");
  });

  it("biweekly: 'Biweekly · <Day>'", () => {
    expect(formatSchedule(sched({ frequency: "biweekly", payDayOfWeek: 3 }))).toBe("Biweekly · Wed");
  });

  it("frequency undefined/missing (old MonthlyReview JSON): defaults to monthly formatting", () => {
    expect(formatSchedule(sched({ frequency: undefined, payDay: 10 }))).toBe("10th");
    expect(formatSchedule(sched({ frequency: null, payDay: 10 }))).toBe("10th");
  });

  it("unrecognized frequency string: defaults to monthly formatting", () => {
    expect(formatSchedule(sched({ frequency: "quarterly", payDay: 5 }))).toBe("5th");
  });
});

describe("scheduleSortKey", () => {
  it("monthly rows sort by payDay, after weekly/biweekly rows", () => {
    const monthly15 = sched({ frequency: "monthly", payDay: 15 });
    const monthly1 = sched({ frequency: "monthly", payDay: 1 });
    const weeklyMon = sched({ frequency: "weekly", payDayOfWeek: 1 });
    const biweeklyWed = sched({ frequency: "biweekly", payDayOfWeek: 3 });

    const rows = [monthly15, monthly1, weeklyMon, biweeklyWed];
    const sorted = [...rows].sort((a, b) => {
      const [ag, ak] = scheduleSortKey(a);
      const [bg, bk] = scheduleSortKey(b);
      return ag - bg || ak - bk;
    });

    // weekly/biweekly (group 0) sort ahead of all monthly (group 1) rows,
    // ordered by weekday within group 0, then by day-of-month within group 1.
    expect(sorted).toEqual([weeklyMon, biweeklyWed, monthly1, monthly15]);
  });

  it("monthly row with no payDay sorts last within the monthly group", () => {
    const monthlyBlank = sched({ frequency: "monthly", payDay: null });
    const monthly1 = sched({ frequency: "monthly", payDay: 1 });
    const sorted = [monthlyBlank, monthly1].sort((a, b) => {
      const [ag, ak] = scheduleSortKey(a);
      const [bg, bk] = scheduleSortKey(b);
      return ag - bg || ak - bk;
    });
    expect(sorted).toEqual([monthly1, monthlyBlank]);
  });
});

describe("annual frequency", () => {
  it("formatSchedule: 'Annual · <Mon> <day>'", () => {
    expect(formatSchedule(sched({ frequency: "annual", payMonth: 10, payDay: 15 }))).toBe("Annual · Oct 15");
    expect(formatSchedule(sched({ frequency: "annual", payMonth: 1, payDay: 1 }))).toBe("Annual · Jan 1");
  });

  it("formatSchedule: annual with a missing month or day shows a dash, not a bad date", () => {
    expect(formatSchedule(sched({ frequency: "annual", payMonth: null, payDay: 15 }))).toBe("Annual · —");
    expect(formatSchedule(sched({ frequency: "annual", payMonth: 10, payDay: null }))).toBe("Annual · —");
  });

  it("scheduleSortKey: annual sorts after monthly, ordered by month then day", () => {
    const monthly = scheduleSortKey(sched({ frequency: "monthly", payDay: 31 }));
    const march = scheduleSortKey(sched({ frequency: "annual", payMonth: 3, payDay: 20 }));
    const october = scheduleSortKey(sched({ frequency: "annual", payMonth: 10, payDay: 1 }));
    expect(monthly[0]).toBeLessThan(march[0]);
    expect(march[0]).toBe(october[0]);
    expect(march[1]).toBeLessThan(october[1]);
  });
});
