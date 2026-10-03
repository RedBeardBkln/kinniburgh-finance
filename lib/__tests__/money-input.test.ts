import { describe, it, expect } from "vitest";
import { parseDollarsToCents, MAX_INT_CENTS } from "@/lib/money-input";

function cents(raw: string, opts?: Parameters<typeof parseDollarsToCents>[1]): number | null {
  const r = parseDollarsToCents(raw, opts);
  return r.ok ? r.cents : null;
}

describe("parseDollarsToCents", () => {
  it("parses whole dollars, commas and one/two decimals", () => {
    expect(cents("1250")).toBe(125000);
    expect(cents("1,250")).toBe(125000);
    expect(cents("1,250.5")).toBe(125050);
    expect(cents("1,250.50")).toBe(125050);
    expect(cents("$1,250.00")).toBe(125000);
    expect(cents("  42  ")).toBe(4200);
  });

  it("has no float error on classic float-trap amounts", () => {
    expect(cents("$19.99")).toBe(1999);
    expect(cents("0.07")).toBe(7);
    expect(cents("1.15")).toBe(115);
    expect(cents("0.29")).toBe(29);
    expect(cents("4.35")).toBe(435);
  });

  it("rejects empty, negatives, 3+ decimals (never rounds), exponent, leading-dot and text", () => {
    for (const bad of ["", "   ", "-5", "-0.50", "12.345", "1.005", "abc", "1e3", ".5", "$", "1,2,3", "12,34", "1 000", "5.", "--1"]) {
      expect(parseDollarsToCents(bad).ok, `"${bad}" should be rejected`).toBe(false);
    }
  });

  it("rejects zero unless allowZero", () => {
    expect(parseDollarsToCents("0").ok).toBe(false);
    expect(parseDollarsToCents("0.00").ok).toBe(false);
    expect(cents("0", { allowZero: true })).toBe(0);
    expect(cents("0.00", { allowZero: true })).toBe(0);
  });

  it("accepts the Int ceiling and rejects one cent above it", () => {
    expect(MAX_INT_CENTS).toBe(2_147_483_647);
    expect(cents("21474836.47")).toBe(2_147_483_647);
    expect(parseDollarsToCents("21474836.48").ok).toBe(false);
    expect(parseDollarsToCents("99999999999999999999").ok).toBe(false);
  });

  it("honors a custom maxCents", () => {
    expect(cents("10.00", { maxCents: 1000 })).toBe(1000);
    expect(parseDollarsToCents("10.01", { maxCents: 1000 }).ok).toBe(false);
  });

  it("returns an error message on failure", () => {
    const r = parseDollarsToCents("12.345");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});
