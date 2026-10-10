// carry-forward-seasonal-energy, step 2: the heating-oil price history (lib/seasonal-energy-prices.ts). Pure.
import { describe, expect, it } from "vitest";
import {
  activeOilPrices,
  appendOilPrice,
  isIsoDate,
  markOilPriceRemoved,
  normalizePrice,
  OIL_NOTE_MAX,
  OIL_PRICE_CAP,
  OIL_PRICE_MAX,
  oilPriceKey,
  parseOilPrices,
  parseReplaceDraws,
  priceOn,
  serializeOilPrices,
  validateOilPriceInput,
  type OilPriceEntry,
} from "@/lib/seasonal-energy-prices";

const TODAY = new Date("2026-10-10T00:00:00Z");
const entry = (id: string, effectiveOn: string, pricePerGal: string, over: Partial<OilPriceEntry> = {}): OilPriceEntry => ({ id, effectiveOn, pricePerGal, ...over });

describe("normalizePrice", () => {
  it("accepts 0 to 4 decimals and stores 2 to 4", () => {
    expect(normalizePrice("3")).toEqual({ ok: true, value: "3.00" });
    expect(normalizePrice("3.5")).toEqual({ ok: true, value: "3.50" });
    expect(normalizePrice("3.499")).toEqual({ ok: true, value: "3.499" });
    expect(normalizePrice("3.4990")).toEqual({ ok: true, value: "3.4990" });
    expect(normalizePrice(" $4.25 ")).toEqual({ ok: true, value: "4.25" });
    expect(normalizePrice(3.75)).toEqual({ ok: true, value: "3.75" });
  });
  it("rejects zero, negatives, 5 decimals, text, empty, exponents and anything above the bound", () => {
    for (const bad of ["0", "0.00", "-1", "3.49901", "abc", "", "  ", "1e2", ".5", "3,50", "NaN", null, undefined, {}, Number.NaN]) {
      expect(normalizePrice(bad as unknown).ok, String(bad)).toBe(false);
    }
    expect(normalizePrice(String(OIL_PRICE_MAX)).ok).toBe(true);
    expect(normalizePrice("20.0001").ok).toBe(false);
    expect(normalizePrice("349").ok).toBe(false);
  });
});

describe("isIsoDate", () => {
  it("accepts real calendar dates only", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2027-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-1-1")).toBe(false);
    expect(isIsoDate(20261010)).toBe(false);
  });
});

describe("validateOilPriceInput", () => {
  it("accepts a normal entry and normalises it", () => {
    expect(validateOilPriceInput({ effectiveOn: "2026-10-01", pricePerGal: "3.5" }, TODAY)).toEqual({
      ok: true,
      value: { effectiveOn: "2026-10-01", pricePerGal: "3.50" },
    });
  });
  it("a date up to 30 days ahead is fine, 31 is not; ancient dates are not", () => {
    expect(validateOilPriceInput({ effectiveOn: "2026-11-09", pricePerGal: "3" }, TODAY).ok).toBe(true);
    expect(validateOilPriceInput({ effectiveOn: "2026-11-10", pricePerGal: "3" }, TODAY).ok).toBe(false);
    expect(validateOilPriceInput({ effectiveOn: "2010-01-01", pricePerGal: "3" }, TODAY).ok).toBe(false);
    expect(validateOilPriceInput({ effectiveOn: "nope", pricePerGal: "3" }, TODAY).ok).toBe(false);
  });
  it("the note is trimmed, optional, short and plain text", () => {
    const ok = validateOilPriceInput({ effectiveOn: "2026-10-01", pricePerGal: "3", note: "  invoice  " }, TODAY);
    expect(ok.ok && ok.value.note).toBe("invoice");
    expect(validateOilPriceInput({ effectiveOn: "2026-10-01", pricePerGal: "3", note: "   " }, TODAY)).toEqual({ ok: true, value: { effectiveOn: "2026-10-01", pricePerGal: "3.00" } });
    expect(validateOilPriceInput({ effectiveOn: "2026-10-01", pricePerGal: "3", note: "x".repeat(OIL_NOTE_MAX) }, TODAY).ok).toBe(true);
    expect(validateOilPriceInput({ effectiveOn: "2026-10-01", pricePerGal: "3", note: "x".repeat(OIL_NOTE_MAX + 1) }, TODAY).ok).toBe(false);
    expect(validateOilPriceInput({ effectiveOn: "2026-10-01", pricePerGal: "3", note: "a\u0000b" }, TODAY).ok).toBe(false);
    expect(validateOilPriceInput({ effectiveOn: "2026-10-01", pricePerGal: "3", note: 5 }, TODAY).ok).toBe(false);
  });
  it("a bad price is reported before anything is saved", () => {
    for (const price of ["0", "-2", "21", "3.49999", "free"]) {
      expect(validateOilPriceInput({ effectiveOn: "2026-10-01", pricePerGal: price }, TODAY).ok, price).toBe(false);
    }
  });
});

