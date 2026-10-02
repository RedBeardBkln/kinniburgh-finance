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

import {
  IMAGE_ZOOM_MAX,
  IMAGE_ZOOM_MIN,
  SPLIT_DEFAULT_PERCENT,
  SPLIT_MAX_PERCENT,
  SPLIT_MIN_PERCENT,
  clampSplitPercent,
  parseStoredSplit,
  splitPercentFromPointer,
  stepImageZoom,
} from "@/lib/resizable-columns";

describe("split pane", () => {
  it("clamps the split to its limits and falls back on junk", () => {
    expect(clampSplitPercent(5)).toBe(SPLIT_MIN_PERCENT);
    expect(clampSplitPercent(99)).toBe(SPLIT_MAX_PERCENT);
    expect(clampSplitPercent(60)).toBe(60);
    expect(clampSplitPercent(Number.NaN)).toBe(SPLIT_DEFAULT_PERCENT);
  });
  it("parses a stored split, defaulting when absent or invalid", () => {
    expect(parseStoredSplit(null)).toBe(SPLIT_DEFAULT_PERCENT);
    expect(parseStoredSplit("")).toBe(SPLIT_DEFAULT_PERCENT);
    expect(parseStoredSplit("abc")).toBe(SPLIT_DEFAULT_PERCENT);
    expect(parseStoredSplit("62.5")).toBe(62.5);
    expect(parseStoredSplit("5")).toBe(SPLIT_MIN_PERCENT);
  });
  it("converts a pointer position into a left-pane percentage", () => {
    expect(splitPercentFromPointer(600, 100, 1000)).toBe(50);
    expect(splitPercentFromPointer(0, 100, 1000)).toBe(SPLIT_MIN_PERCENT);
    expect(splitPercentFromPointer(5000, 100, 1000)).toBe(SPLIT_MAX_PERCENT);
    expect(splitPercentFromPointer(600, 100, 0)).toBe(SPLIT_DEFAULT_PERCENT);
  });
});

describe("image zoom", () => {
  it("steps within the limits", () => {
    expect(stepImageZoom(100, 1)).toBe(125);
    expect(stepImageZoom(100, -1)).toBe(IMAGE_ZOOM_MIN);
    expect(stepImageZoom(IMAGE_ZOOM_MAX, 1)).toBe(IMAGE_ZOOM_MAX);
    expect(stepImageZoom(200, -1)).toBe(175);
  });
});
