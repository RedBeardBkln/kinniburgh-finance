import { describe, expect, it } from "vitest";
import {
  MAX_CELL,
  MAX_COLUMNS,
  MAX_ROWS,
  MAX_TEXT_CHARS,
  classifyAgainstLive,
  liveKeyOf,
  parseMonthCell,
  parseNumberCell,
  parseUsageText,
  planWrites,
  rowKeyOf,
  suggestMapping,
  type ColumnRole,
  type ParseInput,
  type ParseOutcome,
  type ParsedRow,
  type UsageKind,
} from "@/lib/utility-usage-parse";

// All numbers here are synthetic and labelled so; none is real usage data.
const TODAY = "2026-10-10";
const PERSONAL = { solarLiveFrom: "2023-03" };
const NO_SOLAR = { solarLiveFrom: null };

function parse(kind: UsageKind, text: string, over: Partial<ParseInput> = {}) {
  return parseUsageText({ kind, text, today: TODAY, site: NO_SOLAR, ...over });
}

function ok(kind: UsageKind, text: string, over: Partial<ParseInput> = {}) {
  const out = parse(kind, text, over);
  if (!out.ok) throw new Error(`expected ok, got: ${out.error}`);
  return out;
}

describe("parseMonthCell: accepted formats (US order)", () => {
  const good: Array<[string, string, number | null]> = [
    ["2024-01", "2024-01", null],
    ["2024/03", "2024-03", null],
    ["2024-3", "2024-03", null],
    ["1/2024", "2024-01", null],
    ["01/2024", "2024-01", null],
    ["12/2023", "2023-12", null],
    ["Jan 2024", "2024-01", null],
    ["january 2024", "2024-01", null],
    ["January 2024", "2024-01", null],
    ["Jan, 2024", "2024-01", null],
    ["Sept 2023", "2023-09", null],
    ["2024-02-29", "2024-02", 29],
    ["2/29/2024", "2024-02", 29],
    ["3/31/2024", "2024-03", 31],
    ["Feb 29, 2024", "2024-02", 29],
    ["Mar 5 2024", "2024-03", 5],
    ["  Oct   2025 ", "2025-10", null],
  ];
  it.each(good)("%s", (raw, period, day) => {
    const r = parseMonthCell(raw);
    expect(r).toEqual({ ok: true, period, day });
  });
});