describe("parse / serialize", () => {
  it("absent is an empty, healthy list; garbage and non-arrays are corrupt (never silently overwritten)", () => {
    expect(parseOilPrices(null)).toEqual({ entries: [], corrupt: false });
    expect(parseOilPrices(undefined)).toEqual({ entries: [], corrupt: false });
    expect(parseOilPrices("")).toEqual({ entries: [], corrupt: false });
    expect(parseOilPrices("{not json").corrupt).toBe(true);
    expect(parseOilPrices("{}").corrupt).toBe(true);
    expect(parseOilPrices("42").corrupt).toBe(true);
  });
  it("round trips and drops invalid or duplicate-id entries", () => {
    const good = [entry("a", "2025-12-01", "3.9900", { note: "winter" }), entry("b", "2026-10-01", "4.50", { removed: true })];
    const raw = JSON.stringify([...good, { id: "a", effectiveOn: "2026-01-01", pricePerGal: "1.00" }, { id: "c", effectiveOn: "bad", pricePerGal: "1" }, { id: "d", effectiveOn: "2026-01-01", pricePerGal: 5 }, null, "x", { effectiveOn: "2026-01-01", pricePerGal: "2" }]);
    const parsed = parseOilPrices(raw);
    expect(parsed.corrupt).toBe(false);
    expect(parsed.entries).toEqual(good);
    expect(parseOilPrices(serializeOilPrices(good)).entries).toEqual(good);
  });
  it("is capped", () => {
    const many = Array.from({ length: OIL_PRICE_CAP + 15 }, (_, i) => entry(`id${i}`, "2026-01-01", "3.00"));
    expect(parseOilPrices(JSON.stringify(many)).entries).toHaveLength(OIL_PRICE_CAP);
    expect(JSON.parse(serializeOilPrices(many))).toHaveLength(OIL_PRICE_CAP);
  });
  it("keeps the price as a decimal STRING", () => {
    const raw = serializeOilPrices([entry("a", "2026-01-01", "3.4990")]);
    expect(raw).toContain('"pricePerGal":"3.4990"');
  });
});

describe("activeOilPrices / priceOn", () => {
  it("drops removed entries, lets the later entry on the same date win, sorts oldest first", () => {
    const list = [
      entry("a", "2026-03-01", "3.00"),
      entry("b", "2025-11-01", "4.10"),
      entry("c", "2026-03-01", "3.25"), // correction of a
      entry("d", "2026-06-01", "3.60", { removed: true }),
    ];
    expect(activeOilPrices(list).map((e) => [e.effectiveOn, e.pricePerGal])).toEqual([
      ["2025-11-01", "4.10"],
      ["2026-03-01", "3.25"],
    ]);
  });
  it("priceOn is the latest entry on or before the date, else null", () => {
    const active = activeOilPrices([entry("a", "2025-11-01", "4.10"), entry("b", "2026-03-01", "3.25")]);
    expect(priceOn(active, "2025-10-31")).toBeNull();
    expect(priceOn(active, "2025-11-01")?.pricePerGal).toBe("4.10");
    expect(priceOn(active, "2026-02-28")?.pricePerGal).toBe("4.10");
    expect(priceOn(active, "2026-03-01")?.pricePerGal).toBe("3.25");
    expect(priceOn(active, "2030-01-01")?.pricePerGal).toBe("3.25");
    expect(priceOn([], "2026-01-01")).toBeNull();
  });
});

describe("append / remove", () => {
  it("appends without touching earlier entries", () => {
    const base = [entry("a", "2026-01-01", "3.00")];
    const next = appendOilPrice(base, { id: "b", effectiveOn: "2026-06-01", pricePerGal: "3.80", addedAt: "2026-10-10T00:00:00.000Z" });
    expect(next.ok && next.value.map((e) => e.id)).toEqual(["a", "b"]);
    expect(base).toHaveLength(1);
  });
  it("refuses at the cap (removed entries count: nothing is ever deleted)", () => {
    const full = Array.from({ length: OIL_PRICE_CAP }, (_, i) => entry(`id${i}`, "2026-01-01", "3.00", { removed: true }));
    const r = appendOilPrice(full, { id: "x", effectiveOn: "2026-06-01", pricePerGal: "3.80", addedAt: "t" });
    expect(r.ok).toBe(false);
  });
  it("remove marks an entry removed and keeps it; unknown ids are an error; idempotent", () => {
    const base = [entry("a", "2026-01-01", "3.00"), entry("b", "2026-06-01", "3.80")];
    const r = markOilPriceRemoved(base, "a");
    expect(r.ok && r.value).toEqual([{ ...base[0], removed: true }, base[1]]);
    expect(markOilPriceRemoved(base, "zzz").ok).toBe(false);
    const again = markOilPriceRemoved(r.ok ? r.value : [], "a");
    expect(again.ok && again.value[0]?.removed).toBe(true);
  });
});

describe("keys and the opt-in", () => {
  it("per-entity key", () => {
    expect(oilPriceKey("e1")).toBe("oil_price_history:e1");
  });
  it("replace-draws is OFF unless the value is exactly true", () => {
    expect(parseReplaceDraws(null)).toBe(false);
    expect(parseReplaceDraws("false")).toBe(false);
    expect(parseReplaceDraws("1")).toBe(false);
    expect(parseReplaceDraws("true")).toBe(true);
    expect(parseReplaceDraws(" TRUE ")).toBe(true);
  });
});
