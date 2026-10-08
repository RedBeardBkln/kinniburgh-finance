import { describe, it, expect } from "vitest";
import {
  foldAllYears,
  foldYearState,
  latestClosedYear,
  toYearCloseView,
  widgetStatus,
} from "@/lib/tax-year-close/state";
import { CLOSE_HONESTY, CLOSE_MIGRATION_MISSING, CLOSE_PRIVACY_WARNING, yearBadgeText, yearBannerText } from "@/lib/tax-year-close/format";
import { NOT_OWNER_MESSAGE, OWNER_UNKNOWN_MESSAGE, resolveYearCloser } from "@/lib/tax-year-close/closer";
import type { YearCloseEventRow } from "@/lib/tax-year-close/types";
import { findCpaWording } from "@/lib/tax-wording";

const ev = (o: Partial<YearCloseEventRow> & { seq: number; kind: YearCloseEventRow["kind"] }): YearCloseEventRow => ({
  id: `e${o.seq}-${o.taxYear ?? 2025}`,
  taxYear: 2025,
  filedOn: o.kind === "closed" ? new Date("2026-10-12T12:00:00Z") : null,
  note: null,
  byName: "Eric Kinniburgh",
  at: new Date(`2026-10-1${o.seq}T15:00:00Z`),
  ...o,
});

describe("foldYearState", () => {
  it("no events: open", () => {
    const s = foldYearState(2025, []);
    expect(s.status).toBe("open");
    expect(s.history).toEqual([]);
    expect(yearBadgeText(s)).toBeNull();
    expect(yearBannerText(s)).toBeNull();
  });

  it("closed", () => {
    const s = foldYearState(2025, [ev({ seq: 1, kind: "closed", note: "e-filed" })]);
    expect(s.status).toBe("closed");
    expect(s.note).toBe("e-filed");
    expect(s.closedByName).toBe("Eric Kinniburgh");
  });

  it("closed then reopened: reopened, keeps the earlier filing date and the reason", () => {
    const s = foldYearState(2025, [ev({ seq: 1, kind: "closed" }), ev({ seq: 2, kind: "reopened", note: "Corrected a 1099" })]);
    expect(s.status).toBe("reopened");
    expect(s.reopenReason).toBe("Corrected a 1099");
    expect(s.filedOn?.toISOString()).toBe("2026-10-12T12:00:00.000Z");
  });

  it("closed, reopened, closed again: closed with the NEW filing date", () => {
    const s = foldYearState(2025, [
      ev({ seq: 1, kind: "closed" }),
      ev({ seq: 2, kind: "reopened", note: "Corrected a 1099" }),
      ev({ seq: 3, kind: "closed", filedOn: new Date("2026-11-02T12:00:00Z") }),
    ]);
    expect(s.status).toBe("closed");
    expect(s.filedOn?.toISOString()).toBe("2026-11-02T12:00:00.000Z");
    expect(s.reopenReason).toBeNull();
    expect(s.history.map((h) => h.seq)).toEqual([1, 2, 3]);
  });

  it("the highest seq wins whatever the array order", () => {
    const events = [ev({ seq: 3, kind: "closed" }), ev({ seq: 1, kind: "closed" }), ev({ seq: 2, kind: "reopened", note: "why" })];
    expect(foldYearState(2025, events).status).toBe("closed");
    expect(foldYearState(2025, [...events].reverse()).status).toBe("closed");
    expect(foldYearState(2025, events).history.map((h) => h.seq)).toEqual([1, 2, 3]);
  });

  it("ignores events of other years and does not mutate its input", () => {
    const events = [ev({ seq: 1, kind: "closed", taxYear: 2024 }), ev({ seq: 1, kind: "closed", taxYear: 2025 })];
    const before = JSON.stringify(events);
    expect(foldYearState(2026, events).status).toBe("open");
    expect(foldYearState(2024, events).history).toHaveLength(1);
    expect(JSON.stringify(events)).toBe(before);
  });
});

describe("foldAllYears / latestClosedYear", () => {
  const events = [
    ev({ seq: 1, kind: "closed", taxYear: 2025 }),
    ev({ seq: 1, kind: "closed", taxYear: 2026 }),
    ev({ seq: 2, kind: "reopened", taxYear: 2026, note: "Corrected a form" }),
  ];

  it("a reopened year does not count as the latest closed year", () => {
    const all = foldAllYears(events);
    expect([...all.keys()]).toEqual([2025, 2026]);
    expect(all.get(2026)?.status).toBe("reopened");
    expect(latestClosedYear(all.values())).toBe(2025);
  });

  it("none closed -> null; the highest closed year wins", () => {
    expect(latestClosedYear([])).toBeNull();
    expect(latestClosedYear(foldAllYears([ev({ seq: 1, kind: "closed", taxYear: 2025 }), ev({ seq: 1, kind: "closed", taxYear: 2027 })]).values())).toBe(2027);
  });
});