describe("parseMonthCell: refused with a plain message", () => {
  const bad: Array<[string, RegExp]> = [
    ["Jan-24", /two-digit years/],
    ["1/15/24", /two-digit years/],
    ["1/24", /two-digit years/],
    ["45292", /spreadsheet date number/],
    ["45292.5", /spreadsheet date number/],
    ["15/1/2024", /day first is not supported/],
    ["13/2024", /not a month/],
    ["2024-13", /not a month/],
    ["2024-00", /not a month/],
    ["2023-02-29", /not a real date/],
    ["2/30/2024", /not a real date/],
    ["Feb 30, 2024", /not a real date/],
    ["2024", /only a year/],
    ["", /blank/],
    ["next spring", /not a month I can read/],
    ["Smarch 2024", /not a month I can read/],
    ["2024-01-15T00:00:00Z", /not a month I can read/],
    ["=1+1", /not a month I can read/],
  ];
  it.each(bad)("%j", (raw, re) => {
    const r = parseMonthCell(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  });
});

describe("parseNumberCell", () => {
  const num = (s: string, d = 3, kind?: UsageKind) => parseNumberCell(s, { maxDecimals: d, kind });
  it("reads plain, grouped, dollar, parenthesised and unit-suffixed numbers", () => {
    expect(num("1234.5")).toMatchObject({ kind: "ok" });
    expect((num("1,234.567") as { value: { toFixed: (n: number) => string } }).value.toFixed(3)).toBe("1234.567");
    expect((num("$1,234.56", 2) as { value: { toFixed: (n: number) => string } }).value.toFixed(2)).toBe("1234.56");
    expect((num("(12.30)", 2) as { value: { toFixed: (n: number) => string } }).value.toFixed(2)).toBe("-12.30");
    expect((num("-$5.00", 2) as { value: { toFixed: (n: number) => string } }).value.toFixed(2)).toBe("-5.00");
    expect((num("850 kWh", 3, "electric") as { value: { toFixed: (n: number) => string } }).value.toFixed(3)).toBe("850.000");
    expect((num("112.5 gal", 3, "oil") as { value: { toFixed: (n: number) => string } }).value.toFixed(3)).toBe("112.500");
    expect((num("2 cords", 3, "firewood") as { value: { toFixed: (n: number) => string } }).value.toFixed(3)).toBe("2.000");
    expect((num(".5") as { value: { toFixed: (n: number) => string } }).value.toFixed(1)).toBe("0.5");
  });
  it("treats blank, dash and n/a as absent", () => {
    for (const s of ["", "  ", "-", "n/a", "NA", "N/A"]) expect(num(s)).toEqual({ kind: "absent" });
  });
  it("refuses comma decimals, exponents, hex, NaN, Infinity, odd grouping and extra decimals", () => {
    for (const s of ["1.234,5", "12,5", "1e3", "0x10", "NaN", "Infinity", "-Infinity", "1,23,456", "12,34", "1 000", "1..2", "--5", "5-", "$$5", "abc"]) {
      expect(num(s).kind, s).toBe("error");
    }
    expect(num("1.2345").kind).toBe("error");
    expect(num("1.234").kind).toBe("ok");
    expect(num("1.234", 2).kind).toBe("error");
    expect(num("9999999999").kind).toBe("error");
  });
  it("names the comma-decimal problem", () => {
    const r = num("1.234,5");
    expect(r.kind === "error" && r.error).toMatch(/comma decimal/);
  });
});

describe("parseUsageText: electric", () => {
  it("reads a headed CSV, suggests a mapping and builds keyed rows", () => {
    const out = ok("electric", "Month,kWh,Amount\n2024-01,850,142.18\n2024-02,790,\nFeb 2025,810.5,130\n");
    expect(out.delimiter).toBe(",");
    expect(out.hasHeader).toBe(true);
    expect(out.suggested).toEqual(["month", "quantity", "cost"]);
    expect(out.mapping).toEqual(["month", "quantity", "cost"]);
    expect(out.mappingError).toBeNull();
    expect(out.rows.map((r) => [r.line, r.status, r.key, r.quantity, r.costCents, r.unit, r.occurredOn])).toEqual([
      [2, "new", "electric|2024-01", "850.000", 14218, "kwh", "2024-01-01"],
      [3, "new", "electric|2024-02", "790.000", null, "kwh", "2024-02-01"],
      [4, "new", "electric|2025-02", "810.500", 13000, "kwh", "2025-02-01"],
    ]);
    expect(out.summary).toMatchObject({ rowCount: 3, months: 3, first: "2024-01", last: "2025-02" });
    expect(out.summary.counts.new).toBe(3);
  });

  it("works without a header by position", () => {
    const out = ok("electric", "2024-01,850,100\n2024-02,700,80\n");
    expect(out.hasHeader).toBe(false);
    expect(out.mapping).toEqual(["month", "quantity", "cost"]);
    expect(out.rows).toHaveLength(2);
  });

  it("uses the mapping the owner confirms, not the suggestion", () => {
    const text = "A,B,C\n850,2024-01,note one\n";
    const sug = ok("electric", text);
    expect(sug.mappingError).toMatch(/month/);
    const mapped = ok("electric", text, { mapping: ["quantity", "month", "note"] });
    expect(mapped.rows[0]).toMatchObject({ status: "new", quantity: "850.000", note: "note one" });
    // a column mapped to ignore is discarded
    const ig = ok("electric", text, { mapping: ["quantity", "month", "ignore"] });
    expect(ig.rows[0]!.note).toBeNull();
  });

  it("reports a mapping error and no rows when roles are missing or doubled", () => {
    const text = "Month,kWh\n2024-01,850\n";
    expect(ok("electric", text, { mapping: ["month", "ignore"] }).mappingError).toMatch(/kWh/);
    expect(ok("electric", text, { mapping: ["month", "month"] }).mappingError).toMatch(/month/);
    expect(ok("electric", text, { mapping: ["month", "unit"] }).mappingError).toMatch(/quantity|kWh|unit/);
    const bad = ok("electric", text, { mapping: ["month", "ignore"] });
    expect(bad.rows).toEqual([]);
  });

  it("sniffs tab, semicolon and pipe delimiters", () => {
    for (const [d, name] of [["\t", "\t"], [";", ";"], ["|", "|"]] as const) {
      const out = ok("electric", ["Month", "kWh", "Cost"].join(d) + "\n" + ["2024-01", "850", "100"].join(d) + "\n");
      expect(out.delimiter).toBe(name);
      expect(out.rows[0]).toMatchObject({ status: "new", quantity: "850.000", costCents: 10000 });
    }
  });

  it("breaks a delimiter tie in favour of tab, then comma", () => {
    const out = ok("electric", "a\tb,c\n2024-01\t850,9\n");
    expect(out.delimiter).toBe("\t");
  });

  it("handles quoting: embedded delimiter, doubled quote, embedded newline, CRLF and a BOM", () => {
    const text = '﻿Month,kWh,Note\r\n2024-01,850,"hello, ""world"""\r\n2024-02,700,"two\r\nlines"\r\n';
    const out = ok("electric", text);
    expect(out.rows[0]).toMatchObject({ status: "new", note: 'hello, "world"' });
    expect(out.rows[1]).toMatchObject({ status: "new", note: "two\nlines" });
    expect(out.rows[1]!.line).toBe(3);
  });

  it("accepts a lone CR as a newline", () => {
    const out = ok("electric", "Month,kWh\r2024-01,850\r2024-02,700");
    expect(out.rows).toHaveLength(2);
  });

  it("skips blank lines and keeps 1-based line numbers", () => {
    const out = ok("electric", "Month,kWh\n\n2024-01,850\n\n\n2024-02,x\n");
    expect(out.rows.map((r) => r.line)).toEqual([3, 6]);
    expect(out.rows[1]!.status).toBe("error");
  });

  it("refuses futures and the unfinished current month, and old months", () => {
    const out = ok("electric", "Month,kWh\n2026-11,800\n2026-10,800\n2026-09,800\n2016-09,800\n2016-10,800\n");
    expect(out.rows[0]!.errors.join(" ")).toMatch(/future/);
    expect(out.rows[1]!.errors.join(" ")).toMatch(/not finished/);
    expect(out.rows[2]!.status).toBe("new");
    expect(out.rows[3]!.errors.join(" ")).toMatch(/more than 10 years/);
    expect(out.rows[4]!.status).toBe("new"); // exactly 120 months back
  });

  it("flags months before solar went live without refusing them", () => {
    const out = ok("electric", "Month,kWh\n2023-02,900\n2023-03,700\n", { site: PERSONAL });
    expect(out.rows[0]).toMatchObject({ status: "new" });
    expect(out.rows[0]!.warnings.join(" ")).toMatch(/before solar went live/);
    expect(out.rows[1]!.warnings).toEqual([]);
  });

  it("enforces kWh ranges: negative refused, 0 allowed, above 5,000 warns, above 20,000 refused", () => {
    const out = ok("electric", "Month,kWh\n2024-01,-5\n2024-02,0\n2024-03,5001\n2024-04,20001\n2024-05,20000\n");
    expect(out.rows[0]!.errors.join(" ")).toMatch(/negative kWh is refused.*note/);
    expect(out.rows[1]).toMatchObject({ status: "new", quantity: "0.000" });
    expect(out.rows[2]!.warnings.join(" ")).toMatch(/unusually high/);
    expect(out.rows[3]!.status).toBe("error");
    expect(out.rows[4]!.status).toBe("new");
  });

  it("keeps a credit (negative cost) month and bounds the cost", () => {
    const out = ok("electric", "Month,kWh,Cost\n2024-01,100,(30.25)\n2024-02,100,-5000.01\n2024-03,100,20000.01\n2024-04,100,20000\n");
    expect(out.rows[0]).toMatchObject({ status: "new", costCents: -3025 });
    expect(out.rows[1]!.status).toBe("error");
    expect(out.rows[2]!.status).toBe("error");
    expect(out.rows[3]).toMatchObject({ status: "new", costCents: 2000000 });
  });

  it("warns when the electric price per kWh is above $2", () => {
    const out = ok("electric", "Month,kWh,Cost\n2024-01,10,25\n");
    expect(out.rows[0]!.warnings.join(" ")).toMatch(/\$2\.00 per kWh/);
  });

  it("refuses a 4-decimal quantity, a comma decimal and a blank quantity", () => {
    const out = ok("electric", "Month,kWh\n2024-01,850.1234\n2024-02,\"1.234,5\"\n2024-03,\n");
    expect(out.rows.map((r) => r.status)).toEqual(["error", "error", "error"]);
    expect(out.rows[0]!.errors.join(" ")).toMatch(/more than 3 decimal/);
    expect(out.rows[1]!.errors.join(" ")).toMatch(/comma decimal/);
    expect(out.rows[2]!.errors.join(" ")).toMatch(/blank/);
  });

  it("uses the month containing the midpoint of a billing period", () => {
    const text = "Start,End,kWh\n1/20/2024,2/18/2024,800\n1/5/2024,2/4/2024,800\n";
    const out = ok("electric", text);
    expect(out.suggested).toEqual(["ignore", "ignore", "quantity"]);
    const m = ok("electric", text, { mapping: ["month", "periodEnd", "quantity"] });
    // Jan 20 .. Feb 18: midpoint Feb 3 (day 15 of 30 days) -> February; Jan 5 .. Feb 4: midpoint Jan 20 -> January
    expect(m.rows.map((r) => r.period)).toEqual(["2024-02", "2024-01"]);
  });

  it("refuses an end before the start, a span over 62 days and month-only period ends", () => {
    const m = ok("electric", "Start,End,kWh\n2/18/2024,1/20/2024,800\n1/1/2024,3/5/2024,800\n2024-01,2024-02,800\n", { mapping: ["month", "periodEnd", "quantity"] });
    expect(m.rows[0]!.errors.join(" ")).toMatch(/before the period start/);
    expect(m.rows[1]!.errors.join(" ")).toMatch(/longer than 62 days/);
    expect(m.rows[2]!.errors.join(" ")).toMatch(/full dates/);
  });

  it("suggests aliases case- and punctuation-insensitively", () => {
    expect(suggestMapping(["Billing Period", "Total kWh", "Total Bill", "Solar Credit"], 4, "electric")).toEqual(["month", "quantity", "cost", "note"]);
    expect(suggestMapping(["BILL_MONTH", "kWh Used", "Amount Due"], 3, "electric")).toEqual(["month", "quantity", "cost"]);
    expect(suggestMapping(["Date", "Gallons", "Charges", "Unit"], 4, "oil")).toEqual(["month", "quantity", "cost", "ignore"]);
    expect(suggestMapping(["Date", "Cords", "Total", "UOM"], 4, "firewood")).toEqual(["month", "quantity", "cost", "unit"]);
  });
});

describe("parseUsageText: oil", () => {
  it("keeps the delivery day and makes a key from date + quantity", () => {
    const out = ok("oil", "Date,Gallons,Amount\n2025-10-15,112.5,400.00\n2025-12,100,360\n");
    expect(out.rows[0]).toMatchObject({ status: "new", period: "2025-10", occurredOn: "2025-10-15", key: "oil|2025-10-15|112.500", unit: "gal", costCents: 40000 });
    expect(out.rows[1]).toMatchObject({ status: "new", occurredOn: "2025-12-01", key: "oil|2025-12-01|100.000" });
  });

  it("allows this month up to today and refuses dates after today", () => {
    const out = ok("oil", "Date,Gallons\n2026-10-10,100\n2026-10-11,100\n2026-10,100\n2026-11,100\n");
    expect(out.rows.map((r) => r.status)).toEqual(["new", "error", "new", "error"]);
    expect(out.rows[1]!.errors.join(" ")).toMatch(/future/);
  });

  it("refuses 0 and negative gallons, more than 2,000, and warns above 800", () => {
    const out = ok("oil", "Date,Gallons\n2025-01-05,0\n2025-02-05,-3\n2025-03-05,2001\n2025-04-05,2000\n2025-05-05,801\n");
    expect(out.rows.map((r) => r.status)).toEqual(["error", "error", "error", "new", "new"]);
    expect(out.rows[3]!.warnings.join(" ")).toMatch(/800/);
  });

  it("refuses a cost that does not match the gallons (price per gallon outside $0.50 to $12.00)", () => {
    const out = ok("oil", "Date,Gallons,Amount\n2025-01-05,100,49\n2025-02-05,100,1201\n2025-03-05,100,50\n2025-04-05,100,1200\n");
    expect(out.rows.map((r) => r.status)).toEqual(["error", "error", "new", "new"]);
    expect(out.rows[0]!.errors.join(" ")).toMatch(/same delivery/);
  });

  it("allows two deliveries in one month and ignores an identical repeat", () => {
    const out = ok("oil", "Date,Gallons\n2025-01-05,100\n2025-01-20,90\n2025-01-05,100\n");
    expect(out.rows.map((r) => r.status)).toEqual(["new", "new", "duplicate_in_file"]);
    expect(out.rows[2]!.warnings.join(" ")).toMatch(/same as line 2/);
  });

  it("makes a repeat with different values an error", () => {
    const out = ok("oil", "Date,Gallons,Amount\n2025-01-05,100,350\n2025-01-05,100,360\n");
    expect(out.rows.map((r) => r.status)).toEqual(["new", "error"]);
  });

  it("handles leap-day and month-end dates", () => {
    const out = ok("oil", "Date,Gallons\n2/29/2024,100\n1/31/2025,100\n2/29/2025,100\n");
    expect(out.rows.map((r) => [r.status, r.occurredOn])).toEqual([["new", "2024-02-29"], ["new", "2025-01-31"], ["error", null]]);
  });

  it("refuses a period-end column and a unit column (electric / firewood only)", () => {
    expect(ok("oil", "A,B,C\n2025-01-05,100,x\n", { mapping: ["month", "quantity", "unit"] }).mappingError).toMatch(/unit/);
    expect(ok("oil", "A,B,C\n2025-01-05,100,x\n", { mapping: ["month", "quantity", "periodEnd"] }).mappingError).toMatch(/period-end/);
  });
});

describe("parseUsageText: firewood", () => {
  it("reads cords, face cords and a default unit", () => {
    const out = ok("firewood", "Date,Cords,Amount,Unit\n2025-10-01,2,500,cord\n2025-11-01,1,300,\n2025-12-01,3,400,Cords\n");
    expect(out.suggested).toEqual(["month", "quantity", "cost", "unit"]);
    expect(out.rows.map((r) => [r.status, r.unit])).toEqual([["new", "cord"], ["new", "cord"], ["new", "cord"]]);
    const face = ok("firewood", "Date,Qty\n2025-10-01,3\n", { mapping: ["month", "quantity"], defaultUnit: "face_cord" });
    expect(face.rows[0]).toMatchObject({ status: "new", unit: "face_cord" });
  });

  it("bounds cords (0.25 to 20) and face cords (0.5 to 60)", () => {
    const c = ok("firewood", "Date,Qty\n2025-01-01,0.2\n2025-02-01,0.25\n2025-03-01,20\n2025-04-01,20.5\n");
    expect(c.rows.map((r) => r.status)).toEqual(["error", "new", "new", "error"]);
    const f = ok("firewood", "Date,Qty\n2025-01-01,0.4\n2025-02-01,0.5\n2025-03-01,60\n2025-04-01,61\n", { defaultUnit: "face_cord" });
    expect(f.rows.map((r) => r.status)).toEqual(["error", "new", "new", "error"]);
  });

  it("refuses an unknown unit word and a mix of units in one upload", () => {
    const u = ok("firewood", "Date,Qty,Unit\n2025-01-01,2,ton\n");
    expect(u.rows[0]!.errors.join(" ")).toMatch(/not cord or face cord/);
    const mix = ok("firewood", "Date,Qty,Unit\n2025-01-01,2,cord\n2025-02-01,2,cord\n2025-03-01,4,face cord\n");
    expect(mix.rows.map((r) => r.status)).toEqual(["new", "new", "error"]);
    expect(mix.rows[2]!.errors.join(" ")).toMatch(/mixes cords and face cords/);
    const tie = ok("firewood", "Date,Qty,Unit\n2025-01-01,4,face cord\n2025-02-01,2,cord\n");
    expect(tie.rows.map((r) => r.status)).toEqual(["new", "error"]);
  });
});

describe("parseUsageText: notes and text hygiene", () => {
  it("refuses a note that starts like a formula", () => {
    for (const note of ["=SUM(A1)", "+1", "@cmd", "\tcmd", " =1+1"]) {
      const out = ok("electric", `Month,kWh,Note\n2024-01,800,"${note}"\n`);
      expect(out.rows[0]!.status, JSON.stringify(note)).toBe("error");
      expect(out.rows[0]!.errors.join(" ")).toMatch(/formula/);
    }
    // a minus sign is fine in a note
    expect(ok("electric", "Month,kWh,Note\n2024-01,800,-60 kWh sent back\n").rows[0]).toMatchObject({ status: "new", note: "-60 kWh sent back" });
  });

  it("refuses an SSN-like or account-number-like note without echoing it", () => {
    const out = ok("electric", "Month,kWh,Note\n2024-01,800,123-45-6789\n2024-02,800,acct 12345678901234\n");
    for (const r of out.rows) {
      expect(r.status).toBe("error");
      expect(r.errors.join(" ")).not.toMatch(/6789|1234567/);
    }
  });

  it("refuses an over-long note and strips nothing it did not mean to", () => {
    const out = ok("electric", `Month,kWh,Note\n2024-01,800,${"x".repeat(121)}\n2024-02,800,${"y".repeat(120)}\n`);
    expect(out.rows.map((r) => r.status)).toEqual(["error", "new"]);
  });

  it("limits every echoed cell to 40 characters", () => {
    const out = ok("electric", `Month,kWh\n${"q".repeat(150)},800\n`);
    const msg = out.rows[0]!.errors.join(" ");
    expect(msg).toMatch(/\.\.\./);
    expect(msg.length).toBeLessThan(260);
  });
});

describe("parseUsageText: wide recap tables (years down, months across)", () => {
  const recap = [
    "Year,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec,Total",
    "2024,850,790,640,520,480,450,470,500,510,560,680,800,7250",
    "2025,860,780,,530,470,455,480,505,515,565,690,810,",
    "Average,855,785,640,525,475,452,475,502,512,562,685,805,",
  ].join("\n");

  it("expands to one row per month, skips blanks and a total row, and keeps the source line", () => {
    const out = ok("electric", recap);
    expect(out.wide).toBe(true);
    expect(out.mapping).toEqual(["month", "quantity"]);
    expect(out.rows).toHaveLength(12 + 11);
    expect(out.rows.filter((r) => r.status === "error")).toEqual([]);
    expect(out.rows[0]).toMatchObject({ key: "electric|2024-01", quantity: "850.000", line: 2 });
    expect(out.rows[12]).toMatchObject({ key: "electric|2025-01", line: 3 });
    expect(out.rows.some((r) => r.key === "electric|2025-03")).toBe(false); // the blank cell
    expect(out.summary).toMatchObject({ months: 23, first: "2024-01", last: "2025-12" });
  });

  it("accepts full month names, a dot after an abbreviation and a tab delimiter", () => {
    const text = ["Year", "January", "Feb.", "March", "April", "May", "June"].join("\t") + "\n" + ["2024", "850", "790", "640", "520", "480", "450"].join("\t");
    const out = ok("electric", text);
    expect(out.wide).toBe(true);
    expect(out.rows).toHaveLength(6);
  });

  it("still applies every row check: the unfinished month, future months and a negative kWh are errors", () => {
    const text = "Year,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec\n2026,1,2,3,4,5,6,7,8,9,10,11,-12\n";
    const out = ok("electric", text);
    expect(out.rows).toHaveLength(12);
    expect(out.rows.filter((r) => r.status === "new")).toHaveLength(9); // Jan to Sep 2026
    expect(out.rows.filter((r) => r.status === "error")).toHaveLength(3); // Oct unfinished, Nov future, Dec future (and negative)
  });

  it("a first cell that is neither a year nor a total line becomes an error row", () => {
    const out = ok("electric", "Year,Jan,Feb,Mar,Apr,May,Jun\nlast year,850,790,640,520,480,450\n2024,1,2,3,4,5,6\n");
    expect(out.rows[0]!.status).toBe("error");
    expect(out.rows.filter((r) => r.status === "new")).toHaveLength(6);
  });

  it("needs six different month names; duplicate month headings or fewer are not a recap", () => {
    expect(ok("electric", "Year,Jan,Feb,Mar,Apr,May\n2024,1,2,3,4,5\n").wide).toBe(false);
    expect(ok("electric", "Year,Jan,Jan,Mar,Apr,May,Jun,Jul\n2024,1,2,3,4,5,6,7\n").wide).toBe(false);
  });

  it("is only for electric: an oil table is never read this way", () => {
    expect(ok("oil", recap).wide).toBe(false);
  });

  it("a second long-format paste with amounts fills the cost of the months already saved", () => {
    const wideRows = ok("electric", recap).rows;
    const live = wideRows.filter((r) => r.key).map((r, i) => ({ id: `L${i}`, key: r.key!, occurredOn: r.occurredOn!, quantity: r.quantity!, costCents: null as number | null }));
    const second = ok("electric", "Month,kWh,Cost\n2024-01,850,140.00\n2024-02,790,131.50\n").rows;
    const classified = classifyAgainstLive("electric", second, live);
    expect(classified.map((r) => r.status)).toEqual(["fills_cost", "fills_cost"]);
  });
});

describe("parseUsageText: whole-input refusals", () => {
  const refused = (text: string, re: RegExp) => {
    const out = parse("electric", text);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(re);
  };
  it("refuses oversize text (200,001 characters)", () => {
    refused("a".repeat(MAX_TEXT_CHARS + 1), /too much text/);
    expect(parse("electric", "2024-01,800\n" + " ".repeat(10)).ok).toBe(true);
  });
  it("refuses more than 600 rows and accepts exactly 600", () => {
    const line = (i: number) => `2020-${String((i % 12) + 1).padStart(2, "0")},${100 + (i % 7)}`;
    const many = (n: number) => Array.from({ length: n }, (_, i) => line(i)).join("\n");
    refused("Month,kWh\n" + many(MAX_ROWS + 1), /601 rows.*limit is 600/);
    const out = parse("electric", "Month,kWh\n" + many(MAX_ROWS));
    expect(out.ok && out.rows.length).toBe(MAX_ROWS);
  });
  it("refuses more than 20 columns and accepts exactly 20", () => {
    refused(Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `c${i}`).join(",") + "\n", /21 columns/);
    expect(parse("electric", Array.from({ length: MAX_COLUMNS }, (_, i) => `c${i}`).join(",") + "\n2024-01,800" + ",".repeat(18) + "\n").ok).toBe(true);
  });
  it("refuses a cell over 200 characters and accepts exactly 200", () => {
    refused(`Month,kWh,Note\n2024-01,800,${"n".repeat(MAX_CELL + 1)}\n`, /longer than 200 characters/);
    expect(parse("electric", `Month,kWh,Note\n2024-01,800,${"n".repeat(MAX_CELL)}\n`).ok).toBe(true);
  });
  it("refuses an unterminated quote and names the line", () => {
    refused('Month,kWh\n2024-01,800\n2024-02,"700\n2024-03,600\n', /line 3.*never closed/);
  });
  it("refuses control characters (NUL and others) and names the line", () => {
    refused("Month,kWh\n2024-01,8\u00000\n", /Line 2 contains a control character/);
    refused("Month,kWh\n2024-01,800\u0007\n", /control character/);
    refused("Month,kWh\n2024-01,800 \n", /control character/);
  });
  it("refuses empty input and a header with no rows", () => {
    refused("", /nothing to read/);
    refused("   \n\n  ", /nothing to read/);
    refused("Month,kWh\n", /no data rows/);
  });
  it("refuses an unusable today", () => {
    expect(parseUsageText({ kind: "electric", text: "2024-01,8", today: "2026-13-40", site: NO_SOLAR }).ok).toBe(false);
  });
});

