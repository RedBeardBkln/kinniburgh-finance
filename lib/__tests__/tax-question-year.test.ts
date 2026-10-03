import { describe, it, expect } from "vitest";
import { TAX_QUESTION_BANK, renderTaxQuestion, withTaxYear } from "@/lib/tax-guidance";

describe("planning question text is year-aware", () => {
  it("withTaxYear replaces every {year} and nothing else", () => {
    expect(withTaxYear("a {year} b {year}", 2026)).toBe("a 2026 b 2026");
    expect(withTaxYear("no placeholder 2025", 2026)).toBe("no placeholder 2025");
  });

  it("renders the year the workspace is for into the question titles", () => {
    const filing = TAX_QUESTION_BANK.find((q) => q.key === "filing_status")!;
    expect(renderTaxQuestion(filing, 2026).question).toBe("How will you file your 2026 federal return?");
    expect(renderTaxQuestion(filing, 2025).question).toBe("How will you file your 2025 federal return?");
  });

  it("leaves no {year} placeholder behind in any rendered copy, for several years", () => {
    for (const year of [2024, 2025, 2026, 2027]) {
      for (const def of TAX_QUESTION_BANK) {
        const r = renderTaxQuestion(def, year);
        const copy = [r.question, r.context, r.placeholder ?? "", ...(r.options ?? []).flatMap((o) => [o.label, o.note])];
        for (const text of copy) expect(text, `${def.key} ${year}`).not.toContain("{year}");
      }
    }
  });

  it("no question title hard-codes the tax year any more (they use {year})", () => {
    for (const def of TAX_QUESTION_BANK) {
      expect(def.question, def.key).not.toMatch(/\b2025\b/);
    }
  });

  it("rendering never changes keys, categories, option values or the count of options", () => {
    for (const def of TAX_QUESTION_BANK) {
      const r = renderTaxQuestion(def, 2026);
      expect(r.key).toBe(def.key);
      expect(r.category).toBe(def.category);
      expect(r.options?.map((o) => o.value)).toEqual(def.options?.map((o) => o.value));
    }
  });

  it("the EV question no longer says 'or plan to before filing'", () => {
    const ev = TAX_QUESTION_BANK.find((q) => q.key === "ev_vehicle")!;
    expect(ev.question).not.toMatch(/plan to/i);
  });
});