describe("widgetStatus (the Personal widget on /tax)", () => {
  const closed = foldYearState(2025, [ev({ seq: 1, kind: "closed" })]);
  const reopened = foldYearState(2025, [ev({ seq: 1, kind: "closed" }), ev({ seq: 2, kind: "reopened", note: "why" })]);

  it("Personal follows the close state when the year has one", () => {
    expect(widgetStatus("personal", "extended", closed)).toBe("filed");
    expect(widgetStatus("personal", "extended", reopened)).toBe("reopened");
  });

  it("falls back to the workspace status with no close events, and for a business entity", () => {
    expect(widgetStatus("personal", "extended", null)).toBe("extended");
    expect(widgetStatus("personal", "in_progress", undefined)).toBe("in_progress");
    expect(widgetStatus("personal", null, foldYearState(2025, []))).toBeNull();
    expect(widgetStatus("business", "in_progress", closed)).toBe("in_progress");
    expect(widgetStatus("business", null, closed)).toBeNull();
  });
});

describe("wording", () => {
  const closed = foldYearState(2025, [ev({ seq: 1, kind: "closed", note: "e-filed" })]);
  const reopened = foldYearState(2025, [ev({ seq: 1, kind: "closed" }), ev({ seq: 2, kind: "reopened", note: "why" })]);

  it("badge text", () => {
    expect(yearBadgeText(closed)).toBe("TY2025 filed 2026-10-12");
    expect(yearBadgeText(reopened)).toBe("TY2025 reopened for revision");
  });

  it("banner text names the Tax Forms page and never claims receipt, acceptance or checking", () => {
    const texts = [yearBannerText(closed)!, yearBannerText(reopened)!, CLOSE_HONESTY, CLOSE_PRIVACY_WARNING, CLOSE_MIGRATION_MISSING, NOT_OWNER_MESSAGE, OWNER_UNKNOWN_MESSAGE];
    expect(yearBannerText(closed)).toContain("Reopen the year on the Tax Forms page to revise it.");
    expect(yearBannerText(reopened)).toContain("Mark it filed again");
    for (const t of texts) {
      expect(findCpaWording(t), t.slice(0, 50)).toEqual([]);
      expect(t).not.toMatch(/accepted by|\bClaude\b|\bAI\b|certif|approved by|reviewed by/i);
      expect(t).not.toMatch(/the Forms page/);
    }
    expect(CLOSE_HONESTY).toContain("does not check with the IRS or Connecticut DRS");
    expect(CLOSE_HONESTY).toContain("changes no computation, form or approval");
  });

  it("the filing date is a New York calendar date (stored 12:00 UTC)", () => {
    expect(toYearCloseView(closed).filedOn).toBe("2026-10-12");
  });

  it("toYearCloseView is a plain, serializable view", () => {
    const v = toYearCloseView(reopened);
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    expect(v.status).toBe("reopened");
    expect(v.reopenReason).toBe("why");
    expect(v.history.map((h) => h.kind)).toEqual(["closed", "reopened"]);
  });
});

describe("resolveYearCloser (owner only)", () => {
  const users = [
    { id: "u-eric", name: "Eric Kinniburgh" },
    { id: "u-eva", name: "Eva-Laura Ramirez-Wisiackas" },
  ];
  it("allows the owner, refuses the other account with the close-specific text", () => {
    expect(resolveYearCloser(users, "Eric Kinniburgh Consulting, LLC", "u-eric")).toMatchObject({ allowed: true, reason: null });
    const eva = resolveYearCloser(users, "Eric Kinniburgh Consulting, LLC", "u-eva");
    expect(eva).toMatchObject({ allowed: false, reason: NOT_OWNER_MESSAGE });
    expect(eva.reason).not.toMatch(/approve/);
  });

  it("fails closed when the owner cannot be named", () => {
    expect(resolveYearCloser(users, null, "u-eric")).toMatchObject({ allowed: false, reason: OWNER_UNKNOWN_MESSAGE });
    expect(resolveYearCloser(users, "Some Other LLC", "u-eric")).toMatchObject({ allowed: false, reason: OWNER_UNKNOWN_MESSAGE });
    expect(OWNER_UNKNOWN_MESSAGE).not.toMatch(/approved/);
  });
});