describe("classifyAgainstLive and planWrites", () => {
  const rowsOf = (kind: UsageKind, text: string, over: Partial<ParseInput> = {}) => ok(kind, text, over).rows;
  const live = (kind: UsageKind, period: string, occurredOn: string, quantity: string, costCents: number | null, id = "L1") => ({
    id,
    key: rowKeyOf(kind, period, occurredOn, quantity),
    occurredOn,
    quantity,
    costCents,
  });

  it("re-uploading the same electric rows is unchanged", () => {
    const rows = rowsOf("electric", "Month,kWh,Cost\n2024-01,850,100\n2024-02,700,80\n");
    const out = classifyAgainstLive("electric", rows, [live("electric", "2024-01", "2024-01-01", "850.000", 10000, "a"), live("electric", "2024-02", "2024-02-01", "700.000", 8000, "b")]);
    expect(out.map((r) => r.status)).toEqual(["unchanged", "unchanged"]);
    const plan = planWrites(out, { replaceKeys: [], skipBadRows: false });
    expect(plan.ok && plan.plan.insert).toEqual([]);
  });

  it("a different kWh or cost for a saved electric month is a conflict that needs the replace tick", () => {
    const rows = rowsOf("electric", "Month,kWh,Cost\n2024-01,860,100\n2024-02,700,90\n2024-03,500,\n");
    const out = classifyAgainstLive("electric", rows, [
      live("electric", "2024-01", "2024-01-01", "850.000", 10000, "a"),
      live("electric", "2024-02", "2024-02-01", "700.000", 8000, "b"),
      live("electric", "2024-03", "2024-03-01", "500.000", 7000, "c"),
    ]);
    expect(out.map((r) => r.status)).toEqual(["conflict", "conflict", "unchanged"]);
    expect(out[0]!.matchedId).toBe("a");
    const none = planWrites(out, { replaceKeys: [], skipBadRows: false });
    expect(none.ok && none.plan).toMatchObject({ insert: [], archiveIds: [], skipped: 3 });
    const ticked = planWrites(out, { replaceKeys: ["electric|2024-01"], skipBadRows: false });
    expect(ticked.ok && ticked.plan.insert.map((r) => r.key)).toEqual(["electric|2024-01"]);
    expect(ticked.ok && ticked.plan.archiveIds).toEqual(["a"]);
  });

  it("adding a cost to a saved row with the same kWh fills the cost without a tick", () => {
    const rows = rowsOf("electric", "Month,kWh,Cost\n2024-01,850,100\n");
    const out = classifyAgainstLive("electric", rows, [live("electric", "2024-01", "2024-01-01", "850.000", null, "a")]);
    expect(out[0]!.status).toBe("fills_cost");
    const plan = planWrites(out, { replaceKeys: [], skipBadRows: false });
    expect(plan.ok && plan.plan).toMatchObject({ archiveIds: ["a"], replaced: 1 });
    expect(plan.ok && plan.plan.insert).toHaveLength(1);
  });

  it("an oil delivery on a saved date with another quantity is new plus a warning", () => {
    const rows = rowsOf("oil", "Date,Gallons\n2025-01-05,110\n");
    const out = classifyAgainstLive("oil", rows, [live("oil", "2025-01", "2025-01-05", "100.000", null)]);
    expect(out[0]!.status).toBe("new");
    expect(out[0]!.warnings.join(" ")).toMatch(/another delivery/);
  });

  it("the same oil delivery with a different cost is a conflict; a filled cost is allowed", () => {
    const rows = rowsOf("oil", "Date,Gallons,Amount\n2025-01-05,100,350\n2025-02-05,100,360\n");
    const out = classifyAgainstLive("oil", rows, [live("oil", "2025-01", "2025-01-05", "100.000", 36000, "a"), live("oil", "2025-02", "2025-02-05", "100.000", null, "b")]);
    expect(out.map((r) => r.status)).toEqual(["conflict", "fills_cost"]);
  });

  it("refuses to save when a row has an error, unless bad rows are skipped", () => {
    const rows = rowsOf("electric", "Month,kWh\n2024-01,850\n2024-02,oops\n");
    const strict = planWrites(rows, { replaceKeys: [], skipBadRows: false });
    expect(strict.ok).toBe(false);
    const lenient = planWrites(rows, { replaceKeys: [], skipBadRows: true });
    expect(lenient.ok && lenient.plan.insert.map((r) => r.key)).toEqual(["electric|2024-01"]);
    expect(lenient.ok && lenient.plan.skipped).toBe(1);
  });

  it("never writes duplicate_in_file rows", () => {
    const rows = rowsOf("oil", "Date,Gallons\n2025-01-05,100\n2025-01-05,100\n");
    const plan = planWrites(rows, { replaceKeys: [], skipBadRows: false });
    expect(plan.ok && plan.plan.insert).toHaveLength(1);
  });

  it("live keys carry the entity", () => {
    expect(liveKeyOf("E1", "electric|2024-01")).toBe("E1|electric|2024-01");
    expect(rowKeyOf("oil", "2025-01", "2025-01-05", "100.000")).toBe("oil|2025-01-05|100.000");
  });
});

