// Form 8829 (actual home-office method) is NOT built: the engine does not compute the actual method and the app does not hold the inputs
// (area percentage, home basis and land value, insurance, utilities, repairs, prior-year carryovers). What the engine CAN state is whether
// the form is needed: under the simplified method (decision X1, the default) no Form 8829 is filed; if the CPA chooses "actual" it is required
// and the cover lists it as not generated.

import { describe, expect, it } from "vitest";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { buildCoverModel, type CoverBlock } from "@/lib/tax2025/pdf/cover";
import { EXPLICIT_NO_PDF, requiredFormsWithoutPdf } from "@/lib/tax2025/pdf/no-pdf-forms";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { fullFacts, fullFacts1b, owner } from "./tax2025-fixtures";

function withHomeOffice(f: Ty2025Facts, eligibility: "yes_exclusive" | "yes_shared" | "no" | null, sqft: number | null = 200): Ty2025Facts {
  if (eligibility !== null) f.income.scheduleC.homeOfficeEligibility = owner(eligibility);
  f.income.scheduleC.homeOfficeSqft = sqft === null ? { value: null, basis: null, refs: [] } : owner(sqft);
  return f;
}

const decided = (chosen: "simplified" | "actual") => ({ homeOfficeMethod: { chosen, by: "cpa-1", at: "2026-10-04T12:00:00.000Z" } });

describe("Form 8829 verdict (decision X1)", () => {
  it("default (undecided) simplified method: not required, with the reason on the cover", () => {
    const r = computeTy2025Return(withHomeOffice(fullFacts(), "yes_exclusive"));
    const v = r.formsRequired.f8829;
    expect(v?.required).toBe(false);
    expect(v?.reason).toContain("simplified home-office method is in force");
    expect(v?.reason).toContain("default, undecided");
    expect(v?.reason).toContain("no Form 8829 is filed");
  });

  it("a recorded decision for the simplified method: not required ('decided')", () => {
    const r = computeTy2025Return(withHomeOffice(fullFacts(), "yes_exclusive"), decided("simplified"));
    expect(r.formsRequired.f8829?.required).toBe(false);
    expect(r.formsRequired.f8829?.reason).toContain("(decision X1, decided)");
  });

  it("the CPA chooses the actual method: required, and the reason says this packet does not generate it", () => {
    const r = computeTy2025Return(withHomeOffice(fullFacts(), "yes_exclusive"), decided("actual"));
    expect(r.formsRequired.f8829?.required).toBe(true);
    expect(r.formsRequired.f8829?.reason).toContain("does not generate it");
    expect(r.lines["schc.30"]?.status).toBe("not_yet_computed"); // the actual method is not computed
  });

  it("an exclusive home office without a square footage cannot form decision X1: still blocking", () => {
    const r = computeTy2025Return(withHomeOffice(fullFacts(), "yes_exclusive", null));
    expect(r.formsRequired.f8829?.required).toBe("blocking");
  });

  it("no home office / shared space: unchanged, not required", () => {
    for (const e of ["no", "yes_shared"] as const) {
      expect(computeTy2025Return(withHomeOffice(fullFacts(), e)).formsRequired.f8829).toEqual({ required: false, reason: "No home office deduction claimed." });
    }
  });

  it("the X1 simplified alternative states that no Form 8829 is filed (the cover's 'Defaults in force' bullet)", () => {
    const r = computeTy2025Return(withHomeOffice(fullFacts(), "yes_exclusive"));
    const simplified = r.results.flatMap((x) => x.alternatives ?? []).find((a) => a.id === "simplified");
    expect(simplified?.effect?.note).toContain("no Form 8829 is filed with this method");
  });
});

describe("the cover and Form 8829", () => {
  const OPTS = { generatedAt: "2026-10-04T16:00:00.000Z", generatedBy: "Test User" } as const;
  const missing = (f: Ty2025Facts, decisions = {}) => {
    const ret = computeTy2025Return(f, decisions);
    const view = toPdfReturnView(ret, f, OPTS);
    const list = requiredFormsWithoutPdf(view);
    const model = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true, missingForms: list });
    return { list, model };
  };
  const text = (blocks: readonly CoverBlock[]): string => blocks.map((b) => (b.kind === "kv" ? `${b.label}: ${b.value}` : b.kind === "spacer" ? "" : b.text)).join("\n");

  it("the explicit no-PDF list is exactly the engine forms that still have no map (Schedule 1-A and Form 8960 are mapped now)", () => {
    expect([...EXPLICIT_NO_PDF].sort()).toEqual(["f2210", "f4562", "f5695", "f6251", "f8283", "f8829", "f8880", "f8889"].sort());
  });

  it("default view: Form 8829, Schedule 1-A and Form 8960 are not listed under 'does NOT contain'", () => {
    const { list } = missing(withHomeOffice(fullFacts1b(), "yes_exclusive"));
    const ids = list.map((m) => m.formId);
    for (const id of ["f8829", "sch1a", "f8960"]) expect(ids, id).not.toContain(id);
  });

  it("the CPA chooses actual: Form 8829 is listed with the engine's reason", () => {
    const { list, model } = missing(withHomeOffice(fullFacts1b(), "yes_exclusive"), decided("actual"));
    expect(list.map((m) => m.formId)).toContain("f8829");
    const t = text(model.blocks);
    expect(t).toContain("Form 8829");
    expect(t).toContain("You chose the actual home-office method"); // the cover renders the engine reason through the owner wording layer
  });

  it("the 'Defaults in force' bullet on the cover says no Form 8829 is filed", () => {
    const { model } = missing(withHomeOffice(fullFacts1b(), "yes_exclusive"));
    expect(text(model.blocks)).toContain("no Form 8829 is filed");
  });
});
