import { describe, expect, it } from "vitest";
import {
  computeDocumentTotals,
  discountCents,
  formatBps,
  formatCents,
  formatQuantityMilli,
  lineGrossCents,
  lineTotals,
  markupPriceCents,
  parsePercentToBps,
  parseQuantityMilli,
  percentOf,
} from "@/lib/invoicing/money";

describe("quantity parsing", () => {
  it("parses up to 3 decimals into thousandths", () => {
    expect(parseQuantityMilli("7.25")).toBe(7250);
    expect(parseQuantityMilli("10")).toBe(10000);
    expect(parseQuantityMilli("0.001")).toBe(1);
    expect(parseQuantityMilli(" 1.5 ")).toBe(1500);
  });
  it("rejects zero, negatives, 4 decimals, text and absurd sizes", () => {
    for (const bad of ["0", "0.000", "-1", "1.2345", "abc", "", "1e3", "1,5", "1234567890"]) expect(parseQuantityMilli(bad)).toBeNull();
  });
  it("formats back to the shortest exact text", () => {
    expect(formatQuantityMilli(7250)).toBe("7.25");
    expect(formatQuantityMilli(10000)).toBe("10");
    expect(formatQuantityMilli(1)).toBe("0.001");
    expect(formatQuantityMilli(500)).toBe("0.5");
  });
});

describe("line rounding is half-up", () => {
  it("fractional hours: 7.25 x $175.00 = $1,268.75", () => {
    expect(lineGrossCents(7250, 17500)).toBe(126875);
  });
  it("rounds x.5 cents up and x.49 down", () => {
    // 0.5 x 1 cent = 0.5 cent -> 1
    expect(lineGrossCents(500, 1)).toBe(1);
    // 0.499 x 1 cent = 0.499 -> 0
    expect(lineGrossCents(499, 1)).toBe(0);
    // 1.5 x 333 cents = 499.5 -> 500
    expect(lineGrossCents(1500, 333)).toBe(500);
    // 0.333 x 100 = 33.3 -> 33
    expect(lineGrossCents(333, 100)).toBe(33);
  });
  it("is exact for large products (no float drift)", () => {
    // 999,999.999 x $21,474,836.47 would overflow doubles' integer range; BigInt keeps it exact before the Int check.
    expect(lineGrossCents(999_999_999, 2_147_483_647)).toBe(Number((BigInt(999999999) * BigInt(2147483647) + BigInt(500)) / BigInt(1000)));
  });
});

describe("discounts", () => {
  it("percent discount is half-up on the base", () => {
    expect(percentOf(12345, 1500)).toBe(1852); // 1851.75 -> 1852
    expect(percentOf(1, 5000)).toBe(1); // 0.5 -> 1
    expect(percentOf(100, 1)).toBe(0); // 0.01 -> 0
  });
  it("fixed discount may not exceed the amount; zero is refused", () => {
    expect(discountCents(1000, { kind: "fixed", value: 1000 })).toEqual({ ok: true, cents: 1000 });
    expect(discountCents(1000, { kind: "fixed", value: 1001 }).ok).toBe(false);
    expect(discountCents(1000, { kind: "fixed", value: 0 }).ok).toBe(false);
    expect(discountCents(1000, { kind: "percent", value: 10001 }).ok).toBe(false);
    expect(discountCents(1000, null)).toEqual({ ok: true, cents: 0 });
  });
  it("line total after its own discount", () => {
    const r = lineTotals({ quantityMilli: 2000, unitPriceCents: 5000, discount: { kind: "percent", value: 1000 } });
    expect(r).toEqual({ ok: true, totals: { grossCents: 10000, discountCents: 1000, totalCents: 9000 } });
  });
  it("rejects a bad quantity or price", () => {
    expect(lineTotals({ quantityMilli: 0, unitPriceCents: 1 }).ok).toBe(false);
    expect(lineTotals({ quantityMilli: 1000, unitPriceCents: -1 }).ok).toBe(false);
    expect(lineTotals({ quantityMilli: 1000, unitPriceCents: 1.5 }).ok).toBe(false);
  });
});

