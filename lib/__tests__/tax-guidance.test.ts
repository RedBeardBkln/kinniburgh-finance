import { describe, it, expect } from "vitest";
import {
  TAX_QUESTION_BANK,
  baseOpportunitiesForHousehold,
  evaluateAnswers,
  formatOpportunityForDisplay,
  PERSONAL_FORM_PLAN,
  REFUND_OBJECTIVE_STATEMENT,
  SUDDEN_VALLEY_ONLY_OPPORTUNITY_KEYS,
  SUDDEN_VALLEY_ONLY_QUESTION_KEYS,
  withoutSuddenValleyItems,
} from "@/lib/tax-guidance";

// ── Question bank integrity ──────────────────────────────────────────────────

describe("TAX_QUESTION_BANK", () => {
  it("has unique keys", () => {
    const keys = TAX_QUESTION_BANK.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has the three none-confirmation questions (donations / EKC assets / SV assets) with none+some options", () => {
    for (const key of ["donations_none", "fixed_assets_ekc", "fixed_assets_sv"]) {
      const def = TAX_QUESTION_BANK.find((q) => q.key === key);
      expect(def, key).toBeDefined();
      expect(def!.category).toBe("deductions");
      expect(def!.options?.map((o) => o.value)).toEqual(["none", "some"]);
    }
  });

  it("every question has context explaining why it's asked", () => {
    for (const q of TAX_QUESTION_BANK) {
      expect(q.context.length).toBeGreaterThan(60);
    }
  });

  it("every multiple-choice option carries an honest note with implications", () => {
    for (const q of TAX_QUESTION_BANK) {
      if (!q.options) continue;
      for (const opt of q.options) {
        expect(opt.note.length).toBeGreaterThan(40);
      }
    }
  });

  it("options within a question have unique values", () => {
    for (const q of TAX_QUESTION_BANK) {
      if (!q.options) continue;
      const vals = q.options.map((o) => o.value);
      expect(new Set(vals).size).toBe(vals.length);
    }
  });
});

// ── Opportunity engine ───────────────────────────────────────────────────────

describe("baseOpportunitiesForHousehold", () => {
  it("covers the household's documented positions", () => {
    const keys = baseOpportunitiesForHousehold().map((o) => o.key);
    expect(keys).toContain("mortgage_interest");
    expect(keys).toContain("rental_depreciation");
    expect(keys).toContain("safe_harbor");
  });

  it("flags aggressive items with a non-empty caveat", () => {
    const aggressive = baseOpportunitiesForHousehold().filter(
      (o) => o.risk === "aggressive"
    );
    expect(aggressive.length).toBeGreaterThan(0);
    for (const op of aggressive) {
      expect(op.caveat.length).toBeGreaterThan(40);
    }
  });

  it("every opportunity names the forms it touches", () => {
    for (const op of baseOpportunitiesForHousehold()) {
      expect(op.forms.length).toBeGreaterThan(0);
    }
  });
});

describe("evaluateAnswers", () => {
  it("excludes home office when space is shared-use", () => {
    const { excluded, actOn } = evaluateAnswers({ home_office_ekc: "yes_shared" });
    expect(excluded).toContain("home_office");
    expect(actOn).not.toContain("home_office");
  });

  it("activates home office when exclusive-use confirmed", () => {
    const { actOn } = evaluateAnswers({ home_office_ekc: "yes_exclusive" });
    expect(actOn).toContain("home_office");
  });

  it("keeps the saver's credit for married filing separately (IRS lists MFS under 'All other filers')", () => {
    const { excluded } = evaluateAnswers({ filing_status: "mfs" });
    expect(excluded).not.toContain("retirement_savings_credit");
  });

  it("keeps saver's credit for joint filers", () => {
    const { excluded } = evaluateAnswers({ filing_status: "mfj" });
    expect(excluded).not.toContain("retirement_savings_credit");
  });

  it("handles solar already claimed vs unclaimed", () => {
    expect(evaluateAnswers({ solar_credit: "claimed_already" }).excluded).toContain("solar_credit_25d");
    expect(evaluateAnswers({ solar_credit: "yes_unclaimed" }).actOn).toContain("solar_credit_25d");
  });

  it("empty answers produce no exclusions or actions", () => {
    expect(evaluateAnswers({})).toEqual({ excluded: [], actOn: [] });
  });
});

