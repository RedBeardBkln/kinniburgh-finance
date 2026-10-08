import { describe, it, expect } from "vitest";
import { planYearCloseEvent } from "@/lib/tax-year-close/plan";
import { parseFiledOn, validateCloseNote, validateReopenReason } from "@/lib/tax-year-close/validate";
import type { YearCloseEventRow } from "@/lib/tax-year-close/types";

const NOW = new Date("2026-10-13T15:00:00Z");
const ev = (o: Partial<YearCloseEventRow> & { seq: number; kind: YearCloseEventRow["kind"] }): YearCloseEventRow => ({
  id: `e${o.seq}`,
  taxYear: 2025,
  filedOn: o.kind === "closed" ? new Date("2026-10-12T12:00:00Z") : null,
  note: null,
  byName: "Eric",
  at: NOW,
  ...o,
});

describe("planYearCloseEvent", () => {
  it("close from open: seq 1", () => {
    const r = planYearCloseEvent([], { kind: "closed", taxYear: 2025, filedOn: "2026-10-12", note: "  e-filed  " }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row).toMatchObject({ taxYear: 2025, seq: 1, kind: "closed", note: "e-filed" });
      expect(r.row.filedOn?.toISOString()).toBe("2026-10-12T12:00:00.000Z");
    }
  });

  it("close from reopened: seq = max + 1", () => {
    const hist = [ev({ seq: 1, kind: "closed" }), ev({ seq: 2, kind: "reopened", note: "why" })];
    const r = planYearCloseEvent(hist, { kind: "closed", taxYear: 2025, filedOn: "2026-10-13" }, NOW);
    expect(r.ok && r.row.seq).toBe(3);
  });

  it("close when already closed is refused", () => {
    const r = planYearCloseEvent([ev({ seq: 1, kind: "closed" })], { kind: "closed", taxYear: 2025, filedOn: "2026-10-12" }, NOW);
    expect(r).toMatchObject({ ok: false });
  });

  it("reopen when open or already reopened is refused", () => {
    expect(planYearCloseEvent([], { kind: "reopened", taxYear: 2025, reason: "Because" }, NOW).ok).toBe(false);
    const hist = [ev({ seq: 1, kind: "closed" }), ev({ seq: 2, kind: "reopened", note: "why" })];
    expect(planYearCloseEvent(hist, { kind: "reopened", taxYear: 2025, reason: "Because" }, NOW).ok).toBe(false);
  });

  it("reopen needs a reason of 3 to 500 characters", () => {
    const hist = [ev({ seq: 1, kind: "closed" })];
    for (const reason of [undefined, null, "", "  ", "ab", "x".repeat(501)]) {
      expect(planYearCloseEvent(hist, { kind: "reopened", taxYear: 2025, reason }, NOW).ok, String(reason)).toBe(false);
    }
    const ok = planYearCloseEvent(hist, { kind: "reopened", taxYear: 2025, reason: "abc" }, NOW);
    expect(ok.ok && ok.row).toMatchObject({ seq: 2, kind: "reopened", note: "abc", filedOn: null });
    expect(planYearCloseEvent(hist, { kind: "reopened", taxYear: 2025, reason: "x".repeat(500) }, NOW).ok).toBe(true);
  });

  it("a note or reason that looks like an SSN, an EIN, a confirmation number or a birth date is refused", () => {
    const hist = [ev({ seq: 1, kind: "closed" })];
    for (const bad of ["ssn 123-45-6789", "EIN 12-3456789", "confirmation 1234567890", "date of birth 1/2/1980", "acct 987654321"]) {
      expect(planYearCloseEvent([], { kind: "closed", taxYear: 2025, filedOn: "2026-10-12", note: bad }, NOW).ok, bad).toBe(false);
      expect(planYearCloseEvent(hist, { kind: "reopened", taxYear: 2025, reason: bad }, NOW).ok, bad).toBe(false);
    }
  });

  it("the error never echoes the rejected text", () => {
    const r = planYearCloseEvent([], { kind: "closed", taxYear: 2025, filedOn: "2026-10-12", note: "confirmation 1234567890" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("1234567890");
  });

  it("events of other years do not affect the seq or the state", () => {
    const hist = [ev({ seq: 5, kind: "closed", taxYear: 2024 })];
    const r = planYearCloseEvent(hist, { kind: "closed", taxYear: 2025, filedOn: "2026-10-12" }, NOW);
    expect(r.ok && r.row.seq).toBe(1);
  });

  it("refuses a year outside the supported range", () => {
    expect(planYearCloseEvent([], { kind: "closed", taxYear: 1999, filedOn: "2026-10-12" }, NOW).ok).toBe(false);
    expect(planYearCloseEvent([], { kind: "closed", taxYear: 2025.5, filedOn: "2026-10-12" }, NOW).ok).toBe(false);
  });
});

describe("parseFiledOn", () => {
  it("accepts a real date between Jan 1 of the following year and today (New York)", () => {
    const r = parseFiledOn("2026-10-12", 2025, NOW);
    expect(r.ok && r.value.toISOString()).toBe("2026-10-12T12:00:00.000Z");
    expect(parseFiledOn("2026-01-01", 2025, NOW).ok).toBe(true);
    expect(parseFiledOn("2026-10-13", 2025, NOW).ok).toBe(true); // today
  });

  it("malformed text is refused", () => {
    for (const t of ["", "10/12/2026", "2026-1-5", "2026-10-12T00:00", "tomorrow", "20261012"]) {
      expect(parseFiledOn(t, 2025, NOW).ok, t).toBe(false);
    }
  });

  it("an impossible calendar date is refused", () => {
    for (const t of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31"]) {
      expect(parseFiledOn(t, 2025, NOW).ok, t).toBe(false);
    }
  });

  it("before Jan 1 of the year after the tax year is refused (TY2025 cannot be filed in 2025)", () => {
    const r = parseFiledOn("2025-12-31", 2025, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("2026-01-01");
  });

  it("tomorrow is refused", () => {
    const r = parseFiledOn("2026-10-14", 2025, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("future");
  });

  it("around midnight the comparison uses the New York date, not UTC", () => {
    // 2026-10-14 02:30 UTC is still Oct 13 evening in New York: Oct 14 is tomorrow, Oct 13 is today.
    const lateEvening = new Date("2026-10-14T02:30:00Z");
    expect(parseFiledOn("2026-10-13", 2025, lateEvening).ok).toBe(true);
    expect(parseFiledOn("2026-10-14", 2025, lateEvening).ok).toBe(false);
    // 2026-10-14 05:00 UTC is 01:00 Oct 14 in New York: Oct 14 is today.
    expect(parseFiledOn("2026-10-14", 2025, new Date("2026-10-14T05:00:00Z")).ok).toBe(true);
  });
});

describe("note and reason validation", () => {
  it("an empty note is no note; over 500 characters is refused", () => {
    expect(validateCloseNote("  ")).toEqual({ ok: true, value: null });
    expect(validateCloseNote(null)).toEqual({ ok: true, value: null });
    expect(validateCloseNote("x".repeat(501)).ok).toBe(false);
    expect(validateCloseNote("x".repeat(500)).ok).toBe(true);
  });

  it("a reason is trimmed and required", () => {
    expect(validateReopenReason("  Found an error  ")).toEqual({ ok: true, value: "Found an error" });
    expect(validateReopenReason("").ok).toBe(false);
  });
});
