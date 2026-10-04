import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  NEGATIVE_STYLE,
  canonicalJson,
  fingerprintOf,
  formatDollars,
  formatNewYorkDate,
  formatNewYorkDateTime,
  shortFingerprint,
  splitName,
} from "@/lib/tax2025/pdf/format";
import { isWinAnsiCodePoint, sanitizeWinAnsi } from "@/lib/tax2025/pdf/winansi";

describe("formatDollars", () => {
  it("formats whole dollars with thousands commas", () => {
    expect(formatDollars(0)).toBe("0");
    expect(formatDollars(7)).toBe("7");
    expect(formatDollars(999)).toBe("999");
    expect(formatDollars(1000)).toBe("1,000");
    expect(formatDollars(1234567)).toBe("1,234,567");
    expect(formatDollars(21000000)).toBe("21,000,000");
  });

  it("pins the negative style (leading minus) and never prints negative zero", () => {
    expect(NEGATIVE_STYLE).toBe("leading_minus");
    expect(formatDollars(-1500)).toBe("-1,500");
    expect(formatDollars(-5)).toBe("-5");
    expect(formatDollars(-0)).toBe("0");
  });

  it("refuses non-integer money (no floats)", () => {
    expect(() => formatDollars(12.5)).toThrow(RangeError);
    expect(() => formatDollars(Number.NaN)).toThrow(RangeError);
    expect(() => formatDollars(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => formatDollars(0.1 + 0.2)).toThrow(RangeError);
  });
});

describe("fingerprint", () => {
  it("canonical JSON is key-order independent and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] }, u: undefined })).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
    expect(fingerprintOf({ a: 1, b: 2 })).toBe(fingerprintOf({ b: 2, a: 1 }));
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
  });

  it("is a 64-hex SHA-256; the short form is the first 12", () => {
    const fp = fingerprintOf({ x: "y" });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(shortFingerprint(fp)).toBe(fp.slice(0, 12));
    expect(shortFingerprint(fp)).toHaveLength(12);
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(RangeError);
  });
});

describe("America/New_York display", () => {
  it("converts a UTC instant to the New York calendar date", () => {
    expect(formatNewYorkDate("2026-10-04T02:30:00.000Z")).toBe("2026-10-03");
    expect(formatNewYorkDate("2026-01-01T03:00:00.000Z")).toBe("2025-12-31");
    expect(formatNewYorkDate("2026-07-04T12:00:00.000Z")).toBe("2026-07-04");
  });

  it("formats date and time with the zone abbreviation", () => {
    expect(formatNewYorkDateTime("2026-10-04T02:30:00.000Z")).toBe("2026-10-03 22:30 EDT");
    expect(formatNewYorkDateTime("2026-01-15T17:05:00.000Z")).toBe("2026-01-15 12:05 EST");
  });
});

describe("splitName", () => {
  it("takes the last word as the last name", () => {
    expect(splitName("Alex Example")).toEqual({ first: "Alex", last: "Example" });
    expect(splitName("  Sam  Q   Example ")).toEqual({ first: "Sam Q", last: "Example" });
    expect(splitName("Cher")).toEqual({ first: "Cher", last: "" });
  });
});

describe("sanitizeWinAnsi", () => {
  it("maps typographic characters to ASCII", () => {
    expect(sanitizeWinAnsi("“Joe”’s – café…")).toBe('"Joe"\'s - café...');
    expect(sanitizeWinAnsi("a b​c")).toBe("a bc");
  });

  it("replaces control characters and newlines with spaces", () => {
    expect(sanitizeWinAnsi("a\nb\tc\u0000d")).toBe("a b c d");
  });

  it("strips accents WinAnsi cannot hold and replaces the unencodable with ?", () => {
    expect(sanitizeWinAnsi("ā")).toBe("a"); // a with macron has a decomposition
    expect(sanitizeWinAnsi("ł")).toBe("?"); // l with stroke: no decomposition
    expect(sanitizeWinAnsi("😀")).toBe("?"); // one ? per emoji, not per surrogate
    expect(sanitizeWinAnsi("中文")).toBe("??");
  });

  it("keeps Latin-1 letters and the euro sign", () => {
    expect(sanitizeWinAnsi("Muñoz éü €5")).toBe("Muñoz éü €5");
    expect(isWinAnsiCodePoint(0x20ac)).toBe(true);
    expect(isWinAnsiCodePoint(0x4e2d)).toBe(false);
  });

  it("output always encodes in Helvetica (and the raw input would throw)", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const nasty = "José “Joe” łódź 😀 中 – • ™ \u0000  ";
    expect(() => font.encodeText(nasty)).toThrow();
    expect(() => font.encodeText(sanitizeWinAnsi(nasty))).not.toThrow();
  });
});
