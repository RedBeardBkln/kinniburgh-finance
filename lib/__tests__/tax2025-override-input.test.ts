import { describe, expect, it } from "vitest";
import {
  checkDecisionForm,
  checkLineForm,
  checkReasonInput,
  describeActionFailure,
  formatOverrideHistoryRow,
  parseWholeDollarInput,
  reasonCounterText,
  sortHistoryNewestFirst,
} from "@/lib/tax2025/override-input";
import type { OverrideHistoryRow } from "@/lib/tax2025/overrides";

// The dialog's pure helpers (there is no jsdom / component test infrastructure in this repo).

describe("parseWholeDollarInput", () => {
  it.each([
    ["12345", 12345],
    ["$12,345", 12345],
    ["  $12,345  ", 12345],
    ["-500", -500],
    ["-$500", -500],
    ["$-500", -500],
    ["0", 0],
    ["$0", 0],
    ["-0", 0],
    ["21,000,000", 21_000_000],
    ["-21,000,000", -21_000_000],
    ["1,234,567", 1_234_567],
  ])("accepts %j as %d dollars", (text, dollars) => {
    const r = parseWholeDollarInput(text);
    expect(r).toEqual({ ok: true, dollars, cents: dollars * 100 });
  });

  it("never returns -0 cents for a typed zero", () => {
    const r = parseWholeDollarInput("-0");
    expect(r.ok && Object.is(r.cents, -0)).toBe(false);
  });

  it.each(["12.50", "12.00", "$0.99", ".5", "", "   ", "abc", "1e3", "12 345", "12,34", "1,2345", "$", "-", "--5", "-$-5", "5-", "12abc", "$12,345.", "٣٤٥"])(
    "rejects %j with a plain sentence",
    (text) => {
      const r = parseWholeDollarInput(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
    }
  );

  it("rejects cents with the 'whole dollars' sentence", () => {
    const r = parseWholeDollarInput("12.50");
    expect(r).toEqual({ ok: false, error: "Whole dollars only: leave out the cents." });
  });

  it("rejects amounts past $21,000,000 in either direction (and unsafe integers), naming the limit", () => {
    for (const t of ["21,000,001", "$21000001", "-21,000,001", "99999999999999999999"]) {
      const r = parseWholeDollarInput(t);
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.error).toContain("$21,000,000");
    }
  });

  it("honours a custom bound", () => {
    expect(parseWholeDollarInput("101", 100).ok).toBe(false);
    expect(parseWholeDollarInput("100", 100).ok).toBe(true);
  });
});

describe("reason checks", () => {
  it("trims, then needs 3 to 500 characters", () => {
    expect(checkReasonInput("  ab  ")).toMatchObject({ ok: false, length: 2 });
    expect(checkReasonInput("abc")).toEqual({ ok: true, length: 3 });
    expect(checkReasonInput("x".repeat(500))).toEqual({ ok: true, length: 500 });
    expect(checkReasonInput("x".repeat(501))).toMatchObject({ ok: false, length: 501 });
    expect(reasonCounterText("  abc ")).toBe("3/500");
  });
});

describe("Save gating", () => {
  it("is disabled until the amount AND the reason are valid, and while saving", () => {
    expect(checkLineForm({ amountText: "", reasonText: "", busy: false })).toEqual({ canSave: false, amountError: null, reasonError: null, cents: null });
    expect(checkLineForm({ amountText: "12.5", reasonText: "per CPA", busy: false })).toMatchObject({ canSave: false, amountError: "Whole dollars only: leave out the cents." });
    expect(checkLineForm({ amountText: "$1,000", reasonText: "ab", busy: false })).toMatchObject({ canSave: false, reasonError: expect.stringContaining("at least 3") });
    expect(checkLineForm({ amountText: "$1,000", reasonText: "per CPA", busy: false })).toEqual({ canSave: true, amountError: null, reasonError: null, cents: 100_000 });
    expect(checkLineForm({ amountText: "$1,000", reasonText: "per CPA", busy: true }).canSave).toBe(false);
  });

  it("a decision needs a chosen alternative and a reason", () => {
    expect(checkDecisionForm({ choice: null, reasonText: "per CPA", busy: false }).canSave).toBe(false);
    expect(checkDecisionForm({ choice: "actual", reasonText: "", busy: false }).canSave).toBe(false);
    expect(checkDecisionForm({ choice: "actual", reasonText: "per CPA", busy: false }).canSave).toBe(true);
    expect(checkDecisionForm({ choice: "actual", reasonText: "per CPA", busy: true }).canSave).toBe(false);
  });
});

