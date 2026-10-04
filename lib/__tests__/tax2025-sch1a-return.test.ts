// Schedule 1-A through the whole return: the W-2 box 7 employer count feeds line 4a, the Schedule C owner's own tips
// answer feeds line 5, and the advisory about the unverifiable owner statements appears iff line 38 is positive.

import { describe, expect, it } from "vitest";
import { computeTy2025Return } from "@/lib/tax2025/return";
import type { LineKey, Ty2025Return } from "@/lib/tax2025/types";
import { ERIC_ID, EVA_ID, fullFacts1b, owner, w2 } from "@/lib/__tests__/tax2025-fixtures";

const amt = (r: Ty2025Return, k: LineKey): number | null => r.lines[k]?.amount ?? null;
const st = (r: Ty2025Return, k: LineKey): string | undefined => r.lines[k]?.status;

/** Eva: qualified tips 4,545.80 (the single W-2 with box 7 of that amount) and overtime premium 2,408; Eric: none. */
function evaFacts() {
  const f = fullFacts1b();
  f.returnAnswers.magiExclusionsNone = owner(true);
  const eva = f.returnAnswers.people.find((p) => p.userId === EVA_ID)!;
  eva.tipsChoice = owner("some");
  eva.tipsCents = owner(454_580);
  eva.overtimeChoice = owner("premium");
  eva.overtimeCents = owner(240_800);
  eva.validSsn = owner(true);
  f.income.w2s = f.income.w2s.map((x) => (x.personUserId === EVA_ID ? { ...x, socialSecurityTipsCents: 454_580 } : x));
  return f;
}

describe("Schedule 1-A through the return", () => {
  it("one employer with W-2 box 7 equal to the owner's tips: 4a 4,546, line 38 6,954 = Form 1040 line 13b, no blocking item", () => {
    const r = computeTy2025Return(evaFacts());
    expect(amt(r, "sch1a.4a")).toBe(4546);
    expect(amt(r, "sch1a.4c")).toBe(4546);
    expect(amt(r, "sch1a.13")).toBe(4546);
    expect(amt(r, "sch1a.21")).toBe(2408);
    expect(amt(r, "sch1a.38")).toBe(6954);
    expect(amt(r, "f1040.13b")).toBe(6954);
    expect(st(r, "sch1a.5")).toBe("not_applicable");
    expect(r.openItems.filter((o) => o.severity === "blocking")).toEqual([]);
    expect(r.formsRequired.sch1a?.required).toBe(true);
  });

  it("the advisory about unverifiable owner statements appears when line 38 > 0 and names the occupation list", () => {
    const r = computeTy2025Return(evaFacts());
    const item = r.openItems.find((o) => o.id === "sch1a-owner-statements");
    expect(item?.severity).toBe("advisory");
    expect(item?.message).toContain("TippedOccupations");
    expect(item?.message).toContain("OT PREMIUM");
  });

  it("no advisory when nothing is claimed (line 38 = 0)", () => {
    const r = computeTy2025Return(fullFacts1b());
    expect(amt(r, "sch1a.38")).toBe(0);
    expect(r.openItems.some((o) => o.id === "sch1a-owner-statements")).toBe(false);
  });

  it("two W-2s with box 7: lines 4a and 4b are blank advisories (not blocking), line 4c keeps the owner's total", () => {
    const f = evaFacts();
    f.income.w2s = [...f.income.w2s, w2({ docId: "w2-eva-2", employer: "Second Place", personUserId: EVA_ID, wagesCents: 100_000, socialSecurityTipsCents: 10_000 })];
    const r = computeTy2025Return(f);
    expect(st(r, "sch1a.4a")).toBe("not_yet_computed");
    expect(st(r, "sch1a.4b")).toBe("not_yet_computed");
    expect(amt(r, "sch1a.4c")).toBe(4546);
    expect(amt(r, "sch1a.38")).toBe(6954);
    expect(r.openItems.find((o) => o.id === "info:sch1a.4a")?.severity).toBe("advisory");
    expect(r.openItems.filter((o) => o.severity === "blocking").some((o) => o.lineKeys.includes("sch1a.4a"))).toBe(false);
  });

  it("the Schedule C owner (Eric) reporting tips of his own sends line 5 to the CPA and blocks Schedule 1-A", () => {
    const f = evaFacts();
    const eric = f.returnAnswers.people.find((p) => p.userId === ERIC_ID)!;
    eric.tipsChoice = owner("some");
    eric.tipsCents = owner(100_000);
    eric.validSsn = owner(true);
    const r = computeTy2025Return(f);
    expect(st(r, "sch1a.5")).toBe("needs_cpa_judgment");
    expect(st(r, "sch1a.38")).toBe("needs_cpa_judgment");
    expect(r.openItems.some((o) => o.id === "rule:schedule-1a" && o.severity === "blocking")).toBe(true);
  });

  it("a stated Schedule 1-A total replaces the rule: no sch1a.* line is computed (they stay not_yet_computed)", () => {
    const f = evaFacts();
    f.adjustments.sch1a = owner(700_000);
    const r = computeTy2025Return(f);
    expect(amt(r, "f1040.13b")).toBe(7000);
    expect(st(r, "sch1a.13")).toBe("not_yet_computed");
  });
});
