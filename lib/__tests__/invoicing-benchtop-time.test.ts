import { describe, expect, it } from "vitest";
import { buildTimeLines, documentTimeEntryIds, hoursText, nyWorkDate, parseHourlyRate, pendingTimeSync, type BenchtopEntry } from "@/lib/invoicing/benchtop/time-lines";
import { looksLikeBenchtopKey } from "@/lib/invoicing/benchtop/client";
import { detailToDraftInput } from "@/lib/invoicing/draft-input";
import type { InvoiceDetail } from "@/lib/invoicing/documents-build";
import { validateDraft } from "@/lib/invoicing/validate";

// Benchtop time import (CLAUDE.md "Benchtop time import"): the pure line builder, the billed-in-Benchtop state and the draft rules.

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const C = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const CLIENT = "22222222-2222-4222-8222-222222222222";

const entry = (id: string, startedAt: string, minutes: number, over: Partial<BenchtopEntry> = {}): BenchtopEntry => ({
  id,
  startedAt,
  endedAt: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(),
  minutes,
  activity: "Research",
  task: "Stability data",
  projectName: null,
  person: "Eric",
  ...over,
});

describe("hoursText", () => {
  it("rounds half-up to the step and trims zeros", () => {
    expect(hoursText(95, "exact")).toBe("1.58"); // 1.5833
    expect(hoursText(90, "exact")).toBe("1.5");
    expect(hoursText(60, "exact")).toBe("1");
    expect(hoursText(95, "tenth")).toBe("1.6");
    expect(hoursText(93, "tenth")).toBe("1.6"); // 1.55 rounds up
    expect(hoursText(92, "tenth")).toBe("1.5");
    expect(hoursText(95, "quarter")).toBe("1.5");
    expect(hoursText(98, "quarter")).toBe("1.75"); // 1.633 -> 1.75 (nearer than 1.5)
    expect(hoursText(8, "quarter")).toBe("0.25"); // 0.133 is nearer 0.25 than 0
  });
  it("zero after rounding is null", () => {
    expect(hoursText(0, "exact")).toBeNull();
    expect(hoursText(2, "tenth")).toBeNull();
    expect(hoursText(7, "quarter")).toBeNull(); // 0.1167 is nearer 0
  });
});

describe("nyWorkDate", () => {
  it("uses the New York calendar day", () => {
    expect(nyWorkDate("2026-10-31T02:30:00.000Z")).toBe("2026-10-30");
    expect(nyWorkDate("2026-10-31T14:00:00.000Z")).toBe("2026-10-31");
  });
});

describe("buildTimeLines", () => {
  const entries = [
    entry(B, "2026-10-21T15:00:00.000Z", 30, { task: "Call with QA", activity: "Phone call", projectName: "Gummy" }),
    entry(A, "2026-10-20T15:00:00.000Z", 90, { projectName: "Gummy" }),
    entry(C, "2026-10-21T18:00:00.000Z", 45, { task: "Label review" }),
  ];

  it("one line per entry, oldest first, with the work date and the entry id", () => {
    const { lines, skipped } = buildTimeLines(entries, { grouping: "entry", rounding: "exact" });
    expect(skipped).toEqual([]);
    expect(lines.map((l) => [l.workDate, l.quantity, l.timeEntryIds])).toEqual([
      ["2026-10-20", "1.5", [A]],
      ["2026-10-21", "0.5", [B]],
      ["2026-10-21", "0.75", [C]],
    ]);
    expect(lines[0]!.description).toBe("Gummy · Research: Stability data");
    expect(lines[2]!.description).toBe("Research: Label review");
    expect(lines.every((l) => l.unit === "hr")).toBe(true);
  });

  it("one line per day rounds the day's total once", () => {
    const { lines } = buildTimeLines(entries, { grouping: "day", rounding: "quarter" });
    expect(lines.map((l) => [l.workDate, l.quantity, l.timeEntryIds])).toEqual([
      ["2026-10-20", "1.5", [A]],
      ["2026-10-21", "1.25", [B, C]],
    ]);
    expect(lines[1]!.description).toBe("Gummy · Phone call: Call with QA; Research: Label review");
  });

  it("one line per project; no project reads General", () => {
    const { lines } = buildTimeLines(entries, { grouping: "project", rounding: "exact" });
    expect(lines.map((l) => [l.description.split(":")[0], l.quantity, l.timeEntryIds.length])).toEqual([
      ["Gummy", "2", 2],
      ["General", "0.75", 1],
    ]);
  });

  it("a line that rounds to zero is left out and its entries are reported", () => {
    const { lines, skipped } = buildTimeLines([entry(A, "2026-10-20T15:00:00.000Z", 2)], { grouping: "entry", rounding: "tenth" });
    expect(lines).toEqual([]);
    expect(skipped).toEqual([A]);
  });

  it("caps long descriptions", () => {
    const { lines } = buildTimeLines([entry(A, "2026-10-20T15:00:00.000Z", 60, { task: "x".repeat(900) })], { grouping: "entry", rounding: "exact" });
    expect(lines[0]!.description.length).toBe(500);
    expect(lines[0]!.description.endsWith("…")).toBe(true);
  });
});