describe("formatOpportunityForDisplay", () => {
  it("labels aggressive items as CPA-review-required", () => {
    const result = formatOpportunityForDisplay({
      key: "x",
      title: "T",
      explanation: "E",
      value: "V",
      risk: "aggressive",
      caveat: "C",
      forms: [],
    });
    expect(result.riskLabel).toBe("A professional's review is advised");
  });

  it("labels conservative items as well-established", () => {
    const result = formatOpportunityForDisplay({
      key: "x",
      title: "T",
      explanation: "E",
      value: "V",
      risk: "conservative",
      caveat: "",
      forms: [],
    });
    expect(result.riskLabel).toBe("Well-established");
  });
});

// ── Form plan ────────────────────────────────────────────────────────────────

describe("PERSONAL_FORM_PLAN", () => {
  it("covers federal 1040, schedules, and CT state return", () => {
    const names = PERSONAL_FORM_PLAN.map((f) => f.formName);
    expect(names.some((n) => n.includes("1040"))).toBe(true);
    expect(names.some((n) => n.includes("Schedule A"))).toBe(true);
    expect(names.some((n) => n.includes("Schedule C"))).toBe(true);
    expect(names.some((n) => n.includes("Schedule E"))).toBe(true);
    expect(names.some((n) => n.includes("CT"))).toBe(true);
  });

  it("every field states its data source", () => {
    for (const form of PERSONAL_FORM_PLAN) {
      expect(form.purpose.length).toBeGreaterThan(20);
      expect(form.whereToGet.length).toBeGreaterThan(10);
      for (const field of form.fields) {
        expect(field.source.length).toBeGreaterThan(5);
      }
    }
  });
});

// ── Refund objective ─────────────────────────────────────────────────────────

describe("REFUND_OBJECTIVE_STATEMENT", () => {
  it("states the maximize-refund objective honestly", () => {
    expect(REFUND_OBJECTIVE_STATEMENT).toMatch(/deduction and credit the law allows/);
    expect(REFUND_OBJECTIVE_STATEMENT).toMatch(/penalties/i);
  });
});

// -- Sudden Valley only matters from the year it exists -------------------------

describe("withoutSuddenValleyItems", () => {
  it("every Sudden Valley-only key refers to a real question / opportunity", () => {
    const questionKeys = TAX_QUESTION_BANK.map((q) => q.key);
    for (const k of SUDDEN_VALLEY_ONLY_QUESTION_KEYS) expect(questionKeys).toContain(k);
    const opKeys = baseOpportunitiesForHousehold().map((o) => o.key);
    for (const k of SUDDEN_VALLEY_ONLY_OPPORTUNITY_KEYS) expect(opKeys).toContain(k);
  });

  it("drops the rental question and rental opportunities when Sudden Valley is not active", () => {
    const qs = withoutSuddenValleyItems(TAX_QUESTION_BANK, false).map((q) => q.key);
    expect(qs).not.toContain("rental_property_use");
    expect(qs).not.toContain("fixed_assets_sv");
    expect(qs).toContain("fixed_assets_ekc");
    expect(qs).toContain("donations_none");
    const ops = withoutSuddenValleyItems(baseOpportunitiesForHousehold(), false).map((o) => o.key);
    expect(ops).not.toContain("rental_depreciation");
    expect(ops).not.toContain("short_term_rental_loophole");
    // Everything unrelated to the rental stays.
    expect(ops).toContain("mortgage_interest");
    expect(qs).toContain("business_mileage");
    expect(qs.length).toBe(TAX_QUESTION_BANK.length - SUDDEN_VALLEY_ONLY_QUESTION_KEYS.length);
  });

  it("keeps everything when Sudden Valley is active, and never mutates its input", () => {
    const all = baseOpportunitiesForHousehold();
    const before = all.map((o) => o.key);
    expect(withoutSuddenValleyItems(all, true).map((o) => o.key)).toEqual(before);
    withoutSuddenValleyItems(all, false);
    expect(all.map((o) => o.key)).toEqual(before);
  });
});