// ── Seeded fuzz ─────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  "2024-01", "1/2024", "Jan 2024", "2024-02-29", "2/30/2024", "15/1/2024", "Jan-24", "45292", "", " ", "-", "n/a", "NaN", "Infinity", "1e3", "0x10",
  "850", "850.5", "-5", "(12.30)", "$1,234.56", "1.234,5", "1,234", "20001", "0", "0.25", "2000", "12.3456", "kWh", "gallons", "Month", "Date", "Amount", "Note",
  "=1+1", "+cmd", "@x", "123-45-6789", '"', '""', '"a,b"', "é", "​", "\u0000", "\t", ",", ";", "|", "\n", "\r\n", "\r", "2099-01", "2026-10", "2026-09",
];

function randomText(rand: () => number): string {
  const kind = Math.floor(rand() * 4);
  if (kind === 0) {
    // byte soup
    const n = Math.floor(rand() * 300);
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(Math.floor(rand() * 0x2fff));
    return s;
  }
  const n = 1 + Math.floor(rand() * (kind === 3 ? 120 : 40));
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(TOKENS[Math.floor(rand() * TOKENS.length)]!);
  return parts.join(kind === 1 ? "," : kind === 2 ? "" : rand() < 0.5 ? "\n" : ",");
}

function checkRow(kind: UsageKind, r: ParsedRow) {
  if (r.status === "error") {
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.key).toBeNull();
    return;
  }
  expect(r.errors).toEqual([]);
  expect(r.key).not.toBeNull();
  expect(r.period).toMatch(/^\d{4}-\d{2}$/);
  expect(r.occurredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(r.period! < "2026-11").toBe(true);
  const q = Number(r.quantity);
  expect(Number.isFinite(q)).toBe(true);
  expect(r.quantity).toMatch(/^-?\d+\.\d{3}$/);
  if (kind === "electric") {
    expect(q).toBeGreaterThanOrEqual(0);
    expect(q).toBeLessThanOrEqual(20000);
    expect(r.period! < "2026-10").toBe(true);
    expect(r.unit).toBe("kwh");
    if (r.costCents !== null) {
      expect(r.costCents).toBeGreaterThanOrEqual(-500000);
      expect(r.costCents).toBeLessThanOrEqual(2000000);
    }
  } else if (kind === "oil") {
    expect(q).toBeGreaterThan(0);
    expect(q).toBeLessThanOrEqual(2000);
    expect(r.occurredOn! <= TODAY).toBe(true);
    expect(r.unit).toBe("gal");
    if (r.costCents !== null) {
      expect(r.costCents).toBeGreaterThanOrEqual(0);
      expect(r.costCents).toBeLessThanOrEqual(5000000);
      const perGal = r.costCents / 100 / q;
      expect(perGal).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(perGal).toBeLessThanOrEqual(12 + 1e-9);
    }
  } else {
    if (r.unit === "cord") {
      expect(q).toBeGreaterThanOrEqual(0.25);
      expect(q).toBeLessThanOrEqual(20);
    } else {
      expect(r.unit).toBe("face_cord");
      expect(q).toBeGreaterThanOrEqual(0.5);
      expect(q).toBeLessThanOrEqual(60);
    }
    expect(r.occurredOn! <= TODAY).toBe(true);
  }
  expect(r.note === null || (r.note.length <= 120 && !/^[=+@\t\r]/.test(r.note))).toBe(true);
}