describe("pendingTimeSync", () => {
  const ev = (kind: string, at: string) => ({ kind, createdAt: at });
  it("nothing for drafts or invoices without Benchtop time", () => {
    expect(pendingTimeSync("draft", 3, [])).toBeNull();
    expect(pendingTimeSync("issued", 0, [])).toBeNull();
  });
  it("issued: needs billing until a time_billed row; a failure is flagged", () => {
    expect(pendingTimeSync("issued", 2, [])).toEqual({ direction: "bill", failed: false });
    expect(pendingTimeSync("issued", 2, [ev("time_bill_failed", "2026-10-31T10:00:00Z")])).toEqual({ direction: "bill", failed: true });
    expect(pendingTimeSync("issued", 2, [ev("time_bill_failed", "2026-10-31T10:00:00Z"), ev("time_billed", "2026-10-31T11:00:00Z")])).toBeNull();
  });
  it("void: needs unbilling, whatever the billing rows say", () => {
    expect(pendingTimeSync("void", 2, [ev("time_billed", "2026-10-31T10:00:00Z")])).toEqual({ direction: "unbill", failed: false });
    expect(pendingTimeSync("void", 2, [ev("time_billed", "2026-10-31T10:00:00Z"), ev("time_unbilled", "2026-10-31T12:00:00Z")])).toBeNull();
  });
});

describe("rates, keys and ids", () => {
  it("parses an hourly rate", () => {
    expect(parseHourlyRate("175")).toBe(17_500);
    expect(parseHourlyRate("$175.5")).toBe(17_550);
    expect(parseHourlyRate("0")).toBeNull();
    expect(parseHourlyRate("abc")).toBeNull();
    expect(parseHourlyRate("10000.01")).toBeNull();
  });
  it("checks the Benchtop key shape", () => {
    expect(looksLikeBenchtopKey(`btk_${"a".repeat(43)}`)).toBe(true);
    expect(looksLikeBenchtopKey(`btk_${"a".repeat(42)}`)).toBe(false);
    expect(looksLikeBenchtopKey("sk_test_abc")).toBe(false);
  });
  it("collects each entry id once", () => {
    expect(documentTimeEntryIds([{ timeEntryIds: [A, B] }, { timeEntryIds: [B, C] }, { timeEntryIds: [] }])).toEqual([A, B, C]);
  });
});

describe("drafts carry the entry ids", () => {
  const ctx = { today: new Date("2026-10-31T00:00:00Z"), goLiveOn: new Date("2026-10-01T00:00:00Z"), forIssue: false };
  const line = (ids: string[]) => ({ description: "Research", quantity: "1.5", unitPrice: "175", timeEntryIds: ids });

  it("keeps valid ids, lower-cased", () => {
    const r = validateDraft({ clientId: CLIENT, lines: [line([A.toUpperCase()])] }, ctx);
    expect(r.ok && r.value.lines[0]!.timeEntryIds).toEqual([A]);
  });
  it("refuses a non-uuid id and the same entry on two lines", () => {
    expect(validateDraft({ clientId: CLIENT, lines: [line(["nope"])] }, ctx).ok).toBe(false);
    const twice = validateDraft({ clientId: CLIENT, lines: [line([A]), line([A])] }, ctx);
    expect(twice.ok).toBe(false);
    expect(!twice.ok && twice.error).toMatch(/two lines/);
  });
  it("lines without imported time are unchanged", () => {
    const r = validateDraft({ clientId: CLIENT, lines: [{ description: "Fee", quantity: "1", unitPrice: "100" }] }, ctx);
    expect(r.ok && r.value.lines[0]!.timeEntryIds).toEqual([]);
  });
  it("a duplicated invoice never bills the same time again", () => {
    const detail = {
      clientId: CLIENT, billingModel: "hourly", title: null, poNumber: null, issueDate: null, netDays: null, notes: null, internalNotes: null,
      discountKind: null, discountValueText: "", includeRemitTo: false, showEin: false,
      lines: [{ description: "Research", quantity: "1.5", unit: "hr", unitPriceCents: 17_500, discountKind: null, discountValueText: "", glCodeId: null, taxable: false, workDate: "2026-10-20", itemId: null, unitCostCents: null, markupBps: null, costTransactionId: null, receiptId: null, timeEntryIds: [A] }],
    } as unknown as InvoiceDetail;
    expect(detailToDraftInput(detail).lines[0]!.timeEntryIds).toEqual([A]);
    expect(detailToDraftInput(detail, { forDuplicate: true }).lines[0]!.timeEntryIds).toEqual([]);
  });
});
