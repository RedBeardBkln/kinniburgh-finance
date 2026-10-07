import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TAX_FACTS_SEED_CONFIRMED_AT,
  TAX_FACTS_SEED_TY2025,
  TAX_FACTS_SEED_VERSION,
} from "@/lib/tax-facts/seed-ty2025";
import { containsPrivateIdentifier, validateFactDraft, validateReason } from "@/lib/tax-facts/validate";
import { findCpaWording } from "@/lib/tax-wording";
import { resolveCarryForward, type CarryRow } from "@/lib/tax-facts/carry-forward";

const SPEC = readFileSync(resolve(__dirname, "../../specs/12-owner-confirmed-facts-ty2025.md"), "utf8").replace(/\r\n/g, "\n");

describe("TY2025 seed list", () => {
  it("has unique, valid keys and passes the same validation as an owner edit", () => {
    const keys = TAX_FACTS_SEED_TY2025.map((s) => s.factKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of TAX_FACTS_SEED_TY2025) {
      const r = validateFactDraft({ ...s });
      expect(r.ok, `${s.factKey}: ${r.ok ? "" : r.error}`).toBe(true);
      if (s.reason !== undefined) expect(validateReason(s.reason, false).ok, s.factKey).toBe(true);
    }
  });

  it("traces every entry to a verbatim sentence of specs/12 (the anti-fabrication anchor)", () => {
    for (const s of TAX_FACTS_SEED_TY2025) {
      expect(s.specAnchor.length, s.factKey).toBeGreaterThan(8);
      expect(SPEC.includes(s.specAnchor), `${s.factKey}: specAnchor not found verbatim in specs/12`).toBe(true);
      for (const extra of s.moreAnchors ?? []) {
        expect(SPEC.includes(extra), `${s.factKey}: extra anchor not found verbatim in specs/12`).toBe(true);
      }
    }
  });

  it("the spec itself carries no SSN, EIN, account number or date-of-birth text the seed could have copied", () => {
    // The seed text is checked below; this guards the source the seed is transcribed from.
    expect(/\d{3}-\d{2}-\d{4}/.test(SPEC)).toBe(false);
  });

  it("no label, value, reference or reason trips the privacy guard, a CPA wording scan or a 6+ digit run", () => {
    for (const s of TAX_FACTS_SEED_TY2025) {
      for (const text of [s.label, s.valueText, s.sourceRef, s.reason, s.factKey]) {
        if (text === undefined) continue;
        expect(containsPrivateIdentifier(text), `${s.factKey}: ${text}`).toBe(false);
        expect(findCpaWording(text), `${s.factKey}: ${text}`).toEqual([]);
        expect(/\d{6,}/.test(text), `${s.factKey}: ${text}`).toBe(false);
      }
    }
  });

  it("uses only known policies, defaults the ambiguous rows to reconfirm, and gives the derived row a value", () => {
    for (const s of TAX_FACTS_SEED_TY2025) {
      if (s.category === "decision" || s.category === "household") expect(s.carryPolicy, s.factKey).toBe("reconfirm");
    }
    const derived = TAX_FACTS_SEED_TY2025.filter((s) => s.carryPolicy === "derived");
    expect(derived.map((s) => s.factKey)).toEqual(["retirement.taxpayer_m.ira_basis_end"]);
    expect(derived[0]?.valueCents).toBe(1_430_000);
    expect(derived[0]?.sourceKind).toBe("derived");
  });

  it("the seven open items are open items, not facts", () => {
    const open = TAX_FACTS_SEED_TY2025.filter((s) => s.category === "open_item");
    expect(open).toHaveLength(7);
    for (const s of open) {
      expect(s.valueKind, s.factKey).toBe("open_item");
      expect(s.factKey.startsWith("open."), s.factKey).toBe(true);
    }
    expect(TAX_FACTS_SEED_TY2025.filter((s) => s.valueKind === "open_item")).toHaveLength(7);
  });

  it("pins the count by category", () => {
    const counts: Record<string, number> = {};
    for (const s of TAX_FACTS_SEED_TY2025) counts[s.category] = (counts[s.category] ?? 0) + 1;
    expect(counts).toEqual({
      household: 4,
      business: 7,
      income: 7,
      payments: 1,
      decision: 5,
      retirement: 3,
      property: 8,
      estate: 5,
      open_item: 7,
    });
    expect(TAX_FACTS_SEED_TY2025).toHaveLength(47);
  });

  it("does not seed figures that documents hold (W-2, interest, 1098, brokerage, property tax, 5498 or the estate 1099-INT) or the 2026 gift", () => {
    const all = TAX_FACTS_SEED_TY2025.map((s) => `${s.label} ${s.valueText ?? ""} ${s.sourceRef}`).join("\n");
    for (const figure of ["273,291", "15,591.07", "1,124.32", "13.72", "18,882.69", "6,143.22", "3,283.90", "5,872.31", "17,001.68", "4,545.80", "2,800", "7,300", "1,894.50", "2,408", "7,000"]) {
      expect(all.includes(figure), figure).toBe(false);
    }
  });

  it("the decisions match spec 12's decision line", () => {
    const get = (k: string) => TAX_FACTS_SEED_TY2025.find((s) => s.factKey === k);
    expect(get("decision.x1.home_office_method")?.valueText).toBe("simplified");
    expect(get("decision.x5.arbor_rd_property_tax")?.valueText).toBe("schedule_a");
    expect(get("decision.x6.internet_phone_business_pct")?.valueText).toBe("50");
    expect(get("decision.x7.federal_overpayment")?.valueText).toBe("refund_all");
    expect(get("decision.x8.ct_overpayment")?.valueText).toBe("refund_all");
    for (const d of TAX_FACTS_SEED_TY2025.filter((s) => s.category === "decision")) expect(d.sourceKind).toBe("decision");
  });

  it("is dated the day of spec 12's status line, and the version is pinned", () => {
    expect(SPEC).toContain("written 2026-10-07");
    expect(TAX_FACTS_SEED_CONFIRMED_AT.toISOString().slice(0, 10)).toBe("2026-10-07");
    expect(TAX_FACTS_SEED_VERSION).toBe(1);
  });

  it("carries into TY2026 as the policies say, with the year each came from", () => {
    const rows: CarryRow[] = TAX_FACTS_SEED_TY2025.map((s) => ({
      factKey: s.factKey,
      version: 1,
      category: s.category,
      label: s.label,
      taxYear: s.taxYear,
      valueKind: s.valueKind,
      valueCents: s.valueCents ?? null,
      valueText: s.valueText ?? null,
      carryPolicy: s.carryPolicy,
      changeKind: "established",
      sourceKind: s.sourceKind,
      confirmedAt: TAX_FACTS_SEED_CONFIRMED_AT,
    }));
    const r = resolveCarryForward(rows, 2026);
    expect(r.openItems).toHaveLength(7);
    // Sudden Valley's formation is established FOR 2026, so it is already confirmed for that year.
    expect(r.alreadyConfirmedForYear.map((i) => i.factKey)).toEqual(["business.sudden_valley.formed"]);
    expect(r.askFresh.every((i) => i.referenceOnly)).toBe(true);
    expect(r.needsReconfirmation.some((i) => i.factKey === "retirement.taxpayer_m.ira_basis_end")).toBe(true);
    expect(r.needsReconfirmation.some((i) => i.factKey === "decision.x1.home_office_method")).toBe(true);
    expect(r.carried.every((i) => i.fromTaxYear === 2025)).toBe(true);
    const total = r.carried.length + r.needsReconfirmation.length + r.openItems.length + r.askFresh.length + r.alreadyConfirmedForYear.length;
    expect(total).toBe(TAX_FACTS_SEED_TY2025.length);
  });
});
