import { describe, it, expect } from "vitest";
import {
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  clampColumnWidth,
  parseStoredWidths,
  sameWidths,
  widthAfterDrag,
} from "@/lib/resizable-columns";

const DEFAULTS = [120, 200, 90];

describe("clampColumnWidth", () => {
  it("clamps to the min and max", () => {
    expect(clampColumnWidth(10)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(5000)).toBe(MAX_COLUMN_WIDTH);
    expect(clampColumnWidth(150)).toBe(150);
  });
  it("rounds to whole pixels and rejects non-finite input", () => {
    expect(clampColumnWidth(150.6)).toBe(151);
    expect(clampColumnWidth(Number.NaN)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(Number.POSITIVE_INFINITY)).toBe(MIN_COLUMN_WIDTH);
  });
});

describe("widthAfterDrag", () => {
  it("adds the drag delta and clamps", () => {
    expect(widthAfterDrag(100, 40)).toBe(140);
    expect(widthAfterDrag(100, -30)).toBe(70);
    expect(widthAfterDrag(100, -500)).toBe(MIN_COLUMN_WIDTH);
    expect(widthAfterDrag(700, 500)).toBe(MAX_COLUMN_WIDTH);
  });
});

describe("parseStoredWidths", () => {
  it("returns defaults for missing, invalid or mismatched data", () => {
    expect(parseStoredWidths(null, DEFAULTS)).toEqual(DEFAULTS);
    expect(parseStoredWidths("not json", DEFAULTS)).toEqual(DEFAULTS);
    expect(parseStoredWidths("{}", DEFAULTS)).toEqual(DEFAULTS);
    expect(parseStoredWidths("[100,200]", DEFAULTS)).toEqual(DEFAULTS);
    expect(parseStoredWidths('[100,"x",90]', DEFAULTS)).toEqual(DEFAULTS);
    expect(parseStoredWidths("[100,null,90]", DEFAULTS)).toEqual(DEFAULTS);
  });
  it("uses saved widths when they match the column count", () => {
    expect(parseStoredWidths("[130,240,100]", DEFAULTS)).toEqual([130, 240, 100]);
  });
  it("clamps out-of-range saved widths", () => {
    expect(parseStoredWidths("[1,240,99999]", DEFAULTS)).toEqual([MIN_COLUMN_WIDTH, 240, MAX_COLUMN_WIDTH]);
  });
  it("does not mutate the defaults array", () => {
    const copy = [...DEFAULTS];
    const out = parseStoredWidths(null, DEFAULTS);
    out[0] = 999;
    expect(DEFAULTS).toEqual(copy);
  });
});

describe("sameWidths", () => {
  it("compares element-wise", () => {
    expect(sameWidths([1, 2], [1, 2])).toBe(true);
    expect(sameWidths([1, 2], [1, 3])).toBe(false);
    expect(sameWidths([1, 2], [1, 2, 3])).toBe(false);
  });
});
