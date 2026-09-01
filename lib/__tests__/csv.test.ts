import { describe, it, expect } from "vitest";
import { parseCsvCells, splitCsvLines, parseMoney, parseMdyDate } from "@/lib/csv";

describe("parseCsvCells", () => {
  it("parses plain rows", () => {
    expect(parseCsvCells("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("keeps quoted commas inside a field", () => {
    expect(parseCsvCells('Reservation,HM1,"$1,200.00",USD')).toEqual([
      "Reservation",
      "HM1",
      "$1,200.00",
      "USD",
    ]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsvCells('"He said ""hi""",x')).toEqual(['He said "hi"', "x"]);
  });

  it("handles a fully quoted field with commas and empty cells", () => {
    expect(parseCsvCells('"a,b",,c')).toEqual(["a,b", "", "c"]);
  });

  it("matches the real Airbnb earnings row shape (10 columns)", () => {
    const cells = parseCsvCells(
      'Reservation,HMABC123,09/10/2026,09/15/2026,09/16/2026,5,John Smith,Arbor Retreat,"$1,200.00",USD'
    );
    expect(cells).toHaveLength(10);
    expect(cells[8]).toBe("$1,200.00");
    expect(cells[9]).toBe("USD");
  });
});

describe("splitCsvLines", () => {
  it("handles CRLF and stray blank lines", () => {
    const text = "a,b\r\nc,d\n\r\ne,f\n";
    expect(splitCsvLines(text)).toEqual(["a,b", "c,d", "e,f"]);
  });
});

describe("parseMoney", () => {
  it("parses dollars, commas, plain numbers", () => {
    expect(parseMoney("$1,200.00")).toBe(1200);
    expect(parseMoney("450.50")).toBe(450.5);
    expect(parseMoney(" 1,000 ")).toBe(1000);
  });
  it("returns NaN for garbage", () => {
    expect(parseMoney("—")).toBeNaN();
    expect(parseMoney("")).toBeNaN();
  });
});

describe("parseMdyDate", () => {
  it("parses valid dates as UTC", () => {
    expect(parseMdyDate("09/16/2026")?.toISOString()).toBe("2026-09-16T00:00:00.000Z");
    expect(parseMdyDate("1/5/2027")?.toISOString()).toBe("2027-01-05T00:00:00.000Z");
  });
  it("returns null for invalid input", () => {
    expect(parseMdyDate("5")).toBeNull();
    expect(parseMdyDate("")).toBeNull();
    expect(parseMdyDate("13/45/2026")).toBeNull();
  });
});