describe("server result wording", () => {
  it("a conflict says to reload; other errors pass through", () => {
    expect(describeActionFailure({ ok: false, error: "x", code: "conflict" })).toBe("Someone changed this just now. Reload and try again.");
    expect(describeActionFailure({ ok: false, error: "No change: the override equals the computed value." })).toBe("No change: the override equals the computed value.");
  });
});

describe("formatOverrideHistoryRow", () => {
  const base: OverrideHistoryRow = {
    id: "r1",
    version: 2,
    valueKind: "money_cents",
    valueCents: 1_300_000,
    valueText: null,
    authority: "cpa",
    reason: "CPA said so",
    setByName: "Eric Kinniburgh",
    setAt: "2026-10-12T02:30:00.000Z", // 22:30 on the 11th in New York
    archivedAt: null,
    archiveKind: null,
    archiveReason: null,
  };

  it("a current row", () => {
    expect(formatOverrideHistoryRow(base)).toEqual({
      title: "Version 2 (current)",
      valueText: "$13,000",
      authorityLabel: "CPA",
      setText: "Set by Eric Kinniburgh on 2026-10-11",
      reasonText: "CPA said so",
      clearReasonText: null,
      state: "current",
    });
  });

  it("a superseded row names the replacement date; the reason is kept", () => {
    const r = formatOverrideHistoryRow({ ...base, version: 1, valueCents: -50_000, authority: "owner", archivedAt: "2026-10-13T16:00:00.000Z", archiveKind: "superseded" });
    expect(r).toMatchObject({ title: "Version 1 (replaced on 2026-10-13)", valueText: "-$500", authorityLabel: "Owner (Eric/Eva)", state: "superseded", clearReasonText: null });
  });

  it("a cleared row carries its clear reason", () => {
    const r = formatOverrideHistoryRow({ ...base, version: 3, archivedAt: "2026-10-14T01:00:00.000Z", archiveKind: "cleared", archiveReason: "CPA withdrew it" });
    expect(r).toMatchObject({ title: "Version 3 (cleared on 2026-10-13)", state: "cleared", clearReasonText: "CPA withdrew it" });
  });

  it("decision and acknowledgement rows", () => {
    expect(formatOverrideHistoryRow({ ...base, valueKind: "choice", valueCents: null, valueText: "actual" }).valueText).toBe("choice: actual");
    expect(formatOverrideHistoryRow({ ...base, valueKind: "ack", valueCents: null }).valueText).toBe("acknowledged");
  });

  it("dates follow America/New_York across the DST boundaries (spring forward / fall back)", () => {
    // 2026-03-08 07:00Z is 03:00 EDT; 2026-03-08 04:59Z is 23:59 EST on the 7th
    expect(formatOverrideHistoryRow({ ...base, setAt: "2026-03-08T04:59:00.000Z" }).setText).toContain("2026-03-07");
    expect(formatOverrideHistoryRow({ ...base, setAt: "2026-03-08T07:00:00.000Z" }).setText).toContain("2026-03-08");
    // 2026-11-01 04:30Z is 00:30 EDT; 2026-11-01 03:59Z is 23:59 EDT on Oct 31
    expect(formatOverrideHistoryRow({ ...base, setAt: "2026-11-01T03:59:00.000Z" }).setText).toContain("2026-10-31");
    expect(formatOverrideHistoryRow({ ...base, setAt: "2026-11-01T04:30:00.000Z" }).setText).toContain("2026-11-01");
  });

  it("sorts every version newest first", () => {
    const rows = [1, 3, 2].map((v) => ({ ...base, id: `r${v}`, version: v }));
    expect(sortHistoryNewestFirst(rows).map((r) => r.version)).toEqual([3, 2, 1]);
  });
});