describe("document totals", () => {
  it("subtotal, invoice discount on the subtotal, total", () => {
    const r = computeDocumentTotals(
      [
        { quantityMilli: 7250, unitPriceCents: 17500 }, // 1268.75
        { quantityMilli: 1000, unitPriceCents: 50000, discount: { kind: "fixed", value: 5000 } }, // 450.00
      ],
      { kind: "percent", value: 1000 }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.totals.subtotalCents).toBe(126875 + 45000);
      expect(r.totals.discountCents).toBe(percentOf(171875, 1000));
      expect(r.totals.totalCents).toBe(171875 - 17188);
    }
  });
  it("an invoice discount larger than the subtotal is refused", () => {
    expect(computeDocumentTotals([{ quantityMilli: 1000, unitPriceCents: 100 }], { kind: "fixed", value: 101 }).ok).toBe(false);
  });
  it("names the bad line", () => {
    const r = computeDocumentTotals([{ quantityMilli: 1000, unitPriceCents: 100 }, { quantityMilli: 0, unitPriceCents: 1 }], null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^Line 2:/);
  });
  it("PROPERTY: total == sum(lines) - discount, never negative, over 2000 pseudo-random documents", () => {
    let seed = 123456789;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 2000; i += 1) {
      const n = 1 + Math.floor(rnd() * 6);
      const lines = Array.from({ length: n }, () => {
        const q = 1 + Math.floor(rnd() * 99999);
        const p = Math.floor(rnd() * 1_000_000);
        const gross = lineGrossCents(q, p);
        const kind = rnd();
        const discount = kind < 0.3 ? { kind: "percent" as const, value: 1 + Math.floor(rnd() * 10000) } : kind < 0.5 && gross > 0 ? { kind: "fixed" as const, value: 1 + Math.floor(rnd() * gross) } : null;
        return { quantityMilli: q, unitPriceCents: p, discount };
      });
      const sub = lines.reduce((s, l) => {
        const r = lineTotals(l);
        return s + (r.ok ? r.totals.totalCents : 0);
      }, 0);
      const dd = rnd() < 0.4 ? { kind: "percent" as const, value: 1 + Math.floor(rnd() * 10000) } : null;
      const r = computeDocumentTotals(lines, dd);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.totals.subtotalCents).toBe(sub);
        expect(r.totals.totalCents).toBe(sub - r.totals.discountCents);
        expect(r.totals.totalCents).toBeGreaterThanOrEqual(0);
        expect(r.totals.lines.reduce((s, l) => s + l.totalCents, 0)).toBe(sub);
      }
    }
  });
});

describe("markup price", () => {
  it("cost x (1 + bps/10000), half-up", () => {
    expect(markupPriceCents(20000, 1000)).toBe(22000); // $200 + 10%
    expect(markupPriceCents(1999, 1500)).toBe(2299); // 2298.85 -> 2299
    expect(markupPriceCents(1001, 50)).toBe(1006); // 1006.0055? 1001 x 1.005 = 1006.005 -> 1006
    expect(markupPriceCents(5, 1000)).toBe(6); // 5.5 -> 6
    expect(markupPriceCents(100, 0)).toBe(100);
  });
});

describe("percent text", () => {
  it("parses and formats basis points", () => {
    expect(parsePercentToBps("15")).toBe(1500);
    expect(parsePercentToBps("12.5")).toBe(1250);
    expect(parsePercentToBps("0.25")).toBe(25);
    expect(parsePercentToBps("100")).toBe(10000);
    for (const bad of ["0", "100.01", "101", "-5", "1.234", "x", ""]) expect(parsePercentToBps(bad)).toBeNull();
    expect(formatBps(1500)).toBe("15");
    expect(formatBps(1250)).toBe("12.5");
    expect(formatBps(25)).toBe("0.25");
  });
});

describe("display formatting", () => {
  it("formats cents as dollars", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(-250)).toBe("-$2.50");
  });
});