describe("fuzz (seeded): never throws, never returns a row that breaks the ranges", () => {
  it("2,000 random inputs across the three kinds and random mappings", () => {
    const rand = mulberry32(20261013);
    const kinds: UsageKind[] = ["electric", "oil", "firewood"];
    let okCount = 0;
    let rowCount = 0;
    for (let i = 0; i < 2000; i++) {
      const kind = kinds[i % 3]!;
      const text = randomText(rand);
      const roles: ColumnRole[] = ["month", "periodEnd", "quantity", "cost", "unit", "note", "ignore"];
      const mapping = rand() < 0.4 ? Array.from({ length: 1 + Math.floor(rand() * 5) }, () => roles[Math.floor(rand() * roles.length)]!) : undefined;
      let o: ParseOutcome;
      try {
        o = parseUsageText({ kind, text, today: TODAY, site: i % 2 === 0 ? PERSONAL : NO_SOLAR, mapping });
      } catch (err) {
        throw new Error(`parser threw on fuzz input ${i}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!o.ok) {
        expect(o.error.length).toBeGreaterThan(0);
        continue;
      }
      okCount += 1;
      rowCount += o.rows.length;
      for (const r of o.rows) checkRow(kind, r);
      if (o.mappingError) expect(o.rows).toEqual([]);
    }
    // the fuzz must actually exercise the row logic, not only the early refusals
    expect(okCount).toBeGreaterThan(100);
    expect(rowCount).toBeGreaterThan(100);
  });

  it("well-formed random tables are all accepted with in-range rows", () => {
    const rand = mulberry32(77);
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(rand() * 30);
      const lines = ["Month,kWh,Cost"];
      for (let j = 0; j < n; j++) {
        const y = 2018 + Math.floor(rand() * 8);
        const m = 1 + Math.floor(rand() * 12);
        lines.push(`${y}-${String(m).padStart(2, "0")},${(rand() * 3000).toFixed(1)},${(rand() * 400).toFixed(2)}`);
      }
      const out = ok("electric", lines.join("\n"));
      for (const r of out.rows) checkRow("electric", r);
      expect(out.rows.filter((r) => r.status === "error").length).toBeLessThan(out.rows.length + 1);
    }
  });

  it("random wide recap tables expand to rows that all respect the ranges", () => {
    const rand = mulberry32(4242);
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let wideCount = 0;
    for (let i = 0; i < 300; i++) {
      const cols = 6 + Math.floor(rand() * 7);
      const head = ["Year", ...names.slice(0, cols)];
      const rowsText = [head.join(",")];
      const nYears = 1 + Math.floor(rand() * 6);
      for (let y = 0; y < nYears; y++) {
        const cells = names.slice(0, cols).map(() => (rand() < 0.15 ? "" : rand() < 0.05 ? "oops" : (rand() * 30000 - 2000).toFixed(rand() < 0.2 ? 4 : 1)));
        rowsText.push([String(2015 + Math.floor(rand() * 13)), ...cells].join(","));
      }
      const out = ok("electric", rowsText.join("\n"));
      expect(out.wide).toBe(true);
      wideCount += 1;
      for (const r of out.rows) checkRow("electric", r);
    }
    expect(wideCount).toBe(300);
  });
});
